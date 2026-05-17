#![forbid(unsafe_code)]

pub mod listener;
pub mod peer_cred;

use std::path::PathBuf;

use bob_core::error::{ServiceError, ServiceResult};
use tokio::{sync::mpsc, task::JoinHandle};

#[derive(Debug, Clone)]
pub struct Config {
    pub command_buffer: usize,
    pub extension_sock_path: PathBuf,
    pub extension_allowed_uids: Vec<u32>,
    pub service_uid: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            command_buffer: 0,
            extension_sock_path: PathBuf::new(),
            extension_allowed_uids: Vec::new(),
            service_uid: current_uid(),
        }
    }
}

#[cfg(any(target_os = "linux", target_os = "macos"))]
fn current_uid() -> u32 {
    nix::unistd::Uid::current().as_raw()
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn current_uid() -> u32 {
    0
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
