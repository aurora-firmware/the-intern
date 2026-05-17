#![forbid(unsafe_code)]

pub mod dispatch;
pub mod listener;
pub mod peer_cred;
pub mod protocol;

use std::path::PathBuf;

use bob_core::error::{ServiceError, ServiceResult};
use tokio::{io::BufReader, net::UnixStream, sync::mpsc, task::JoinHandle};

use crate::{
    dispatch::{DispatchOutcome, Dispatcher},
    listener::{Listener, ListenerConfig},
    protocol::{read_frame, write_frame, ErrorResponse, FrameRead},
};

/// Configuration for the admin-rpc actor.
///
/// When `admin_sock_path` is set (non-empty), [`start`] will bind a Unix
/// domain socket listener and run an accept loop alongside the command actor.
/// When it is empty (the default), no socket is bound — this preserves
/// backward compatibility with callers that manage socket binding themselves
/// (e.g. `bob::serve`).
#[derive(Clone)]
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
    /// Optional handle to the pi-agent supervisor.  When `None`, the
    /// `sessions.list` method returns `NotImplemented`.
    pub supervisor: Option<pi_agent_supervisor::Handle>,
    /// Optional handle to the policy-control actor.  When `None`, the
    /// `policy.reload` method returns `NotImplemented`.
    pub policy: Option<policy_control::Handle>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            command_buffer: 0,
            admin_sock_path: PathBuf::new(),
            admin_allowed_uids: Vec::new(),
            service_uid: current_uid(),
            supervisor: None,
            policy: None,
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

/// Handle one accepted connection: read JSON-RPC 2.0 frames, dispatch each
/// to the method registry, and write responses back.
///
/// AC-3: if any frame fails to parse, an error response (-32700) is written
/// and the connection is closed.
/// AC-5: each response carries the same `id` as the corresponding request.
async fn run_connection(stream: UnixStream, dispatcher: Dispatcher) {
    let (read_half, mut write_half) = tokio::io::split(stream);
    let mut reader = BufReader::new(read_half);

    loop {
        match read_frame(&mut reader).await {
            FrameRead::Ok(req) => {
                let outcome = dispatcher.dispatch(req).await;
                let write_result = match outcome {
                    DispatchOutcome::Ok(resp) => write_frame(&mut write_half, &resp).await,
                    DispatchOutcome::Err(err) => write_frame(&mut write_half, &err).await,
                };
                if let Err(e) = write_result {
                    tracing::debug!(error = %e, "admin-rpc: write error; closing connection");
                    return;
                }
            }
            FrameRead::ParseError => {
                // AC-3: respond with -32700 and close the connection.
                let err = ErrorResponse::parse_error(None);
                let _ = write_frame(&mut write_half, &err).await;
                tracing::debug!("admin-rpc: parse error; closing connection");
                return;
            }
            FrameRead::Eof => {
                tracing::debug!("admin-rpc: connection closed by peer");
                return;
            }
            FrameRead::IoError(e) => {
                tracing::debug!(error = %e, "admin-rpc: I/O error; closing connection");
                return;
            }
        }
    }
}

/// Runs the listener accept loop and dispatches each accepted connection to
/// [`run_connection`] in a spawned task.
async fn run_listener(listener: Listener, dispatcher: Dispatcher) {
    loop {
        match listener.accept().await {
            Ok(Some(stream)) => {
                let d = dispatcher.clone();
                tokio::spawn(run_connection(stream, d));
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

    // Build the dispatcher from the optional handles in the config.
    let dispatcher = Dispatcher::new(
        cfg.supervisor.clone(),
        cfg.policy.clone(),
        env!("CARGO_PKG_VERSION"),
    );

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
        tokio::spawn(run_listener(listener, dispatcher));
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
    use serde_json::json;
    use tokio::io::AsyncBufReadExt as _;
    use tokio::io::AsyncWriteExt as _;

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

    // Helper: build a dispatcher with no optional handles.
    fn make_dispatcher() -> Dispatcher {
        Dispatcher::new(None, None, "0.1.0-test")
    }

    // AC-1: a service.status request over a connected UnixStream pair yields a
    // valid JSON-RPC 2.0 response with an `ok: true` result.
    #[tokio::test(flavor = "current_thread")]
    async fn run_connection_service_status_returns_ok_response() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let dispatcher = make_dispatcher();

        tokio::spawn(run_connection(server, dispatcher));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // Send a service.status request.
        let req = r#"{"jsonrpc":"2.0","method":"service.status","id":1}"#;
        write_half.write_all(req.as_bytes()).await.expect("write");
        write_half.write_all(b"\n").await.expect("newline");

        // Read back the response.
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("read response");
        let resp: serde_json::Value =
            serde_json::from_str(line.trim()).expect("valid JSON response");

        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 1);
        assert_eq!(resp["result"]["ok"], true);
    }

    // AC-3: a malformed frame causes a -32700 error response and connection close.
    #[tokio::test(flavor = "current_thread")]
    async fn run_connection_parse_error_sends_minus_32700_and_closes() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let dispatcher = make_dispatcher();

        tokio::spawn(run_connection(server, dispatcher));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // Send malformed JSON.
        write_half
            .write_all(b"this is not json\n")
            .await
            .expect("write");

        // Read the error response.
        let mut line = String::new();
        reader.read_line(&mut line).await.expect("read response");
        let resp: serde_json::Value =
            serde_json::from_str(line.trim()).expect("valid JSON error response");

        assert_eq!(resp["error"]["code"], -32700);
        assert_eq!(resp["id"], serde_json::Value::Null);

        // The connection should now be closed — next read returns EOF.
        let mut extra = String::new();
        let n = reader.read_line(&mut extra).await.expect("read eof");
        assert_eq!(n, 0, "connection should be closed after parse error");
    }

    // AC-5: multiple sequential requests over the same connection each get a
    // response with the matching id.
    #[tokio::test(flavor = "current_thread")]
    async fn run_connection_sequential_requests_get_matching_ids() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let dispatcher = make_dispatcher();

        tokio::spawn(run_connection(server, dispatcher));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        for i in 1u64..=3 {
            let req = format!(r#"{{"jsonrpc":"2.0","method":"service.status","id":{i}}}"#);
            write_half
                .write_all(req.as_bytes())
                .await
                .expect("write request");
            write_half.write_all(b"\n").await.expect("newline");

            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read response");
            let resp: serde_json::Value = serde_json::from_str(line.trim()).expect("valid JSON");

            assert_eq!(
                resp["id"],
                json!(i),
                "response id must match request id for i={i}"
            );
        }
    }
}
