use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use bob_core::types::SessionId;
use tokio::sync::mpsc;

use crate::framing::{InboundFrame, OutboundFrame};

#[derive(Debug, Clone)]
pub struct MonitoringEvent {
    pub session: SessionId,
    pub payload: serde_json::Value,
}

#[async_trait]
pub trait MonitoringHandle: Send + Sync {
    async fn record_event(&self, _event: MonitoringEvent);
}

#[derive(Default)]
pub struct NoopMonitoringHandle;

#[async_trait]
impl MonitoringHandle for NoopMonitoringHandle {
    async fn record_event(&self, _event: MonitoringEvent) {}
}

#[derive(Debug)]
pub enum MultiplexError {
    SessionRouteClosed { session: SessionId },
}

impl std::fmt::Display for MultiplexError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::SessionRouteClosed { session } => {
                write!(f, "session route is closed for {session}")
            }
        }
    }
}

impl std::error::Error for MultiplexError {}

pub struct SessionMultiplexer {
    monitoring: Arc<dyn MonitoringHandle>,
    default_route: mpsc::UnboundedSender<OutboundFrame>,
    session_routes: HashMap<SessionId, mpsc::UnboundedSender<OutboundFrame>>,
}

impl SessionMultiplexer {
    pub fn new(
        monitoring: Arc<dyn MonitoringHandle>,
        default_route: mpsc::UnboundedSender<OutboundFrame>,
    ) -> Self {
        Self {
            monitoring,
            default_route,
            session_routes: HashMap::new(),
        }
    }

    pub fn register_session(
        &mut self,
        session: SessionId,
        route: mpsc::UnboundedSender<OutboundFrame>,
    ) {
        self.session_routes.insert(session, route);
    }

    pub async fn handle_frame(&mut self, frame: InboundFrame) -> Result<(), MultiplexError> {
        match frame {
            InboundFrame::Authz { session, .. } => {
                let verdict = bob_core::types::PolicyVerdict {
                    allow: false,
                    reason: Some("policy not implemented".to_owned()),
                };
                let route = self.route_for_session(session);
                route
                    .send(OutboundFrame::AuthzVerdict { session, verdict })
                    .map_err(|_| MultiplexError::SessionRouteClosed { session })?;
            }
            InboundFrame::Event { session, payload } => {
                self.monitoring
                    .record_event(MonitoringEvent { session, payload })
                    .await;
            }
        }
        Ok(())
    }

    fn route_for_session(&mut self, session: SessionId) -> mpsc::UnboundedSender<OutboundFrame> {
        self.session_routes
            .entry(session)
            .or_insert_with(|| self.default_route.clone())
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use bob_core::types::{PolicyVerdict, SessionId};

    use super::*;

    #[derive(Default)]
    struct CapturingMonitoringHandle {
        events: Mutex<Vec<MonitoringEvent>>,
    }

    #[async_trait]
    impl MonitoringHandle for CapturingMonitoringHandle {
        async fn record_event(&self, event: MonitoringEvent) {
            self.events.lock().expect("events mutex").push(event);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn authz_frame_returns_deny_by_default_on_same_session_route() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(CapturingMonitoringHandle::default());
        let mut mux = SessionMultiplexer::new(monitoring, tx);
        let session = SessionId::new();

        mux.handle_frame(InboundFrame::Authz {
            session,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"cmd": "ls"}),
            user: "alice".to_owned(),
        })
        .await
        .expect("frame should process");

        let sent = rx.recv().await.expect("reply frame");
        match sent {
            OutboundFrame::AuthzVerdict {
                session: got,
                verdict,
            } => {
                assert_eq!(got, session);
                assert!(!verdict.allow);
                assert!(verdict.reason.is_some());
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn event_frame_forwards_to_monitoring_without_wire_reply() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let monitor = Arc::new(CapturingMonitoringHandle::default());
        let monitoring: Arc<dyn MonitoringHandle> = monitor.clone();
        let mut mux = SessionMultiplexer::new(monitoring, tx);
        let session = SessionId::new();

        mux.handle_frame(InboundFrame::Event {
            session,
            payload: serde_json::json!({"type": "session.started"}),
        })
        .await
        .expect("frame should process");

        assert!(rx.try_recv().is_err(), "event should not emit reply frame");

        let events = monitor.events.lock().expect("events lock");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session, session);
        assert_eq!(events[0].payload["type"], "session.started");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn distinct_sessions_do_not_cross_deliver_replies() {
        let (default_tx, _default_rx) = mpsc::unbounded_channel();
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(CapturingMonitoringHandle::default());
        let mut mux = SessionMultiplexer::new(monitoring, default_tx);

        let session_a = SessionId::new();
        let session_b = SessionId::new();

        let (tx_a, mut rx_a) = mpsc::unbounded_channel();
        let (tx_b, mut rx_b) = mpsc::unbounded_channel();
        mux.register_session(session_a, tx_a);
        mux.register_session(session_b, tx_b);

        mux.handle_frame(InboundFrame::Authz {
            session: session_a,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"cmd": "echo a"}),
            user: "alice".to_owned(),
        })
        .await
        .expect("session a frame");
        mux.handle_frame(InboundFrame::Authz {
            session: session_b,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"cmd": "echo b"}),
            user: "bob".to_owned(),
        })
        .await
        .expect("session b frame");

        let got_a = rx_a.recv().await.expect("session a reply");
        let got_b = rx_b.recv().await.expect("session b reply");

        let expect_denied = |frame: OutboundFrame, expected_session: SessionId| match frame {
            OutboundFrame::AuthzVerdict {
                session: got,
                verdict: PolicyVerdict { allow, reason },
            } => {
                assert_eq!(got, expected_session);
                assert!(!allow);
                assert!(reason.is_some());
            }
        };

        expect_denied(got_a, session_a);
        expect_denied(got_b, session_b);

        assert!(rx_a.try_recv().is_err(), "session a should not receive b reply");
        assert!(rx_b.try_recv().is_err(), "session b should not receive a reply");
    }
}
