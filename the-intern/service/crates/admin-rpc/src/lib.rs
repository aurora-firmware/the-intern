#![forbid(unsafe_code)]

pub mod listener;
pub mod peer_cred;

use std::path::PathBuf;

use bob_core::error::{ServiceError, ServiceResult};
use tokio::{sync::mpsc, task::JoinHandle};

use crate::listener::{Listener, ListenerConfig};

/// Configuration for the admin-rpc actor.
///
/// When `admin_sock_path` is set (non-empty), [`start`] will bind a Unix
/// domain socket listener and run an accept loop alongside the command actor.
/// When it is empty (the default), no socket is bound — this preserves
/// backward compatibility with callers that manage socket binding themselves
/// (e.g. `bob::serve`).
#[derive(Debug, Clone)]
pub struct Config {
    /// Size of the internal command channel buffer.
    pub command_buffer: usize,
    /// Path where the admin Unix domain socket should be created.
    /// Leave empty to skip listener creation.
    pub admin_sock_path: PathBuf,
    /// UIDs that may connect to the admin socket in addition to the service's
    /// own UID.
    pub admin_allowed_uids: Vec<u32>,
    /// UID of the running service process.  Defaults to the current process
    /// UID.
    pub service_uid: u32,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            command_buffer: 0,
            admin_sock_path: PathBuf::new(),
            admin_allowed_uids: Vec::new(),
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

/// Runs the listener accept loop, dropping each accepted stream after the
/// peer-credential gate.  The per-connection handler body is filled in by
/// T-019; this stub closes accepted-but-allowed streams immediately.
async fn run_listener(listener: Listener) {
    loop {
        match listener.accept().await {
            Ok(Some(_stream)) => {
                // T-019 will replace this stub with real per-connection work.
                // For now, drop the stream to close the connection cleanly.
                tracing::debug!("admin-rpc: accepted connection (stub: closing immediately)");
            }
            Ok(None) => {
                // Peer was rejected — already logged in `Listener::accept`.
            }
            Err(e) => {
                tracing::warn!(error = %e, "admin-rpc: accept error; retrying");
            }
        }
    }
}

/// Starts the admin-rpc actor and, when `cfg.admin_sock_path` is non-empty,
/// binds the Unix domain socket listener and spawns an accept loop task.
///
/// Both tasks are returned as a single `JoinHandle<()>` that resolves when the
/// command actor exits.  The listener task is detached; it will be cancelled
/// when the process exits or when the socket file is removed externally.
///
/// Callers that manage socket binding themselves (e.g. `bob::serve`) should
/// leave `admin_sock_path` empty.
pub fn start(cfg: Config) -> (Handle, JoinHandle<()>) {
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);

    // Optionally bind the listener.  If the path is empty we skip binding to
    // stay compatible with `bob::serve` which does its own socket management.
    let maybe_listener = if cfg.admin_sock_path.as_os_str().is_empty() {
        None
    } else {
        let listener_cfg = ListenerConfig {
            admin_sock_path: cfg.admin_sock_path.clone(),
            admin_allowed_uids: cfg.admin_allowed_uids.clone(),
            service_uid: cfg.service_uid,
        };
        match Listener::bind(listener_cfg) {
            Ok(l) => {
                tracing::info!(
                    path = %cfg.admin_sock_path.display(),
                    "admin-rpc: listener bound"
                );
                Some(l)
            }
            Err(e) => {
                tracing::error!(
                    error = %e,
                    path = %cfg.admin_sock_path.display(),
                    "admin-rpc: failed to bind listener; running without socket"
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

    // Wiring test: start with a socket path binds the listener on disk.
    #[tokio::test(flavor = "current_thread")]
    async fn start_with_sock_path_creates_socket_file() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let sock_path = tmp.path().join("admin.sock");

        let cfg = Config {
            admin_sock_path: sock_path.clone(),
            ..Config::default()
        };

        let (_, task) = start(cfg);

        // Give the spawn a moment to execute on the current-thread executor.
        tokio::task::yield_now().await;

        assert!(
            sock_path.exists(),
            "socket file should exist after start with sock path"
        );
        task.abort();
    }

    // Wiring test: start without a socket path does not create any socket file.
    #[tokio::test(flavor = "current_thread")]
    async fn start_without_sock_path_does_not_bind_any_socket() {
        let (_, task) = start(Config::default());
        // No assertion on filesystem — just verify it doesn't panic.
        task.abort();
    }
}
