#![forbid(unsafe_code)]

use bob_core::{
    ports::{AuditSink, PersistenceStore},
    types::{
        AuditRecord, AuditRecordKind, AuditRecordPayload, InternalEvent, PolicyVerdictAuditPayload,
        RequestContext,
    },
};
use policy_control::{PolicyEngine, SnapshotHandle};

/// Run the pre-flight identity and access check for one dequeued event.
///
/// # Behaviour
///
/// - If `context` is `Some` and its `sender` is admitted by the current
///   snapshot, the event is forwarded to `store` via
///   `PersistenceStore::enqueue`.
/// - In all other cases (absent context, or sender denied by the snapshot),
///   the event is silently dropped, a `tracing::warn!` is emitted **without**
///   the raw event payload, and a `PreflightDenied` `AuditRecord` is appended
///   to `audit`.
///
/// Errors from `store.enqueue` or `audit.append` are logged but do not panic.
pub async fn run_preflight(
    event: InternalEvent,
    context: Option<&RequestContext>,
    snapshot: &SnapshotHandle,
    store: &dyn PersistenceStore,
    audit: &dyn AuditSink,
) {
    let verdict = context.map(|ctx| {
        let snap = snapshot.load();
        PolicyEngine::evaluate_admission(&snap, ctx.sender)
    });

    let allowed = verdict.as_ref().map(|v| v.allow).unwrap_or(false);

    if allowed {
        if let Err(err) = store.enqueue(event).await {
            tracing::warn!(error = %err, "preflight: persistence enqueue failed");
        }

        // Record the allow verdict to the audit sink.  A monitoring failure is
        // logged but does not affect the event's persistence outcome.
        let record = AuditRecord {
            id: format!(
                "audit_preflight_allow_{}",
                chrono::Utc::now().timestamp_millis()
            ),
            timestamp: chrono::Utc::now().to_rfc3339(),
            kind: AuditRecordKind::Verdict,
            session_id: None,
            payload: AuditRecordPayload::Verdict(PolicyVerdictAuditPayload {
                allow: true,
                reason: None,
            }),
        };

        if let Err(err) = audit.append(record).await {
            tracing::warn!(error = %err, "preflight: audit append failed after allow");
        }
    } else {
        let reason = if context.is_none() {
            "missing request context"
        } else {
            "user not admitted by policy"
        };

        // Warn without the raw event payload — only safe metadata.
        tracing::warn!(reason, "preflight: event denied");

        let timestamp = chrono::Utc::now().to_rfc3339();
        let id = format!(
            "audit_preflight_denied_{}",
            chrono::Utc::now().timestamp_millis()
        );
        let record = AuditRecord {
            id,
            timestamp,
            kind: AuditRecordKind::Verdict,
            session_id: None,
            payload: AuditRecordPayload::Verdict(PolicyVerdictAuditPayload {
                allow: false,
                reason: Some(format!("preflight denied: {reason}")),
            }),
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
            AuditRecord, AuditRecordKind, AuditRecordPayload, ChannelId, DeliveryKind,
            InternalEvent, RequestContext, SessionId, UserId,
        },
    };
    use policy_control::{PolicyConfig, RulesetSnapshot};

    use super::run_preflight;

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
            reply_address: None,
        }
    }

    fn chat_event(content: &str) -> InternalEvent {
        InternalEvent {
            kind: DeliveryKind::Sync,
            payload: content.to_owned(),
        }
    }

    fn make_snapshot(user_ids: Vec<UserId>) -> policy_control::SnapshotHandle {
        let cfg = PolicyConfig {
            admitted_users: user_ids.iter().map(|u| u.to_string()).collect(),
            action_rules: vec![],
        };
        let snapshot = RulesetSnapshot::from_config(cfg).expect("valid config");
        let policy_cfg = policy_control::Config {
            initial_snapshot: snapshot,
            config_path: std::path::PathBuf::new(),
            command_buffer: 1,
        };
        let (_, join, snapshot_handle) = policy_control::start(policy_cfg);
        join.abort();
        snapshot_handle
    }

    // AC-1: admitted user causes event to be enqueued in persistence store.
    #[tokio::test]
    async fn admitted_user_in_snapshot_causes_event_to_be_enqueued_in_persistence_store() {
        let user_id = UserId::new();
        let snapshot = make_snapshot(vec![user_id]);
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let event = chat_event("hello");
        let ctx = make_context(user_id);

        run_preflight(event.clone(), Some(&ctx), &snapshot, &store, &audit).await;

        let enqueued = store.enqueued.lock().unwrap();
        assert_eq!(enqueued.len(), 1, "expected exactly one event enqueued");
        assert_eq!(enqueued[0], event);
        // An allow-verdict audit record is now emitted for every admitted event.
        let records = audit.records.lock().unwrap();
        assert_eq!(
            records.len(),
            1,
            "allow-verdict audit record must be written on admit"
        );
        assert!(
            matches!(records[0].payload, AuditRecordPayload::Verdict(ref p) if p.allow),
            "audit record must be an allow verdict"
        );
    }

    // AC-1: multiple admitted user IDs — the matching one passes.
    #[tokio::test]
    async fn event_is_enqueued_when_user_id_matches_one_of_multiple_admitted_ids() {
        let user_a = UserId::new();
        let user_b = UserId::new();
        let snapshot = make_snapshot(vec![user_a, user_b]);
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let event = chat_event("msg");
        let ctx = make_context(user_b);

        run_preflight(event.clone(), Some(&ctx), &snapshot, &store, &audit).await;

        let enqueued = store.enqueued.lock().unwrap();
        assert_eq!(enqueued.len(), 1);
        // An allow-verdict audit record must still be present.
        let records = audit.records.lock().unwrap();
        assert_eq!(
            records.len(),
            1,
            "allow-verdict audit record must be written"
        );
        assert!(matches!(records[0].payload, AuditRecordPayload::Verdict(ref p) if p.allow),);
    }

    // AC-2: non-admitted user causes denial and PreflightDenied audit record.
    #[tokio::test]
    async fn non_admitted_user_in_snapshot_drops_event_and_emits_preflight_denied_audit_record() {
        let admitted = UserId::new();
        let intruder = UserId::new();
        let snapshot = make_snapshot(vec![admitted]);
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let ctx = make_context(intruder);

        run_preflight(
            chat_event("secret payload"),
            Some(&ctx),
            &snapshot,
            &store,
            &audit,
        )
        .await;

        assert!(
            store.enqueued.lock().unwrap().is_empty(),
            "event must not be enqueued on denial"
        );
        let records = audit.records.lock().unwrap();
        assert_eq!(records.len(), 1, "exactly one audit record expected");
        assert_eq!(
            records[0].kind,
            AuditRecordKind::Verdict,
            "audit record kind must be verdict"
        );
        assert!(
            matches!(
                records[0].payload,
                AuditRecordPayload::Verdict(ref payload) if !payload.allow
            ),
            "audit payload must be a denied verdict, got {:?}",
            records[0].payload
        );
    }

    // AC-2: empty admission list denies all events.
    #[tokio::test]
    async fn empty_admission_list_in_snapshot_denies_all_events() {
        let snapshot = make_snapshot(vec![]);
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let ctx = make_context(UserId::new());

        run_preflight(
            chat_event("anything"),
            Some(&ctx),
            &snapshot,
            &store,
            &audit,
        )
        .await;

        assert!(store.enqueued.lock().unwrap().is_empty());
        let records = audit.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, AuditRecordKind::Verdict);
        assert!(matches!(
            records[0].payload,
            AuditRecordPayload::Verdict(ref payload) if !payload.allow
        ));
    }

    // AC-2: absent RequestContext is treated as denied with PreflightDenied audit record.
    #[tokio::test]
    async fn missing_request_context_is_treated_as_denied_with_preflight_denied_audit_record() {
        let snapshot = make_snapshot(vec![UserId::new()]);
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();

        run_preflight(chat_event("no context"), None, &snapshot, &store, &audit).await;

        assert!(
            store.enqueued.lock().unwrap().is_empty(),
            "event without context must not be enqueued"
        );
        let records = audit.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].kind, AuditRecordKind::Verdict);
        assert!(matches!(
            records[0].payload,
            AuditRecordPayload::Verdict(ref payload) if !payload.allow
        ));
    }

    // AC-2 (T-065): admitted user causes an allow-verdict audit record to be emitted.
    #[tokio::test]
    async fn admitted_user_causes_allow_verdict_audit_record_to_be_emitted() {
        let user_id = UserId::new();
        let snapshot = make_snapshot(vec![user_id]);
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let event = chat_event("hello");
        let ctx = make_context(user_id);

        run_preflight(event.clone(), Some(&ctx), &snapshot, &store, &audit).await;

        let records = audit.records.lock().unwrap();
        assert_eq!(
            records.len(),
            1,
            "exactly one verdict audit record expected on allow"
        );
        assert_eq!(records[0].kind, AuditRecordKind::Verdict);
        assert!(
            matches!(
                records[0].payload,
                AuditRecordPayload::Verdict(ref payload) if payload.allow
            ),
            "audit payload must be an allow verdict, got {:?}",
            records[0].payload
        );
    }

    // AC-2: audit record reason does not contain the raw event payload.
    #[tokio::test]
    async fn audit_record_reason_does_not_contain_raw_event_payload() {
        let snapshot = make_snapshot(vec![]);
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let secret = "super-secret-payload-12345";
        let ctx = make_context(UserId::new());

        run_preflight(
            InternalEvent {
                kind: DeliveryKind::Sync,
                payload: secret.to_owned(),
            },
            Some(&ctx),
            &snapshot,
            &store,
            &audit,
        )
        .await;

        let records = audit.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        let denied_reason = match &records[0].payload {
            AuditRecordPayload::Verdict(payload) => payload
                .reason
                .as_deref()
                .expect("denied verdict should include a reason"),
            payload => panic!("expected verdict payload, got {payload:?}"),
        };
        assert!(
            !denied_reason.contains(secret),
            "audit reason must not contain the raw event payload"
        );
    }

    // AC-2: missing context audit record reason does not contain event payload.
    #[tokio::test]
    async fn missing_context_audit_record_reason_does_not_contain_event_payload() {
        let snapshot = make_snapshot(vec![]);
        let store = RecordingStore::default();
        let audit = RecordingAudit::default();
        let secret = "very-sensitive-data-9999";

        run_preflight(
            InternalEvent {
                kind: DeliveryKind::Sync,
                payload: secret.to_owned(),
            },
            None,
            &snapshot,
            &store,
            &audit,
        )
        .await;

        let records = audit.records.lock().unwrap();
        assert_eq!(records.len(), 1);
        let denied_reason = match &records[0].payload {
            AuditRecordPayload::Verdict(payload) => payload
                .reason
                .as_deref()
                .expect("denied verdict should include a reason"),
            payload => panic!("expected verdict payload, got {payload:?}"),
        };
        assert!(
            !denied_reason.contains(secret),
            "audit reason must not contain the raw event payload"
        );
    }
}
