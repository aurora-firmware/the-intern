#![forbid(unsafe_code)]

pub mod listener;
pub mod peer_cred;

use std::path::PathBuf;

use bob_core::error::{ServiceError, ServiceResult};
use tokio::{
    net::UnixStream,
    sync::mpsc,
    task::JoinHandle,
};

use crate::listener::{Listener, ListenerConfig};

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

async fn run_connection(stream: UnixStream) {
    // Placeholder for T-022: frame handling and dispatch.
    drop(stream);
}

async fn run_listener(listener: Listener) {
    loop {
        match listener.accept().await {
            Ok(Some(stream)) => {
                tokio::spawn(run_connection(stream));
            }
            Ok(None) => {
                // Rejected peer already logged in `Listener::accept`.
            }
            Err(e) => {
                tracing::warn!(error = %e, "extension-ipc: accept error; retrying");
            }
        }
    }
}

pub fn start(cfg: Config) -> (Handle, JoinHandle<()>) {
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);

    let maybe_listener = if cfg.extension_sock_path.as_os_str().is_empty() {
        None
    } else {
        let listener_cfg = ListenerConfig {
            extension_sock_path: cfg.extension_sock_path.clone(),
            extension_allowed_uids: cfg.extension_allowed_uids.clone(),
            service_uid: cfg.service_uid,
        };
        match Listener::bind(listener_cfg) {
            Ok(listener) => {
                tracing::info!(
                    path = %cfg.extension_sock_path.display(),
                    "extension-ipc: listener bound"
                );
                Some(listener)
            }
            Err(e) => {
                tracing::error!(
                    error = %e,
                    path = %cfg.extension_sock_path.display(),
                    "extension-ipc: failed to bind listener; running without socket"
                );
                None
            }
        }
    };

    if let Some(listener) = maybe_listener {
        tokio::spawn(run_listener(listener));
    }

    let actor = Actor { cfg, rx };
    let join = tokio::spawn(async move {
        actor.run().await;
    });
    (Handle { tx }, join)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

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

    #[tokio::test(flavor = "current_thread")]
    async fn start_with_sock_path_creates_socket_file() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let sock_path = tmp.path().join("extension.sock");

        let probe = listener::Listener::bind(listener::ListenerConfig {
            extension_sock_path: sock_path.clone(),
            extension_allowed_uids: Vec::new(),
            service_uid: current_uid(),
        });
        match probe {
            Ok(listener) => drop(listener),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(e) => panic!("probe bind failed: {e}"),
        }
        let _ = std::fs::remove_file(&sock_path);

        let cfg = Config {
            extension_sock_path: sock_path.clone(),
            ..Config::default()
        };

        let (_, task) = start(cfg);
        tokio::task::yield_now().await;

        assert!(
            sock_path.exists(),
            "socket file should exist after start with sock path"
        );
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn start_without_sock_path_does_not_bind_any_socket() {
        let cfg = Config {
            extension_sock_path: PathBuf::new(),
            ..Config::default()
        };
        let (_, task) = start(cfg);
        task.abort();
    }
}
