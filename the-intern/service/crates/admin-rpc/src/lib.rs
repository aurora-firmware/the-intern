#![forbid(unsafe_code)]

pub mod listener;
pub mod peer_cred;

use bob_core::error::{ServiceError, ServiceResult};
use tokio::{sync::mpsc, task::JoinHandle};

#[derive(Debug, Clone, Default)]
pub struct Config {
    pub command_buffer: usize,
}

#[derive(Debug)]
enum Command {
    Ping,
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
    pub async fn ping(&self) -> ServiceResult<()> {
        let _ = self.tx.send(Command::Ping).await;
        Err(ServiceError::NotImplemented)
    }
}

impl Actor {
    async fn run(mut self) {
        tracing::info!(
            command_buffer = self.cfg.command_buffer,
            "admin-rpc actor started"
        );
        while let Some(command) = self.rx.recv().await {
            match command {
                Command::Ping => {
                    let payload = serde_json::json!({ "command": "ping" });
                    tracing::debug!(?payload, "admin-rpc command received");
                }
            }
        }
        tracing::info!("admin-rpc actor stopped");
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
    async fn handle_ping_returns_not_implemented() {
        let (handle, task) = start(Config::default());

        let result = handle.ping().await;

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
