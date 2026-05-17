use async_trait::async_trait;

use crate::error::ServiceResult;
use crate::types::{AuditRecord, InternalEvent, PolicyVerdict, SessionId};

/// Minimal request payload for policy decisions.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerdictRequest {
    pub description: String,
}

/// Opaque session data persisted between events.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionState {
    pub data: String,
}

/// Channel-agnostic stream of internal events.
#[async_trait]
pub trait Receiver {
    async fn recv(&mut self) -> ServiceResult<Option<InternalEvent>>;
}

#[async_trait]
pub trait RequestsHandler: Send + Sync {
    async fn submit(&self, event: InternalEvent) -> ServiceResult<()>;
}

#[async_trait]
pub trait PolicyEngine: Send + Sync {
    async fn verdict(&self, req: VerdictRequest) -> ServiceResult<PolicyVerdict>;
}

#[async_trait]
pub trait AuditSink: Send + Sync {
    async fn append(&self, record: AuditRecord) -> ServiceResult<()>;
}

#[async_trait]
pub trait EventBus: Send + Sync {
    async fn publish(&self, event: InternalEvent) -> ServiceResult<()>;
    async fn subscribe(&self, filter: Option<String>) -> ServiceResult<Box<dyn Receiver + Send>>;
}

#[async_trait]
pub trait SessionPool: Send + Sync {
    async fn list(&self) -> ServiceResult<Vec<SessionId>>;
    async fn kill(&self, id: SessionId) -> ServiceResult<()>;
}

#[async_trait]
pub trait PersistenceStore: Send + Sync {
    async fn enqueue(&self, event: InternalEvent) -> ServiceResult<()>;
    async fn dequeue_next(&self) -> ServiceResult<Option<InternalEvent>>;
    async fn put_session_state(&self, id: SessionId, state: SessionState) -> ServiceResult<()>;
    async fn get_session_state(&self, id: SessionId) -> ServiceResult<Option<SessionState>>;
}

#[cfg(test)]
mod tests {
    use async_trait::async_trait;
    use futures::executor::block_on;

    use crate::error::ServiceResult;
    use crate::types::{AuditKind, AuditRecord, InternalEvent, PolicyVerdict, SessionId};

    use super::{
        AuditSink, EventBus, PersistenceStore, PolicyEngine, Receiver, RequestsHandler,
        SessionPool, SessionState, VerdictRequest,
    };

    struct StubRequestsHandler;

    #[async_trait]
    impl RequestsHandler for StubRequestsHandler {
        async fn submit(&self, _event: InternalEvent) -> ServiceResult<()> {
            Ok(())
        }
    }

    struct StubPolicyEngine;

    #[async_trait]
    impl PolicyEngine for StubPolicyEngine {
        async fn verdict(&self, _req: VerdictRequest) -> ServiceResult<PolicyVerdict> {
            Ok(PolicyVerdict {
                allow: true,
                reason: None,
            })
        }
    }

    struct StubAuditSink;

    #[async_trait]
    impl AuditSink for StubAuditSink {
        async fn append(&self, _record: AuditRecord) -> ServiceResult<()> {
            Ok(())
        }
    }

    struct StubReceiver;

    #[async_trait]
    impl Receiver for StubReceiver {
        async fn recv(&mut self) -> ServiceResult<Option<InternalEvent>> {
            Ok(None)
        }
    }

    struct StubEventBus;

    #[async_trait]
    impl EventBus for StubEventBus {
        async fn publish(&self, _event: InternalEvent) -> ServiceResult<()> {
            Ok(())
        }

        async fn subscribe(
            &self,
            _filter: Option<String>,
        ) -> ServiceResult<Box<dyn Receiver + Send>> {
            Ok(Box::new(StubReceiver))
        }
    }

    struct StubSessionPool;

    #[async_trait]
    impl SessionPool for StubSessionPool {
        async fn list(&self) -> ServiceResult<Vec<SessionId>> {
            Ok(vec![])
        }

        async fn kill(&self, _id: SessionId) -> ServiceResult<()> {
            Ok(())
        }
    }

    struct StubPersistenceStore;

    #[async_trait]
    impl PersistenceStore for StubPersistenceStore {
        async fn enqueue(&self, _event: InternalEvent) -> ServiceResult<()> {
            Ok(())
        }

        async fn dequeue_next(&self) -> ServiceResult<Option<InternalEvent>> {
            Ok(None)
        }

        async fn put_session_state(
            &self,
            _id: SessionId,
            _state: SessionState,
        ) -> ServiceResult<()> {
            Ok(())
        }

        async fn get_session_state(&self, _id: SessionId) -> ServiceResult<Option<SessionState>> {
            Ok(None)
        }
    }

    #[test]
    fn requests_handler_submit_returns_service_result() {
        let handler = StubRequestsHandler;
        let event = InternalEvent::ChatMessage {
            content: "hello".to_owned(),
        };
        let result: ServiceResult<()> = block_on(handler.submit(event));
        assert!(result.is_ok());
    }

    #[test]
    fn policy_engine_verdict_returns_service_result() {
        let engine = StubPolicyEngine;
        let req = VerdictRequest {
            description: "check permission".to_owned(),
        };
        let result: ServiceResult<PolicyVerdict> = block_on(engine.verdict(req));
        assert!(result.is_ok());
        let verdict = result.expect("stub verdict must be ok");
        assert!(verdict.allow);
    }

    #[test]
    fn audit_sink_append_returns_service_result() {
        let sink = StubAuditSink;
        let record = AuditRecord {
            timestamp: "2026-05-17T00:00:00Z".to_owned(),
            kind: AuditKind::RequestReceived,
            description: "event".to_owned(),
        };
        let result: ServiceResult<()> = block_on(sink.append(record));
        assert!(result.is_ok());
    }

    #[test]
    fn event_bus_publish_returns_service_result() {
        let bus = StubEventBus;
        let event = InternalEvent::ChatMessage {
            content: "msg".to_owned(),
        };
        let result: ServiceResult<()> = block_on(bus.publish(event));
        assert!(result.is_ok());
    }

    #[test]
    fn event_bus_subscribe_returns_service_result_with_receiver() {
        let bus = StubEventBus;
        let result: ServiceResult<Box<dyn Receiver + Send>> = block_on(bus.subscribe(None));
        assert!(result.is_ok());
    }

    #[test]
    fn event_bus_subscribe_receiver_recv_returns_none_when_empty() {
        let bus = StubEventBus;
        let mut receiver = block_on(bus.subscribe(None)).expect("stub subscribe must be ok");
        let next: ServiceResult<Option<InternalEvent>> = block_on(receiver.recv());
        assert!(next.is_ok());
        assert!(next.expect("stub recv must be ok").is_none());
    }

    #[test]
    fn session_pool_list_returns_empty_service_result_vec() {
        let pool = StubSessionPool;
        let result: ServiceResult<Vec<SessionId>> = block_on(pool.list());
        assert!(result.is_ok());
        assert!(result.expect("stub list must be ok").is_empty());
    }

    #[test]
    fn session_pool_kill_returns_service_result() {
        let pool = StubSessionPool;
        let id = SessionId::new();
        let result: ServiceResult<()> = block_on(pool.kill(id));
        assert!(result.is_ok());
    }

    #[test]
    fn persistence_store_enqueue_returns_service_result() {
        let store = StubPersistenceStore;
        let event = InternalEvent::Scheduled {
            cron: "0 * * * *".to_owned(),
        };
        let result: ServiceResult<()> = block_on(store.enqueue(event));
        assert!(result.is_ok());
    }

    #[test]
    fn persistence_store_dequeue_next_returns_service_result_option() {
        let store = StubPersistenceStore;
        let result: ServiceResult<Option<InternalEvent>> = block_on(store.dequeue_next());
        assert!(result.is_ok());
        assert!(result.expect("stub dequeue_next must be ok").is_none());
    }

    #[test]
    fn persistence_store_put_session_state_returns_service_result() {
        let store = StubPersistenceStore;
        let id = SessionId::new();
        let state = SessionState {
            data: "{}".to_owned(),
        };
        let result: ServiceResult<()> = block_on(store.put_session_state(id, state));
        assert!(result.is_ok());
    }

    #[test]
    fn persistence_store_get_session_state_returns_none_when_absent() {
        let store = StubPersistenceStore;
        let id = SessionId::new();
        let result: ServiceResult<Option<SessionState>> = block_on(store.get_session_state(id));
        assert!(result.is_ok());
        assert!(result.expect("stub get_session_state must be ok").is_none());
    }
}
