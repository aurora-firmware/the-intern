#![forbid(unsafe_code)]

pub mod handler;
pub mod queue;

pub use handler::{run_preflight, PreflightConfig};
pub use queue::{start_with, Config, Handle};

use std::sync::Arc;

use bob_core::ports::{AuditSink, PersistenceStore};
use tokio::sync::watch;

/// Start the queue actor wired to the pre-flight handler.
///
/// This is the production entry point for the requests-handler subsystem.
/// For each event dequeued from the internal queue, `run_preflight` is called
/// with `context = None` (the correct placeholder until channel adapters supply
/// a real `RequestContext`; a missing context triggers AC-3 deny-all behaviour).
///
/// # Arguments
///
/// - `cfg` — queue capacity and submit timeout.
/// - `preflight_cfg` — list of allowed user IDs for the pre-flight check.
/// - `store` — persistence sink; called on allow.
/// - `audit` — audit sink; called on denial.
/// - `cancel_rx` — signals graceful shutdown to the actor.
///
/// # Returns
///
/// `(Handle, JoinHandle<()>)` — same shape as `start_with`.
pub fn start_with_preflight(
    cfg: Config,
    preflight_cfg: PreflightConfig,
    store: Arc<dyn PersistenceStore>,
    audit: Arc<dyn AuditSink>,
    cancel_rx: watch::Receiver<bool>,
) -> (Handle, tokio::task::JoinHandle<()>) {
    start_with(
        cfg,
        move |event| {
            let preflight_cfg = preflight_cfg.clone();
            let store = Arc::clone(&store);
            let audit = Arc::clone(&audit);
            async move {
                run_preflight(event, None, &preflight_cfg, store.as_ref(), audit.as_ref()).await;
            }
        },
        cancel_rx,
    )
}

#[cfg(test)]
mod handler_integration_tests {
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use async_trait::async_trait;
    use bob_core::{
        error::ServiceResult,
        ports::{AuditSink, PersistenceStore, SessionState},
        types::{AuditKind, AuditRecord, InternalEvent, SessionId, UserId},
    };
    use tokio::sync::watch;

    use super::{start_with_preflight, Config, PreflightConfig};

    // --- Test doubles (mirror those in handler.rs but in this module) ---

    #[derive(Default, Clone)]
    struct RecordingStore {
        enqueued: Arc<Mutex<Vec<InternalEvent>>>,
    }

    #[async_trait]
    impl PersistenceStore for RecordingStore {
        async fn enqueue(&self, event: InternalEvent) -> ServiceResult<()> {
            self.enqueued.lock().unwrap().push(event);
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

    #[derive(Default, Clone)]
    struct RecordingAudit {
        records: Arc<Mutex<Vec<AuditRecord>>>,
    }

    #[async_trait]
    impl AuditSink for RecordingAudit {
        async fn append(&self, record: AuditRecord) -> ServiceResult<()> {
            self.records.lock().unwrap().push(record);
            Ok(())
        }
    }

    fn chat_event(content: &str) -> InternalEvent {
        InternalEvent::ChatMessage {
            content: content.to_owned(),
        }
    }

    fn make_cancel_pair() -> (watch::Sender<bool>, watch::Receiver<bool>) {
        watch::channel(false)
    }

    // Integration test: allowed user submitted via start_with_preflight enqueues in persistence.
    //
    // Because the downstream closure always passes None as context (AC-3 deny-all placeholder),
    // an event submitted through the queue is denied regardless of the sender's user_id.
    // This test verifies that the wired path correctly denies (None context → deny) and emits
    // a PreflightDenied audit record.
    #[tokio::test(flavor = "current_thread")]
    async fn start_with_preflight_wired_path_denies_events_and_emits_audit_record_when_context_is_none(
    ) {
        let store_inner = Arc::new(RecordingStore::default());
        let audit_inner = Arc::new(RecordingAudit::default());
        let store: Arc<dyn PersistenceStore> = Arc::clone(&store_inner) as _;
        let audit: Arc<dyn AuditSink> = Arc::clone(&audit_inner) as _;
        let (cancel_tx, cancel_rx) = make_cancel_pair();

        let cfg = Config {
            request_queue_capacity: 16,
            request_submit_timeout: Duration::from_secs(5),
        };
        // Even with the user allowed in preflight_cfg, context=None → deny-all (AC-3).
        let user_id = UserId::new();
        let preflight_cfg = PreflightConfig {
            allowed_user_ids: vec![user_id],
        };

        let (handle, task) = start_with_preflight(cfg, preflight_cfg, store, audit, cancel_rx);

        handle
            .submit_event(chat_event("test message"))
            .await
            .expect("submit must succeed");

        // Cancel and drain so the actor processes the event before we inspect state.
        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("actor must stop within 2 s")
            .expect("actor task must not panic");

        // context=None → denial: nothing enqueued in persistence.
        assert!(
            store_inner.enqueued.lock().unwrap().is_empty(),
            "no-context event must not be enqueued in persistence store"
        );

        // context=None → PreflightDenied audit record emitted.
        let records = audit_inner.records.lock().unwrap();
        assert_eq!(records.len(), 1, "expected one audit record");
        assert!(
            matches!(records[0].kind, AuditKind::PreflightDenied),
            "audit record kind must be PreflightDenied, got {:?}",
            records[0].kind
        );
    }

    // Integration test: start_with_preflight with empty allowed_user_ids also denies.
    #[tokio::test(flavor = "current_thread")]
    async fn start_with_preflight_wired_path_deny_all_with_empty_allowed_ids() {
        let store_inner = Arc::new(RecordingStore::default());
        let audit_inner = Arc::new(RecordingAudit::default());
        let store: Arc<dyn PersistenceStore> = Arc::clone(&store_inner) as _;
        let audit: Arc<dyn AuditSink> = Arc::clone(&audit_inner) as _;
        let (cancel_tx, cancel_rx) = make_cancel_pair();

        let cfg = Config::default();
        let preflight_cfg = PreflightConfig {
            allowed_user_ids: vec![],
        };

        let (handle, task) = start_with_preflight(cfg, preflight_cfg, store, audit, cancel_rx);

        handle
            .submit_event(chat_event("another message"))
            .await
            .expect("submit must succeed");

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("actor must stop within 2 s")
            .expect("actor task must not panic");

        assert!(
            store_inner.enqueued.lock().unwrap().is_empty(),
            "event must not be enqueued when allowed list is empty"
        );

        let records = audit_inner.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert!(matches!(records[0].kind, AuditKind::PreflightDenied));
    }

    // Integration test: multiple events through start_with_preflight all denied (context=None).
    #[tokio::test(flavor = "current_thread")]
    async fn start_with_preflight_multiple_events_all_denied_with_context_none() {
        let store_inner = Arc::new(RecordingStore::default());
        let audit_inner = Arc::new(RecordingAudit::default());
        let store: Arc<dyn PersistenceStore> = Arc::clone(&store_inner) as _;
        let audit: Arc<dyn AuditSink> = Arc::clone(&audit_inner) as _;
        let (cancel_tx, cancel_rx) = make_cancel_pair();

        let cfg = Config {
            request_queue_capacity: 16,
            request_submit_timeout: Duration::from_secs(5),
        };
        let preflight_cfg = PreflightConfig {
            allowed_user_ids: vec![UserId::new()],
        };

        let (handle, task) = start_with_preflight(cfg, preflight_cfg, store, audit, cancel_rx);

        handle.submit_event(chat_event("msg1")).await.unwrap();
        handle.submit_event(chat_event("msg2")).await.unwrap();
        handle.submit_event(chat_event("msg3")).await.unwrap();

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), task)
            .await
            .expect("actor must stop")
            .expect("actor must not panic");

        assert!(
            store_inner.enqueued.lock().unwrap().is_empty(),
            "no events must reach persistence store"
        );

        let records = audit_inner.records.lock().unwrap();
        assert_eq!(
            records.len(),
            3,
            "three audit records expected, one per denied event"
        );
        for record in records.iter() {
            assert!(
                matches!(record.kind, AuditKind::PreflightDenied),
                "each audit record kind must be PreflightDenied"
            );
        }
    }
}
