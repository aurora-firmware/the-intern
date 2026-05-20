#![forbid(unsafe_code)]

use std::path::PathBuf;

use async_trait::async_trait;
use bob_core::error::{ServiceError, ServiceResult};
use bob_core::ports::AuditSink;
use bob_core::types::AuditRecord;
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
}

#[derive(Clone)]
pub struct Handle {
    tx: mpsc::Sender<Command>,
}

pub struct Actor {
    cfg: Config,
    rx: mpsc::Receiver<Command>,
    writer: Option<BufWriter<File>>,
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
    };
    let join = tokio::spawn(async move {
        actor.run().await;
    });
    (Handle { tx }, join)
}

#[cfg(test)]
mod tests {
    use bob_core::types::{AuditRecordKind, AuditRecordPayload, ExtensionEventAuditPayload};

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
}
