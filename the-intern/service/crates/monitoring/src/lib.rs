#![forbid(unsafe_code)]
#![doc = "scaffold — see project/docs/roadmap.md phase 5"]

use async_trait::async_trait;
use bob_core::error::{ServiceError, ServiceResult};
use bob_core::ports::AuditSink;
use bob_core::types::{AuditKind, AuditRecord};
use tokio::{sync::mpsc, task::JoinHandle};

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub command_buffer: usize,
}

#[derive(Debug)]
enum Command {
    Record(String),
}

#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Command>,
}

pub struct Actor {
    cfg: Config,
    rx: mpsc::Receiver<Command>,
}

impl Handle {
    pub async fn record_event(&self, event: impl Into<String>) -> ServiceResult<()> {
        let _ = self.tx.send(Command::Record(event.into())).await;
        Err(ServiceError::NotImplemented)
    }
}

impl Actor {
    async fn run(mut self) {
        tracing::info!(
            command_buffer = self.cfg.command_buffer,
            "monitoring actor started"
        );
        while let Some(command) = self.rx.recv().await {
            match command {
                Command::Record(event) => {
                    tracing::debug!(event_len = event.len(), "monitoring command received");
                }
            }
        }
        tracing::info!("monitoring actor stopped");
    }
}

/// Maps an [`AuditKind`] variant to a stable kebab-case event-name string.
///
/// The mapping is expressed as an exhaustive `match` so that adding a new
/// `AuditKind` variant causes a compile error here, forcing the author to
/// assign a stable name before the new variant can be used on the monitoring
/// channel. Do **not** replace this with `format!("{kind:?}")` — that would
/// silently change the wire shape on any variant rename.
pub fn audit_kind_to_event_name(kind: &AuditKind) -> &'static str {
    match kind {
        AuditKind::RequestReceived => "request-received",
        AuditKind::PolicyDecision => "policy-decision",
        AuditKind::ActionInvoked => "action-invoked",
        AuditKind::ActionCompleted => "action-completed",
        AuditKind::ActionFailed => "action-failed",
        AuditKind::SessionStarted => "session-started",
        AuditKind::SessionEnded => "session-ended",
        AuditKind::PreflightDenied => "preflight-denied",
    }
}

/// Typed [`AuditSink`] adapter that forwards audit records to the monitoring
/// actor.
///
/// Each [`AuditKind`] variant is translated to a stable kebab-case event name
/// via [`audit_kind_to_event_name`]. The description from the record is
/// appended after the event name, separated by `": "`.
#[derive(Clone)]
pub struct MonitoringAuditSink {
    handle: Handle,
}

impl MonitoringAuditSink {
    /// Creates a new sink that forwards audit records to `handle`.
    pub fn new(handle: Handle) -> Self {
        Self { handle }
    }
}

#[async_trait]
impl AuditSink for MonitoringAuditSink {
    async fn append(&self, record: AuditRecord) -> ServiceResult<()> {
        let event_name = audit_kind_to_event_name(&record.kind);
        self.handle
            .record_event(format!("{event_name}: {}", record.description))
            .await
    }
}

pub fn start(cfg: Config) -> (Handle, JoinHandle<()>) {
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);
    let actor = Actor { cfg, rx };
    let join = tokio::spawn(async move {
        actor.run().await;
    });
    (Handle { tx }, join)
}

#[cfg(test)]
mod tests {
    use super::*;
    use bob_core::error::ServiceError;
    use bob_core::types::AuditKind;

    #[tokio::test(flavor = "current_thread")]
    async fn record_event_returns_not_implemented() {
        let (handle, task) = start(Config::default());

        let result = handle.record_event("session.started").await;

        assert!(matches!(result, Err(ServiceError::NotImplemented)));
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn handle_is_clonable() {
        let (handle, task) = start(Config::default());

        let _clone = handle.clone();

        task.abort();
    }

    /// Pins the stable kebab-case event name for every [`AuditKind`] variant.
    ///
    /// This test is intentionally exhaustive: if a new variant is added to
    /// [`AuditKind`] and not listed here, the match in [`audit_kind_to_event_name`]
    /// will not compile, and this test will also fail to compile. That is the
    /// desired behaviour — renames must be accompanied by a deliberate table update.
    #[test]
    fn audit_kind_to_event_name_maps_every_variant_to_stable_kebab_case_string() {
        let cases: &[(AuditKind, &str)] = &[
            (AuditKind::RequestReceived, "request-received"),
            (AuditKind::PolicyDecision, "policy-decision"),
            (AuditKind::ActionInvoked, "action-invoked"),
            (AuditKind::ActionCompleted, "action-completed"),
            (AuditKind::ActionFailed, "action-failed"),
            (AuditKind::SessionStarted, "session-started"),
            (AuditKind::SessionEnded, "session-ended"),
            (AuditKind::PreflightDenied, "preflight-denied"),
        ];

        for (kind, expected) in cases {
            assert_eq!(
                audit_kind_to_event_name(kind),
                *expected,
                "AuditKind::{kind:?} must map to \"{expected}\""
            );
        }
    }
}
