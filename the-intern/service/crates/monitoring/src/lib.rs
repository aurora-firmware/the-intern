#![forbid(unsafe_code)]

use std::{collections::HashMap, path::PathBuf};

use async_trait::async_trait;
use bob_core::error::{ServiceError, ServiceResult};
use bob_core::ports::AuditSink;
use bob_core::types::{AuditFilterKind, AuditRecord, AuditRecordKind};
use tokio::{
    fs::{File, OpenOptions},
    io::{AsyncWriteExt, BufWriter},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};

#[derive(Debug, Clone)]
pub struct Config {
    pub command_buffer: usize,
    pub audit_log_path: PathBuf,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            command_buffer: 0,
            audit_log_path: PathBuf::new(),
        }
    }
}

#[derive(Debug)]
enum Command {
    Append {
        record: AuditRecord,
        reply_tx: oneshot::Sender<ServiceResult<()>>,
    },
    SubscribeTail {
        filters: Vec<AuditFilterKind>,
        reply_tx: oneshot::Sender<ServiceResult<mpsc::UnboundedReceiver<AuditRecord>>>,
    },
}

#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Command>,
}

pub struct Actor {
    cfg: Config,
    rx: mpsc::Receiver<Command>,
    writer: Option<BufWriter<File>>,
    next_subscriber_id: usize,
    subscribers: HashMap<usize, Subscriber>,
}

#[derive(Debug)]
struct Subscriber {
    filters: Vec<AuditFilterKind>,
    tx: mpsc::UnboundedSender<AuditRecord>,
}

impl Handle {
    pub async fn append_record(&self, record: AuditRecord) -> ServiceResult<()> {
        let (reply_tx, reply_rx) = oneshot::channel();

        self.tx
            .send(Command::Append { record, reply_tx })
            .await
            .map_err(|_| ServiceError::ServiceDown)?;

        reply_rx.await.map_err(|_| ServiceError::ServiceDown)?
    }

    pub async fn subscribe_tail(
        &self,
        filters: Vec<AuditFilterKind>,
    ) -> ServiceResult<mpsc::UnboundedReceiver<AuditRecord>> {
        let (reply_tx, reply_rx) = oneshot::channel();

        self.tx
            .send(Command::SubscribeTail { filters, reply_tx })
            .await
            .map_err(|_| ServiceError::ServiceDown)?;

        reply_rx.await.map_err(|_| ServiceError::ServiceDown)?
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
                Command::Append { record, reply_tx } => {
                    let result = self.append_record(record).await;
                    let _ = reply_tx.send(result);
                }
                Command::SubscribeTail { filters, reply_tx } => {
                    let (tx, rx) = mpsc::unbounded_channel();
                    let subscriber_id = self.next_subscriber_id;
                    self.next_subscriber_id = self.next_subscriber_id.saturating_add(1);
                    self.subscribers.insert(subscriber_id, Subscriber { filters, tx });
                    let _ = reply_tx.send(Ok(rx));
                }
            }
        }
        if let Some(writer) = self.writer.as_mut() {
            if let Err(error) = writer.flush().await {
                tracing::warn!(error = %error, "failed to flush audit writer during shutdown");
            }
        }
        tracing::info!("monitoring actor stopped");
    }

    async fn append_record(&mut self, record: AuditRecord) -> ServiceResult<()> {
        self.ensure_writer().await?;

        let payload = serde_json::to_vec(&record).map_err(|error| ServiceError::Persistence {
            detail: format!("failed to serialize audit record to JSON ({error})"),
        })?;

        let Some(writer) = self.writer.as_mut() else {
            return Err(ServiceError::Persistence {
                detail: "audit writer was unavailable after initialization".to_owned(),
            });
        };

        writer
            .write_all(&payload)
            .await
            .map_err(|error| ServiceError::Persistence {
                detail: format!("failed to append audit record bytes ({error})"),
            })?;
        writer
            .write_all(b"\n")
            .await
            .map_err(|error| ServiceError::Persistence {
                detail: format!("failed to append audit record newline ({error})"),
            })?;

        self.fan_out_to_subscribers(&record);
        Ok(())
    }

    async fn ensure_writer(&mut self) -> ServiceResult<()> {
        if self.writer.is_some() {
            return Ok(());
        }

        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.cfg.audit_log_path)
            .await
            .map_err(|error| ServiceError::Persistence {
                detail: format!(
                    "failed to open audit log file at {} ({error})",
                    self.cfg.audit_log_path.display()
                ),
            })?;

        self.writer = Some(BufWriter::new(file));
        Ok(())
    }

    fn fan_out_to_subscribers(&mut self, record: &AuditRecord) {
        self.subscribers.retain(|_, subscriber| {
            if !subscriber.matches(record.kind) {
                return true;
            }
            subscriber.tx.send(record.clone()).is_ok()
        });
    }
}

impl Subscriber {
    fn matches(&self, record_kind: AuditRecordKind) -> bool {
        if self.filters.is_empty() {
            return true;
        }

        self.filters
            .iter()
            .copied()
            .any(|filter| filter_matches_record_kind(filter, record_kind))
    }
}

fn filter_matches_record_kind(filter: AuditFilterKind, record_kind: AuditRecordKind) -> bool {
    matches!(
        (filter, record_kind),
        (AuditFilterKind::Events, AuditRecordKind::Event)
            | (AuditFilterKind::Reports, AuditRecordKind::Report)
            | (AuditFilterKind::Verdicts, AuditRecordKind::Verdict)
    )
}

#[derive(Clone)]
pub struct MonitoringAuditSink {
    handle: Handle,
}

impl MonitoringAuditSink {
    pub fn new(handle: Handle) -> Self {
        Self { handle }
    }
}

#[async_trait]
impl AuditSink for MonitoringAuditSink {
    async fn append(&self, record: AuditRecord) -> ServiceResult<()> {
        self.handle.append_record(record).await
    }
}

pub fn start(cfg: Config) -> (Handle, JoinHandle<()>) {
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);
    let actor = Actor {
        cfg,
        rx,
        writer: None,
        next_subscriber_id: 0,
        subscribers: HashMap::new(),
    };
    let join = tokio::spawn(async move {
        actor.run().await;
    });
    (Handle { tx }, join)
}

#[cfg(test)]
mod tests {
    use std::str::FromStr;
    use std::time::Duration;

    use bob_core::types::{
        AuditFilterKind, AuditRecordKind, AuditRecordPayload, ExtensionEventAuditPayload,
        PolicyVerdictAuditPayload,
    };
    use tokio::time::timeout;

    use super::*;

    fn test_record() -> AuditRecord {
        AuditRecord {
            id: "audit_001".to_owned(),
            timestamp: "2026-05-20T11:00:00Z".to_owned(),
            kind: AuditRecordKind::Event,
            session_id: None,
            payload: AuditRecordPayload::Event(ExtensionEventAuditPayload {
                name: "extension.event.forwarded".to_owned(),
                summary: Some("forwarded".to_owned()),
            }),
        }
    }

    fn verdict_record() -> AuditRecord {
        AuditRecord {
            id: "audit_002".to_owned(),
            timestamp: "2026-05-20T11:01:00Z".to_owned(),
            kind: AuditRecordKind::Verdict,
            session_id: None,
            payload: AuditRecordPayload::Verdict(PolicyVerdictAuditPayload {
                allow: true,
                reason: Some("allowed".to_owned()),
            }),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn append_record_writes_one_json_object_line_to_audit_file() {
        let temp = tempfile::tempdir().expect("tempdir must be created");
        let log_path = temp.path().join("audit.jsonl");
        let (handle, task) = start(Config {
            command_buffer: 1,
            audit_log_path: log_path.clone(),
        });

        let result = handle.append_record(test_record()).await;

        assert!(result.is_ok(), "append should succeed, got: {result:?}");
        drop(handle);
        task.await.expect("actor task should exit cleanly");

        let content = tokio::fs::read_to_string(&log_path)
            .await
            .expect("audit file must be readable");
        let lines: Vec<&str> = content.lines().collect();

        assert_eq!(lines.len(), 1, "one accepted record should produce one line");
        let restored: AuditRecord =
            serde_json::from_str(lines[0]).expect("line must deserialize as AuditRecord");
        assert_eq!(restored.id, "audit_001");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn subscribe_tail_delivers_only_future_matching_records() {
        let temp = tempfile::tempdir().expect("tempdir must be created");
        let log_path = temp.path().join("audit.jsonl");
        let (handle, task) = start(Config {
            command_buffer: 4,
            audit_log_path: log_path,
        });

        handle
            .append_record(test_record())
            .await
            .expect("append before subscribe should succeed");

        let mut subscription = handle
            .subscribe_tail(vec![AuditFilterKind::from_str("events").expect("events parses")])
            .await
            .expect("subscribe should succeed");

        handle
            .append_record(test_record())
            .await
            .expect("matching append should succeed");
        handle
            .append_record(verdict_record())
            .await
            .expect("non-matching append should still succeed");

        let received = timeout(Duration::from_millis(200), subscription.recv())
            .await
            .expect("matching event should be delivered")
            .expect("subscription should stay open");
        assert_eq!(received.kind, AuditRecordKind::Event);

        let second = timeout(Duration::from_millis(200), subscription.recv()).await;
        assert!(
            second.is_err(),
            "non-matching verdict should not be delivered to events filter"
        );

        drop(handle);
        task.await.expect("actor task should exit cleanly");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn filtered_out_records_are_still_appended_to_jsonl() {
        let temp = tempfile::tempdir().expect("tempdir must be created");
        let log_path = temp.path().join("audit.jsonl");
        let (handle, task) = start(Config {
            command_buffer: 4,
            audit_log_path: log_path.clone(),
        });

        let mut subscription = handle
            .subscribe_tail(vec![AuditFilterKind::from_str("events").expect("events parses")])
            .await
            .expect("subscribe should succeed");

        handle
            .append_record(verdict_record())
            .await
            .expect("append should succeed even when filtered out");

        let second = timeout(Duration::from_millis(200), subscription.recv()).await;
        assert!(
            second.is_err(),
            "verdict should not be delivered to events-only subscription"
        );

        drop(handle);
        task.await.expect("actor task should exit cleanly");

        let content = tokio::fs::read_to_string(&log_path)
            .await
            .expect("audit file must be readable");
        let lines: Vec<&str> = content.lines().collect();
        assert_eq!(lines.len(), 1, "record should still be persisted to disk");
        let restored: AuditRecord =
            serde_json::from_str(lines[0]).expect("line must deserialize as AuditRecord");
        assert_eq!(restored.kind, AuditRecordKind::Verdict);
    }
}
