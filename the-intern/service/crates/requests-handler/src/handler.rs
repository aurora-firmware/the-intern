#![forbid(unsafe_code)]

use bob_core::{
    ports::{AuditSink, PersistenceStore},
    types::{AuditKind, AuditRecord, InternalEvent, RequestContext, UserId},
};

/// Configuration for the pre-flight identity and access check.
#[derive(Debug, Clone)]
pub struct PreflightConfig {
    /// User identifiers that are permitted to submit requests.
    ///
    /// An empty list means all requests are denied.
    pub allowed_user_ids: Vec<UserId>,
}

/// Run the pre-flight identity and access check for one dequeued event.
///
/// # Behaviour
///
/// - If `context` is `Some` and its `sender` is in `cfg.allowed_user_ids`, the
///   event is forwarded to `store` via `PersistenceStore::enqueue`.
/// - In all other cases (absent context, or sender not in the allowed list), the
///   event is silently dropped, a `tracing::warn!` is emitted **without** the
///   raw event payload, and a `PreflightDenied` `AuditRecord` is appended to
///   `audit`.
///
/// Errors from `store.enqueue` or `audit.append` are logged but do not panic.
pub async fn run_preflight(
    event: InternalEvent,
    context: Option<&RequestContext>,
    cfg: &PreflightConfig,
    store: &dyn PersistenceStore,
    audit: &dyn AuditSink,
) {
    let allowed = context
        .map(|ctx| cfg.allowed_user_ids.contains(&ctx.sender))
        .unwrap_or(false);

    if allowed {
        if let Err(err) = store.enqueue(event).await {
            tracing::warn!(error = %err, "preflight: persistence enqueue failed");
        }
    } else {
        let reason = if context.is_none() {
            "missing request context"
        } else {
            "user id not in allowed list"
        };

        // AC-4: warn without the raw event payload — only safe metadata.
        tracing::warn!(reason, "preflight: event denied");

        let timestamp = chrono::Utc::now().to_rfc3339();
        let record = AuditRecord {
            timestamp,
            kind: AuditKind::PreflightDenied,
            description: format!("preflight denied: {reason}"),
        };

        if let Err(err) = audit.append(record).await {
            tracing::warn!(error = %err, "preflight: audit append failed after denial");
        }
    }
}

#[cfg(test)]
mod tests {
    use std::sync::{Arc, Mutex};

    use async_trait::async_trait;
    use bob_core::{
        error::ServiceResult,
        ports::{AuditSink, PersistenceStore, SessionState},
        types::{
            AuditKind, AuditRecord, ChannelId, InternalEvent, RequestContext, SessionId, UserId,
        },
    };

    use super::{run_preflight, PreflightConfig};

    // --- Test doubles ---

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

    fn make_context(user_id: UserId) -> RequestContext {
        RequestContext {
            sender: user_id,
            source: ChannelId::new(),
            context_id: None,
        }
    }

    fn chat_event(content: &str) -> InternalEvent {
        InternalEvent::ChatMessage {
            content: content.to_owned(),
        }
    }

    // AC-1: event with user_id in allowed list is forwarded to PersistenceStore::enqueue
    #[tokio::test]
    async fn allowed_user_id_causes_event_to_be_enqueued_in_persistence_store() {
        let user_id = UserId::new();
        let cfg = PreflightConfig {
            allowed_user_ids: vec![user_id],
        };
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let event = chat_event("hello");
        let ctx = make_context(user_id);

        run_preflight(event.clone(), Some(&ctx), &cfg, &store, &audit).await;

        let enqueued = store.enqueued.lock().unwrap();
        assert_eq!(enqueued.len(), 1, "expected exactly one event enqueued");
        assert_eq!(enqueued[0], event);

        let audit_records = audit.records.lock().unwrap();
        assert!(
            audit_records.is_empty(),
            "no audit record should be written on allow"
        );
    }

    // AC-1: multiple allowed user ids — the matching one passes
    #[tokio::test]
    async fn event_is_enqueued_when_user_id_matches_one_of_multiple_allowed_ids() {
        let user_a = UserId::new();
        let user_b = UserId::new();
        let cfg = PreflightConfig {
            allowed_user_ids: vec![user_a, user_b],
        };
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let event = chat_event("msg");
        let ctx = make_context(user_b);

        run_preflight(event.clone(), Some(&ctx), &cfg, &store, &audit).await;

        let enqueued = store.enqueued.lock().unwrap();
        assert_eq!(enqueued.len(), 1);
        assert!(audit.records.lock().unwrap().is_empty());
    }

    // AC-2: user_id NOT in allowed list → drop, warn, PreflightDenied audit record
    #[tokio::test]
    async fn user_id_not_in_allowed_list_drops_event_and_emits_preflight_denied_audit_record() {
        let allowed = UserId::new();
        let denied_user = UserId::new();
        let cfg = PreflightConfig {
            allowed_user_ids: vec![allowed],
        };
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let event = chat_event("secret payload");
        let ctx = make_context(denied_user);

        run_preflight(event, Some(&ctx), &cfg, &store, &audit).await;

        let enqueued = store.enqueued.lock().unwrap();
        assert!(enqueued.is_empty(), "event must not be enqueued on denial");

        let records = audit.records.lock().unwrap();
        assert_eq!(records.len(), 1, "exactly one audit record expected");
        assert!(
            matches!(records[0].kind, AuditKind::PreflightDenied),
            "audit record kind must be PreflightDenied, got {:?}",
            records[0].kind
        );
    }

    // AC-2: empty allowed list → every event is denied
    #[tokio::test]
    async fn empty_allowed_list_denies_all_events() {
        let cfg = PreflightConfig {
            allowed_user_ids: vec![],
        };
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let ctx = make_context(UserId::new());

        run_preflight(chat_event("anything"), Some(&ctx), &cfg, &store, &audit).await;

        assert!(store.enqueued.lock().unwrap().is_empty());
        let records = audit.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert!(matches!(records[0].kind, AuditKind::PreflightDenied));
    }

    // AC-3: absent RequestContext is treated as denied with PreflightDenied audit record
    #[tokio::test]
    async fn missing_request_context_is_treated_as_denied_with_preflight_denied_audit_record() {
        let cfg = PreflightConfig {
            allowed_user_ids: vec![UserId::new()],
        };
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();

        run_preflight(chat_event("no context"), None, &cfg, &store, &audit).await;

        assert!(
            store.enqueued.lock().unwrap().is_empty(),
            "event without context must not be enqueued"
        );
        let records = audit.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert!(
            matches!(records[0].kind, AuditKind::PreflightDenied),
            "audit record kind must be PreflightDenied, got {:?}",
            records[0].kind
        );
    }

    // AC-4: the audit record description does not contain the raw event payload
    #[tokio::test]
    async fn audit_record_description_does_not_contain_raw_event_payload() {
        let cfg = PreflightConfig {
            allowed_user_ids: vec![],
        };
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let secret = "super-secret-payload-12345";
        let ctx = make_context(UserId::new());

        run_preflight(
            InternalEvent::ChatMessage {
                content: secret.to_owned(),
            },
            Some(&ctx),
            &cfg,
            &store,
            &audit,
        )
        .await;

        let records = audit.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert!(
            !records[0].description.contains(secret),
            "audit description must not contain the raw event payload"
        );
    }

    // AC-3 + AC-4: missing context audit record description does not contain event payload
    #[tokio::test]
    async fn missing_context_audit_record_description_does_not_contain_event_payload() {
        let cfg = PreflightConfig {
            allowed_user_ids: vec![],
        };
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let secret = "very-sensitive-data-9999";

        run_preflight(
            InternalEvent::ChatMessage {
                content: secret.to_owned(),
            },
            None,
            &cfg,
            &store,
            &audit,
        )
        .await;

        let records = audit.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert!(
            !records[0].description.contains(secret),
            "audit description must not contain the raw event payload"
        );
    }
}
