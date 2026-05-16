#![forbid(unsafe_code)]

use bob_core::error::{ServiceError, ServiceResult};
use tokio::{sync::mpsc, task::JoinHandle};

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub command_buffer: usize,
}

#[derive(Debug)]
enum Command {
    SendMessage(String),
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
    pub async fn send_message(&self, message: impl Into<String>) -> ServiceResult<()> {
        let _ = self.tx.send(Command::SendMessage(message.into())).await;
        Err(ServiceError::NotImplemented)
    }
}

impl Actor {
    async fn run(mut self) {
        tracing::info!(
            command_buffer = self.cfg.command_buffer,
            "extension-ipc actor started"
        );
        while let Some(command) = self.rx.recv().await {
            match command {
                Command::SendMessage(message) => {
                    let payload = serde_json::json!({ "command": "send_message", "size": message.len() });
                    tracing::debug!(?payload, "extension-ipc command received");
                }
            }
        }
        tracing::info!("extension-ipc actor stopped");
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

    #[tokio::test(flavor = "current_thread")]
    async fn handle_send_message_returns_not_implemented() {
        let (handle, task) = start(Config::default());

        let result = handle.send_message("hello").await;

        assert!(matches!(result, Err(ServiceError::NotImplemented)));
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn handle_is_clonable() {
        let (handle, task) = start(Config::default());

        let _clone = handle.clone();

        task.abort();
    }
}
