use std::{collections::HashMap, sync::Arc};

use async_trait::async_trait;
use bob_core::types::{
    AuditRecord, AuditRecordKind, AuditRecordPayload, ExtensionEventAuditPayload,
    PolicyVerdictAuditPayload, SessionId,
};
use tokio::sync::mpsc;

use crate::framing::{InboundFrame, OutboundFrame};
use policy_control::{PolicyEngine, SnapshotHandle};

#[derive(Debug, Clone)]
pub struct MonitoringEvent {
    pub session: SessionId,
    pub payload: serde_json::Value,
}

#[derive(Debug, Clone)]
pub struct MonitoringVerdict {
    pub session: SessionId,
    pub allow: bool,
    pub reason: Option<String>,
}

#[async_trait]
pub trait MonitoringHandle: Send + Sync {
    async fn record_event(&self, event: MonitoringEvent);
    async fn record_verdict(&self, verdict: MonitoringVerdict);
}

#[derive(Default)]
pub struct NoopMonitoringHandle;

#[async_trait]
impl MonitoringHandle for NoopMonitoringHandle {
    async fn record_event(&self, _event: MonitoringEvent) {}
    async fn record_verdict(&self, _verdict: MonitoringVerdict) {}
}

/// A `MonitoringHandle` that emits structured `tracing::info!` events for each
/// forwarded extension event.
///
/// For every `MonitoringEvent`, one `INFO` log line is emitted carrying the
/// `session` (displayed `SessionId`) and `event` (the string value of
/// `payload.event`).  The full JSON payload is additionally attached at
/// `DEBUG` level.
#[derive(Default)]
pub struct TracingMonitoringHandle;

#[async_trait]
impl MonitoringHandle for TracingMonitoringHandle {
    async fn record_event(&self, event: MonitoringEvent) {
        let session = event.session;
        let event_name = event
            .payload
            .get("event")
            .and_then(|v| v.as_str())
            .unwrap_or("<unknown>");
        tracing::info!(session = %session, event = event_name, "extension event received");
        tracing::debug!(session = %session, payload = ?event.payload, "extension event full payload");
    }

    async fn record_verdict(&self, verdict: MonitoringVerdict) {
        tracing::info!(
            session = %verdict.session,
            allow = verdict.allow,
            reason = ?verdict.reason,
            "extension authz verdict"
        );
    }
}

/// A `MonitoringHandle` backed by the real `monitoring::Handle`.
///
/// Forwards each event and verdict to the monitoring subsystem as a persistent
/// `AuditRecord`, and also emits a secondary tracing log for observability.
/// If monitoring rejects a record the failure is logged and control flow
/// continues unaffected.
pub struct MonitoringBackedHandle {
    handle: monitoring::Handle,
}

impl MonitoringBackedHandle {
    pub fn new(handle: monitoring::Handle) -> Self {
        Self { handle }
    }
}

#[async_trait]
impl MonitoringHandle for MonitoringBackedHandle {
    async fn record_event(&self, event: MonitoringEvent) {
        let session = event.session;
        let event_name = event
            .payload
            .get("event")
            .and_then(|v| v.as_str())
            .unwrap_or("<unknown>")
            .to_owned();

        tracing::info!(session = %session, event = %event_name, "extension event received");
        tracing::debug!(session = %session, payload = ?event.payload, "extension event full payload");

        let record = AuditRecord {
            id: format!("audit_ext_event_{}", chrono::Utc::now().timestamp_millis()),
            timestamp: chrono::Utc::now().to_rfc3339(),
            kind: AuditRecordKind::Event,
            session_id: Some(session),
            payload: AuditRecordPayload::Event(ExtensionEventAuditPayload {
                name: event_name,
                summary: None,
                resolved_cwd: None,
            }),
        };

        if let Err(err) = self.handle.append_record(record).await {
            tracing::warn!(
                error = %err,
                session = %session,
                "extension-ipc: monitoring rejected event audit record"
            );
        }
    }

    async fn record_verdict(&self, verdict: MonitoringVerdict) {
        let session = verdict.session;

        tracing::info!(
            session = %session,
            allow = verdict.allow,
            reason = ?verdict.reason,
            "extension authz verdict"
        );

        let record = AuditRecord {
            id: format!(
                "audit_ext_verdict_{}",
                chrono::Utc::now().timestamp_millis()
            ),
            timestamp: chrono::Utc::now().to_rfc3339(),
            kind: AuditRecordKind::Verdict,
            session_id: Some(session),
            payload: AuditRecordPayload::Verdict(PolicyVerdictAuditPayload {
                allow: verdict.allow,
                reason: verdict.reason,
            }),
        };

        if let Err(err) = self.handle.append_record(record).await {
            tracing::warn!(
                error = %err,
                session = %session,
                "extension-ipc: monitoring rejected verdict audit record"
            );
        }
    }
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
    snapshot: SnapshotHandle,
    default_route: mpsc::UnboundedSender<OutboundFrame>,
    session_routes: HashMap<SessionId, mpsc::UnboundedSender<OutboundFrame>>,
}

impl SessionMultiplexer {
    pub fn new(
        monitoring: Arc<dyn MonitoringHandle>,
        snapshot: SnapshotHandle,
        default_route: mpsc::UnboundedSender<OutboundFrame>,
    ) -> Self {
        Self {
            monitoring,
            snapshot,
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

    /// Replace the default route used for sessions that have no explicit registration.
    ///
    /// After this call, any subsequent lookup for an unknown session id returns a sender
    /// from the new default channel, not any previously observed default.
    pub fn set_default_route(&mut self, route: mpsc::UnboundedSender<OutboundFrame>) {
        self.default_route = route;
    }

    pub async fn handle_frame(&mut self, frame: InboundFrame) -> Result<(), MultiplexError> {
        match frame {
            InboundFrame::Authz {
                session,
                tool,
                arguments,
                ..
            } => {
                let snapshot = self.snapshot.load();
                let verdict = PolicyEngine::evaluate_action(&snapshot, &tool, &arguments);

                // Diagnostic-only: the audit record and deny-reason string only carry
                // the tool name, so surface the full call here for post-hoc S-004 rule
                // diagnosis (B-032). Never persisted — tracing output only.
                tracing::debug!(session = %session, tool = %tool, arguments = ?arguments, "extension authz call");

                // Record the verdict to monitoring before sending the wire reply.  A
                // monitoring failure is logged but never changes the policy outcome.
                self.monitoring
                    .record_verdict(MonitoringVerdict {
                        session,
                        allow: verdict.allow,
                        reason: verdict.reason.clone(),
                    })
                    .await;

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

    fn route_for_session(&self, session: SessionId) -> mpsc::UnboundedSender<OutboundFrame> {
        // Do not cache the default under unknown session ids: always consult the live
        // default_route field so that a subsequent set_default_route call is reflected.
        self.session_routes
            .get(&session)
            .unwrap_or(&self.default_route)
            .clone()
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use bob_core::types::{PolicyVerdict, SessionId};
    use policy_control::{ActionRule, PolicyConfig, RulesetSnapshot, SnapshotHandle};

    use super::*;

    // ---- Helpers ----

    /// Returns a deny-all `SnapshotHandle` (no admitted users, no action rules).
    fn deny_all_snapshot() -> SnapshotHandle {
        let snapshot = RulesetSnapshot::from_config(PolicyConfig {
            admitted_users: vec![],
            action_rules: vec![],
        })
        .expect("valid deny-all config");
        let (_, _, handle) = policy_control::start(policy_control::Config {
            initial_snapshot: snapshot,
            ..policy_control::Config::default()
        });
        handle
    }

    /// Returns a `SnapshotHandle` that permits `tool` unconditionally.
    fn allow_tool_snapshot(tool: &str) -> SnapshotHandle {
        let snapshot = RulesetSnapshot::from_config(PolicyConfig {
            admitted_users: vec![],
            action_rules: vec![ActionRule {
                tool: tool.to_owned(),
                arg_matchers: vec![],
            }],
        })
        .expect("valid allow config");
        let (_, _, handle) = policy_control::start(policy_control::Config {
            initial_snapshot: snapshot,
            ..policy_control::Config::default()
        });
        handle
    }

    // ---- TracingMonitoringHandle tests (AC-1, AC-2) ----

    /// Captures tracing events emitted while the guard is alive.
    struct TracingCapture {
        lines: Arc<Mutex<Vec<String>>>,
        _guard: tracing::subscriber::DefaultGuard,
    }

    impl TracingCapture {
        fn new() -> Self {
            let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
            let lines_clone = Arc::clone(&lines);

            // Build a writer that appends each formatted line to the shared vec.
            let make_writer = move || {
                let l = Arc::clone(&lines_clone);
                LineWriter { lines: l }
            };

            let subscriber = tracing_subscriber::fmt()
                .with_max_level(tracing::Level::TRACE)
                .with_ansi(false)
                .with_writer(make_writer)
                .finish();

            let guard = tracing::subscriber::set_default(subscriber);
            Self {
                lines,
                _guard: guard,
            }
        }

        fn captured(&self) -> Vec<String> {
            self.lines.lock().expect("lines lock").clone()
        }
    }

    struct LineWriter {
        lines: Arc<Mutex<Vec<String>>>,
    }

    impl std::io::Write for LineWriter {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            let s = String::from_utf8_lossy(buf).into_owned();
            self.lines.lock().expect("lines lock").push(s);
            Ok(buf.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn tracing_monitoring_handle_record_event_emits_one_info_event_with_session_and_event_fields(
    ) {
        let capture = TracingCapture::new();
        let handle = TracingMonitoringHandle;
        let session = SessionId::new();
        let payload = serde_json::json!({ "event": "session.started" });

        handle
            .record_event(MonitoringEvent { session, payload })
            .await;

        let lines = capture.captured();
        let session_str = session.to_string();
        let info_lines: Vec<&String> = lines.iter().filter(|l| l.contains(" INFO ")).collect();
        assert_eq!(
            info_lines.len(),
            1,
            "exactly one INFO event expected; captured: {lines:?}"
        );
        let info_line = info_lines[0];
        assert!(
            info_line.contains(&session_str),
            "INFO event must carry session field; line: {info_line}"
        );
        assert!(
            info_line.contains("session.started"),
            "INFO event must carry event field value; line: {info_line}"
        );
    }

    /// B-032: a denied `Authz` frame must leave the denied tool call's
    /// arguments recoverable from `DEBUG`-level tracing, since the audit
    /// record and the fixed deny-reason string only carry the tool name.
    #[tokio::test(flavor = "current_thread")]
    async fn authz_frame_debug_tracing_captures_session_tool_and_arguments_for_denied_call() {
        let capture = TracingCapture::new();
        let (tx, mut rx) = mpsc::unbounded_channel();
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(TracingMonitoringHandle);
        let mut mux = SessionMultiplexer::new(monitoring, deny_all_snapshot(), tx);
        let session = SessionId::new();
        let command = "rm -rf /some/denied/path";

        mux.handle_frame(InboundFrame::Authz {
            session,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"command": command}),
        })
        .await
        .expect("frame should process");

        // Sanity check: the call was actually denied.
        let sent = rx.recv().await.expect("reply frame");
        match sent {
            OutboundFrame::AuthzVerdict { verdict, .. } => {
                assert!(!verdict.allow, "deny-all snapshot must deny the call");
            }
        }

        let lines = capture.captured();
        let session_str = session.to_string();
        let debug_lines: Vec<&String> = lines.iter().filter(|l| l.contains(" DEBUG ")).collect();
        assert!(
            !debug_lines.is_empty(),
            "expected at least one DEBUG line for the denied authz call; captured: {lines:?}"
        );
        let matching_line = debug_lines
            .iter()
            .find(|l| l.contains(&session_str) && l.contains("bash") && l.contains(command));
        assert!(
            matching_line.is_some(),
            "expected a DEBUG line carrying session, tool, and the denied command; captured: {lines:?}"
        );
    }

    #[derive(Default)]
    struct CapturingMonitoringHandle {
        events: Mutex<Vec<MonitoringEvent>>,
        verdicts: Mutex<Vec<MonitoringVerdict>>,
    }

    #[async_trait]
    impl MonitoringHandle for CapturingMonitoringHandle {
        async fn record_event(&self, event: MonitoringEvent) {
            self.events.lock().expect("events mutex").push(event);
        }

        async fn record_verdict(&self, verdict: MonitoringVerdict) {
            self.verdicts.lock().expect("verdicts mutex").push(verdict);
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn authz_frame_returns_deny_when_no_rule_permits_the_tool() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(CapturingMonitoringHandle::default());
        let mut mux = SessionMultiplexer::new(monitoring, deny_all_snapshot(), tx);
        let session = SessionId::new();

        mux.handle_frame(InboundFrame::Authz {
            session,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"cmd": "ls"}),
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
    async fn authz_frame_returns_allow_when_snapshot_has_matching_rule() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(CapturingMonitoringHandle::default());
        let mut mux = SessionMultiplexer::new(monitoring, allow_tool_snapshot("bash"), tx);
        let session = SessionId::new();

        mux.handle_frame(InboundFrame::Authz {
            session,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"cmd": "ls"}),
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
                assert!(
                    verdict.allow,
                    "snapshot permits bash; verdict must be allow, got: {verdict:?}"
                );
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn authz_verdict_reason_is_absent_when_snapshot_returns_not_the_hardcoded_string() {
        // AC-3: the deny reason must NOT be the old hardcoded "policy not implemented" string.
        let (tx, mut rx) = mpsc::unbounded_channel();
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(CapturingMonitoringHandle::default());
        let mut mux = SessionMultiplexer::new(monitoring, deny_all_snapshot(), tx);
        let session = SessionId::new();

        mux.handle_frame(InboundFrame::Authz {
            session,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"cmd": "ls"}),
        })
        .await
        .expect("frame should process");

        let sent = rx.recv().await.expect("reply frame");
        match sent {
            OutboundFrame::AuthzVerdict { verdict, .. } => {
                assert!(!verdict.allow);
                let reason = verdict.reason.as_deref().unwrap_or("");
                assert_ne!(
                    reason, "policy not implemented",
                    "hardcoded deny string must not appear; reason: {reason}"
                );
            }
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn event_frame_forwards_to_monitoring_without_wire_reply() {
        let (tx, mut rx) = mpsc::unbounded_channel();
        let monitor = Arc::new(CapturingMonitoringHandle::default());
        let monitoring: Arc<dyn MonitoringHandle> = monitor.clone();
        let mut mux = SessionMultiplexer::new(monitoring, deny_all_snapshot(), tx);
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
        let mut mux = SessionMultiplexer::new(monitoring, deny_all_snapshot(), default_tx);

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
        })
        .await
        .expect("session a frame");
        mux.handle_frame(InboundFrame::Authz {
            session: session_b,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"cmd": "echo b"}),
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

        assert!(
            rx_a.try_recv().is_err(),
            "session a should not receive b reply"
        );
        assert!(
            rx_b.try_recv().is_err(),
            "session b should not receive a reply"
        );
    }

    // ---- MonitoringBackedHandle tests (AC-1, AC-2) ----

    /// AC-1: When an Event frame is handled, an `AuditRecord` of kind `Event` is
    /// submitted to the real Monitoring subsystem with the correct session id.
    #[tokio::test(flavor = "current_thread")]
    async fn event_frame_submits_event_audit_record_to_monitoring_with_session_id() {
        use bob_core::types::{AuditFilterKind, AuditRecordKind};
        use std::str::FromStr;
        use std::time::Duration;
        use tokio::time::timeout;

        let temp = tempfile::tempdir().expect("tempdir must be created");
        let log_path = temp.path().join("audit.jsonl");
        let (monitoring_handle, _monitoring_task) = monitoring::start(monitoring::Config {
            command_buffer: 4,
            audit_log_path: log_path.clone(),
        });

        let mut subscription = monitoring_handle
            .subscribe_tail(vec![
                AuditFilterKind::from_str("events").expect("events parses")
            ])
            .await
            .expect("subscribe must succeed");

        let (tx, _rx) = mpsc::unbounded_channel();
        let backed = Arc::new(MonitoringBackedHandle::new(monitoring_handle));
        let monitoring: Arc<dyn MonitoringHandle> = backed;
        let mut mux = SessionMultiplexer::new(monitoring, deny_all_snapshot(), tx);
        let session = SessionId::new();

        mux.handle_frame(InboundFrame::Event {
            session,
            payload: serde_json::json!({"event": "session.started"}),
        })
        .await
        .expect("event frame must process");

        let record = timeout(Duration::from_millis(500), subscription.recv())
            .await
            .expect("audit record must arrive within deadline")
            .expect("subscription must stay open");

        assert_eq!(record.kind, AuditRecordKind::Event);
        assert_eq!(record.session_id, Some(session));
    }

    /// AC-2: When an Authz frame is handled, an `AuditRecord` of kind `Verdict` is
    /// submitted to Monitoring with the correct session id, without changing the
    /// policy verdict outcome.
    #[tokio::test(flavor = "current_thread")]
    async fn authz_frame_submits_verdict_audit_record_to_monitoring_with_session_id() {
        use bob_core::types::{AuditFilterKind, AuditRecordKind, AuditRecordPayload};
        use std::str::FromStr;
        use std::time::Duration;
        use tokio::time::timeout;

        let temp = tempfile::tempdir().expect("tempdir must be created");
        let log_path = temp.path().join("audit.jsonl");
        let (monitoring_handle, _monitoring_task) = monitoring::start(monitoring::Config {
            command_buffer: 4,
            audit_log_path: log_path.clone(),
        });

        let mut subscription = monitoring_handle
            .subscribe_tail(vec![
                AuditFilterKind::from_str("verdicts").expect("verdicts parses")
            ])
            .await
            .expect("subscribe must succeed");

        let (tx, mut rx) = mpsc::unbounded_channel();
        let backed = Arc::new(MonitoringBackedHandle::new(monitoring_handle));
        let monitoring: Arc<dyn MonitoringHandle> = backed;
        let mut mux = SessionMultiplexer::new(monitoring, deny_all_snapshot(), tx);
        let session = SessionId::new();

        mux.handle_frame(InboundFrame::Authz {
            session,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"cmd": "ls"}),
        })
        .await
        .expect("authz frame must process");

        // Policy outcome must still be a deny verdict on the wire.
        let wire_reply = rx.recv().await.expect("wire reply must arrive");
        match wire_reply {
            OutboundFrame::AuthzVerdict {
                session: got,
                verdict,
            } => {
                assert_eq!(got, session);
                assert!(
                    !verdict.allow,
                    "deny-all snapshot must produce deny verdict"
                );
            }
        }

        // Monitoring must have received a Verdict record.
        let record = timeout(Duration::from_millis(500), subscription.recv())
            .await
            .expect("verdict audit record must arrive within deadline")
            .expect("subscription must stay open");

        assert_eq!(record.kind, AuditRecordKind::Verdict);
        assert_eq!(record.session_id, Some(session));
        // The audit payload must match the policy verdict.
        match record.payload {
            AuditRecordPayload::Verdict(ref p) => {
                assert!(!p.allow, "audit verdict allow must match policy verdict");
            }
            ref other => panic!("expected Verdict payload, got {other:?}"),
        }
    }

    /// AC-3: When Monitoring rejects an event audit record, the frame processing
    /// succeeds and control flow is preserved.
    #[tokio::test(flavor = "current_thread")]
    async fn event_frame_monitoring_rejection_logs_failure_and_preserves_control_flow() {
        // Start monitoring with an invalid path (directory as log path) so append fails.
        let temp = tempfile::tempdir().expect("tempdir must be created");
        let (monitoring_handle, _monitoring_task) = monitoring::start(monitoring::Config {
            command_buffer: 4,
            audit_log_path: temp.path().to_path_buf(), // directory — open fails
        });

        let (tx, _rx) = mpsc::unbounded_channel();
        let backed = Arc::new(MonitoringBackedHandle::new(monitoring_handle));
        let monitoring: Arc<dyn MonitoringHandle> = backed;
        let mut mux = SessionMultiplexer::new(monitoring, deny_all_snapshot(), tx);
        let session = SessionId::new();

        // Control flow must succeed even when monitoring rejects the record.
        let result = mux
            .handle_frame(InboundFrame::Event {
                session,
                payload: serde_json::json!({"event": "session.started"}),
            })
            .await;

        assert!(
            result.is_ok(),
            "monitoring rejection must not propagate as error; got: {result:?}"
        );
    }

    /// Regression test for B-004: an unknown session id must always reflect the live
    /// default route and must not be permanently cached from the first lookup.
    ///
    /// Steps:
    ///   1. Build a multiplexer with default route A.
    ///   2. Send an authz frame for an unknown session → reply arrives on A's receiver.
    ///   3. Replace the default route with route B via `set_default_route`.
    ///   4. Send the same authz frame again for the same unknown session.
    ///   5. Assert the reply arrives on B's receiver, not A's (the stale cached default).
    #[tokio::test(flavor = "current_thread")]
    async fn route_for_session_reflects_new_default_for_unknown_session_after_default_replaced() {
        let (tx_a, mut rx_a) = mpsc::unbounded_channel::<OutboundFrame>();
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(CapturingMonitoringHandle::default());
        let mut mux = SessionMultiplexer::new(monitoring, deny_all_snapshot(), tx_a);

        // Unknown session — no explicit registration.
        let unknown_session = SessionId::new();

        // First authz: should go to default route A.
        mux.handle_frame(InboundFrame::Authz {
            session: unknown_session,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"cmd": "id"}),
        })
        .await
        .expect("first frame should process");

        let first_reply = rx_a
            .recv()
            .await
            .expect("first reply must arrive on route A");
        match &first_reply {
            OutboundFrame::AuthzVerdict { session, .. } => {
                assert_eq!(*session, unknown_session, "first reply session must match");
            }
        }

        // Replace the default route with a fresh channel B.
        let (tx_b, mut rx_b) = mpsc::unbounded_channel::<OutboundFrame>();
        mux.set_default_route(tx_b);

        // Second authz for the same unknown session id: must go to new default B.
        mux.handle_frame(InboundFrame::Authz {
            session: unknown_session,
            tool: "bash".to_owned(),
            arguments: serde_json::json!({"cmd": "id"}),
        })
        .await
        .expect("second frame should process");

        assert!(
            rx_a.try_recv().is_err(),
            "second reply must NOT arrive on old default route A (stale cache)"
        );
        let second_reply = rx_b
            .recv()
            .await
            .expect("second reply must arrive on new default route B");
        match second_reply {
            OutboundFrame::AuthzVerdict { session, .. } => {
                assert_eq!(session, unknown_session, "second reply session must match");
            }
        }
    }
}
