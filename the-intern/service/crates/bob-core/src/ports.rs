use async_trait::async_trait;

use crate::error::ServiceResult;
use crate::types::{AuditRecord, InternalEvent, PolicyVerdict, RequestContext, SessionId};

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
    /// Submit an event together with the per-request context that identifies
    /// the sender and originating channel.
    ///
    /// Returns `Ok(())` when the event is accepted, `Err` when rejected
    /// (queue full / timeout, or shutdown).
    async fn submit(&self, event: InternalEvent, context: RequestContext) -> ServiceResult<()>;
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

    /// Appends `event` to the inbound queue together with an optional
    /// job-id correlator (ADR-013). The default implementation ignores the
    /// correlator and delegates to `enqueue`, so implementors that only
    /// provide the plain queue methods keep compiling unchanged.
    ///
    /// # Errors
    ///
    /// Returns the same errors as `enqueue`.
    async fn enqueue_with_job_id(
        &self,
        event: InternalEvent,
        job_id: Option<String>,
    ) -> ServiceResult<()> {
        let _ = job_id;
        self.enqueue(event).await
    }

    /// Removes and returns the oldest inbound event together with the
    /// job-id correlator it was enqueued with (ADR-013). The default
    /// implementation delegates to `dequeue_next` and always reports an
    /// absent correlator, since implementors that only provide the plain
    /// queue methods have nowhere to store one.
    ///
    /// # Errors
    ///
    /// Returns the same errors as `dequeue_next`.
    async fn dequeue_next_with_job_id(
        &self,
    ) -> ServiceResult<Option<(InternalEvent, Option<String>)>> {
        Ok(self.dequeue_next().await?.map(|event| (event, None)))
    }

    /// Appends a `Periodic`-kind `event` to a dedicated periodic queue,
    /// entirely separate from the general inbound queue (B-023), together
    /// with an optional job-id correlator (ADR-013). Keeping periodic
    /// admission on its own queue means the periodic dispatcher never has to
    /// dequeue (and potentially reorder) unrelated non-periodic traffic on
    /// the general queue, and non-periodic dispatch is never delayed by
    /// periodic backlog or vice versa.
    ///
    /// The default implementation delegates to `enqueue_with_job_id`, so
    /// implementors that only provide the general queue keep compiling
    /// unchanged; note that under the default, such an event is only
    /// observable via the general dequeue methods, not
    /// `dequeue_next_periodic_with_job_id`.
    ///
    /// # Errors
    ///
    /// Returns the same errors as `enqueue_with_job_id`.
    async fn enqueue_periodic_with_job_id(
        &self,
        event: InternalEvent,
        job_id: Option<String>,
    ) -> ServiceResult<()> {
        self.enqueue_with_job_id(event, job_id).await
    }

    /// Removes and returns the oldest event from the dedicated periodic
    /// queue (B-023) together with the job-id correlator it was enqueued
    /// with, or `None` when empty. The default implementation always
    /// reports an empty periodic queue, matching implementors that do not
    /// maintain one (their periodic events, enqueued via the default
    /// `enqueue_periodic_with_job_id` above, remain reachable only through
    /// the general dequeue methods).
    ///
    /// # Errors
    ///
    /// Returns the same errors as `dequeue_next_with_job_id`.
    async fn dequeue_next_periodic_with_job_id(
        &self,
    ) -> ServiceResult<Option<(InternalEvent, Option<String>)>> {
        Ok(None)
    }

    async fn put_session_state(&self, id: SessionId, state: SessionState) -> ServiceResult<()>;
    async fn get_session_state(&self, id: SessionId) -> ServiceResult<Option<SessionState>>;
}

#[cfg(test)]
mod tests {
    use std::sync::Mutex;

    use async_trait::async_trait;
    use futures::executor::block_on;

    use crate::error::ServiceResult;
    use crate::types::{
        AuditRecord, AuditRecordKind, AuditRecordPayload, ChannelId, DeliveryKind,
        ExternalReportAuditPayload, InternalEvent, PolicyVerdict, ReportOutcome, RequestContext,
        SessionId, UserId,
    };

    use super::{
        AuditSink, EventBus, PersistenceStore, PolicyEngine, Receiver, RequestsHandler,
        SessionPool, SessionState, VerdictRequest,
    };

    struct StubRequestsHandler;

    #[async_trait]
    impl RequestsHandler for StubRequestsHandler {
        async fn submit(
            &self,
            _event: InternalEvent,
            _context: RequestContext,
        ) -> ServiceResult<()> {
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
    fn requests_handler_submit_takes_event_and_context_and_returns_service_result() {
        let handler = StubRequestsHandler;
        let event = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "hello".to_owned(),
        };
        let ctx = RequestContext {
            sender: UserId::new(),
            source: ChannelId::new(),
            context_id: None,
            reply_address: None,
        };
        let result: ServiceResult<()> = block_on(handler.submit(event, ctx));
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
            id: "audit_stub_001".to_owned(),
            timestamp: "2026-05-17T00:00:00Z".to_owned(),
            kind: AuditRecordKind::Report,
            session_id: None,
            payload: AuditRecordPayload::Report(ExternalReportAuditPayload {
                action: "stub.action".to_owned(),
                outcome: ReportOutcome::Success,
                session_id: None,
                summary: Some("stub".to_owned()),
            }),
        };
        let result: ServiceResult<()> = block_on(sink.append(record));
        assert!(result.is_ok());
    }

    #[test]
    fn event_bus_publish_returns_service_result() {
        let bus = StubEventBus;
        let event = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "msg".to_owned(),
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
        let event = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "0 * * * *".to_owned(),
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

    /// A `PersistenceStore` implementor that only provides the plain
    /// `enqueue`/`dequeue_next` methods, exercising the default
    /// implementations of the correlator-carrying methods (ADR-013).
    #[derive(Default)]
    struct RecordingPersistenceStore {
        events: Mutex<Vec<InternalEvent>>,
    }

    #[async_trait]
    impl PersistenceStore for RecordingPersistenceStore {
        async fn enqueue(&self, event: InternalEvent) -> ServiceResult<()> {
            self.events.lock().unwrap().push(event);
            Ok(())
        }

        async fn dequeue_next(&self) -> ServiceResult<Option<InternalEvent>> {
            Ok(self.events.lock().unwrap().pop())
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

    // AC-3: an implementor that does not override the correlator-carrying
    // methods keeps compiling and `enqueue_with_job_id` delegates to the
    // plain `enqueue`, ignoring the correlator.
    #[test]
    fn persistence_store_enqueue_with_job_id_default_delegates_to_plain_enqueue() {
        let store = RecordingPersistenceStore::default();
        let event = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "* * * * *".to_owned(),
        };

        let result = block_on(store.enqueue_with_job_id(event.clone(), Some("job-1".to_owned())));

        assert!(result.is_ok());
        assert_eq!(store.events.lock().unwrap().as_slice(), [event]);
    }

    // AC-3: an implementor that does not override the correlator-carrying
    // methods yields an absent correlator on dequeue, regardless of what was
    // enqueued.
    #[test]
    fn persistence_store_dequeue_next_with_job_id_default_returns_absent_correlator() {
        let store = RecordingPersistenceStore::default();
        let event = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "* * * * *".to_owned(),
        };
        block_on(store.enqueue(event.clone())).unwrap();

        let result = block_on(store.dequeue_next_with_job_id());

        assert!(result.is_ok());
        assert_eq!(
            result.expect("default dequeue_next_with_job_id must be ok"),
            Some((event, None))
        );
    }

    // B-023: an implementor that does not override the periodic-queue
    // methods keeps compiling and `enqueue_periodic_with_job_id` delegates
    // to `enqueue_with_job_id` (the general queue), ignoring the
    // periodic/general distinction.
    #[test]
    fn persistence_store_enqueue_periodic_with_job_id_default_delegates_to_enqueue_with_job_id() {
        let store = RecordingPersistenceStore::default();
        let event = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "* * * * *".to_owned(),
        };

        let result =
            block_on(store.enqueue_periodic_with_job_id(event.clone(), Some("job-1".to_owned())));

        assert!(result.is_ok());
        assert_eq!(store.events.lock().unwrap().as_slice(), [event]);
    }

    // B-023: an implementor that does not maintain a dedicated periodic
    // queue reports it as always empty, regardless of what was enqueued via
    // the default `enqueue_periodic_with_job_id`.
    #[test]
    fn persistence_store_dequeue_next_periodic_with_job_id_default_returns_none() {
        let store = RecordingPersistenceStore::default();
        let event = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "* * * * *".to_owned(),
        };
        block_on(store.enqueue_periodic_with_job_id(event, Some("job-1".to_owned()))).unwrap();

        let result = block_on(store.dequeue_next_periodic_with_job_id());

        assert!(result.is_ok());
        assert_eq!(
            result.expect("default dequeue_next_periodic_with_job_id must be ok"),
            None
        );
    }
}
