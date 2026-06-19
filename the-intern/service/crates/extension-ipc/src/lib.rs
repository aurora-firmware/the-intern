#![forbid(unsafe_code)]

pub mod framing;
pub mod listener;
pub mod multiplex;
pub mod peer_cred;

use std::path::PathBuf;
use std::sync::Arc;

use tokio::{
    net::UnixStream,
    sync::{mpsc, watch},
    task::JoinHandle,
};

use crate::listener::{Listener, ListenerConfig};
use crate::multiplex::{MonitoringHandle, NoopMonitoringHandle, SessionMultiplexer};

pub use crate::multiplex::{MonitoringBackedHandle, TracingMonitoringHandle};

#[derive(Clone)]
pub struct Config {
    pub command_buffer: usize,
    pub extension_sock_path: PathBuf,
    pub monitoring_handle: Arc<dyn MonitoringHandle>,
    pub policy_snapshot: policy_control::SnapshotHandle,
}

impl std::fmt::Debug for Config {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Config")
            .field("command_buffer", &self.command_buffer)
            .field("extension_sock_path", &self.extension_sock_path)
            .field("monitoring_handle", &"<dyn MonitoringHandle>")
            .field("policy_snapshot", &"<SnapshotHandle>")
            .finish()
    }
}

impl Default for Config {
    fn default() -> Self {
        let (_, _, snapshot) = policy_control::start(policy_control::Config::default());
        Self {
            command_buffer: 0,
            extension_sock_path: PathBuf::new(),
            monitoring_handle: Arc::new(NoopMonitoringHandle),
            policy_snapshot: snapshot,
        }
    }
}

#[doc = "scaffold — see project/docs/roadmap.md phase 3"]
#[derive(Clone)]
pub struct Handle {
    // Kept to control the actor channel lifetime: the actor loop exits when
    // all Handle clones are dropped and tx is closed.
    #[allow(dead_code)]
    tx: mpsc::Sender<std::convert::Infallible>,
}

#[doc = "scaffold — see project/docs/roadmap.md phase 3"]
pub struct Actor {
    cfg: Config,
    rx: mpsc::Receiver<std::convert::Infallible>,
}

impl Actor {
    async fn run(mut self) {
        tracing::info!(
            command_buffer = self.cfg.command_buffer,
            "extension-ipc actor started"
        );
        while self.rx.recv().await.is_some() {
            // No commands are defined; this branch is unreachable.
        }
        tracing::info!("extension-ipc actor stopped");
    }
}

// Back-pressure coupling — inbound reads and outbound writes share a single loop.
//
// After every inbound frame is dispatched, `out_rx.try_recv()` drains any
// outbound frames that the multiplexer has queued, writing each one to the
// socket via `write_all_nonblocking`. Because `write_all_nonblocking` awaits
// the socket to become writable before retrying a short write, a slow or
// stalled peer causes that await to block, which in turn stalls the next
// iteration of the inbound read loop. This is intentional: it applies
// back-pressure from the write side to the read side, so the bob service
// cannot consume inbound frames faster than the peer can accept outbound
// replies.
//
// Single-connection assumption: this coupling is correct only when there is
// exactly one active connection per actor. With multiple concurrent connections
// sharing a single loop the stall from one slow peer would block inbound
// processing for all other peers. If the design ever moves to multiple
// connections, the write path must be decoupled from the read loop.
async fn run_connection(
    stream: UnixStream,
    monitoring_handle: Arc<dyn MonitoringHandle>,
    snapshot: policy_control::SnapshotHandle,
) {
    let stream = stream;
    let (out_tx, mut out_rx) = mpsc::unbounded_channel();
    let mut multiplexer = SessionMultiplexer::new(monitoring_handle, snapshot, out_tx.clone());
    let mut inbound = Vec::new();
    let mut read_buf = [0_u8; 4096];

    loop {
        match stream.readable().await {
            Ok(()) => {}
            Err(e) => {
                tracing::warn!(error = %e, "extension-ipc: failed waiting for readable socket");
                break;
            }
        }

        let n = match stream.try_read(&mut read_buf) {
            Ok(0) => break,
            Ok(n) => n,
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) => {
                tracing::warn!(error = %e, "extension-ipc: failed to read frame; closing connection");
                break;
            }
        };
        inbound.extend_from_slice(&read_buf[..n]);

        while let Some(pos) = inbound.iter().position(|b| *b == b'\n') {
            let frame_bytes: Vec<u8> = inbound.drain(..=pos).collect();
            let line = match String::from_utf8(frame_bytes) {
                Ok(line) => line,
                Err(e) => {
                    tracing::warn!(error = %e, "extension-ipc: frame is not utf-8; closing connection");
                    return;
                }
            };
            let frame = match framing::parse_inbound_frame(&line) {
                Ok(frame) => frame,
                Err(e) => {
                    tracing::warn!(error = %e, "extension-ipc: malformed frame; closing connection");
                    return;
                }
            };

            if let Err(e) = multiplexer.handle_frame(frame).await {
                tracing::warn!(error = %e, "extension-ipc: failed to route frame; closing connection");
                return;
            }

            while let Ok(outbound) = out_rx.try_recv() {
                let wire = match framing::encode_outbound_frame(&outbound) {
                    Ok(wire) => wire,
                    Err(e) => {
                        tracing::warn!(error = %e, "extension-ipc: failed to encode outbound frame");
                        return;
                    }
                };

                if let Err(e) = write_all_nonblocking(&stream, wire.as_bytes()).await {
                    tracing::warn!(error = %e, "extension-ipc: failed to write outbound frame");
                    return;
                }
            }
        }
    }
}

async fn write_all_nonblocking(stream: &UnixStream, mut payload: &[u8]) -> std::io::Result<()> {
    while !payload.is_empty() {
        stream.writable().await?;
        match stream.try_write(payload) {
            Ok(0) => {
                return Err(std::io::Error::new(
                    std::io::ErrorKind::WriteZero,
                    "socket closed while writing frame",
                ));
            }
            Ok(n) => payload = &payload[n..],
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => continue,
            Err(e) => return Err(e),
        }
    }
    Ok(())
}

async fn run_listener(
    listener: Listener,
    monitoring_handle: Arc<dyn MonitoringHandle>,
    snapshot: policy_control::SnapshotHandle,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    // Track accepted connection tasks so they can be torn down on shutdown.
    // Detached connection tasks would otherwise keep their cloned subsystem
    // handles (monitoring, policy snapshot) alive and stall the shutdown drain.
    let mut connections = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            biased;
            shutdown = shutdown_rx.changed() => {
                match shutdown {
                    Ok(()) | Err(_) => {
                        tracing::info!("extension-ipc: listener shutdown requested");
                        break;
                    }
                }
            }
            accepted = listener.accept() => {
                match accepted {
                    Ok(Some(stream)) => {
                        let monitoring = Arc::clone(&monitoring_handle);
                        let snapshot = snapshot.clone();
                        connections.spawn(run_connection(stream, monitoring, snapshot));
                    }
                    Ok(None) => {
                        // Rejected peer already logged in `Listener::accept`.
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "extension-ipc: accept error; retrying");
                    }
                }
            }
            // Reap finished connections so the set does not grow over the
            // listener's lifetime. Disabled while empty so the branch does not
            // busy-loop on an immediate `None`.
            Some(_joined) = connections.join_next(), if !connections.is_empty() => {}
        }
    }

    // Abort any in-flight connections and wait for them to unwind, dropping
    // their subsystem-handle clones before the shutdown protocol drains actors.
    connections.shutdown().await;
}

pub fn start(cfg: Config) -> std::io::Result<(Handle, JoinHandle<()>)> {
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);
    let monitoring_handle = Arc::clone(&cfg.monitoring_handle);
    let snapshot = cfg.policy_snapshot.clone();

    // A non-empty path must own its listener: a bind failure aborts startup so
    // the caller refuses to serve (and never hands the path to workers as
    // BOB_EXTENSION_SOCK_PATH) rather than running without the socket it
    // advertised. An empty path is the scaffold/test case and binds nothing.
    let maybe_listener = if cfg.extension_sock_path.as_os_str().is_empty() {
        None
    } else {
        let listener_cfg = ListenerConfig {
            extension_sock_path: cfg.extension_sock_path.clone(),
        };
        let listener = Listener::bind(listener_cfg)?;
        tracing::info!(
            path = %cfg.extension_sock_path.display(),
            "extension-ipc: listener bound"
        );
        Some(listener)
    };

    // Spawn the listener task, retaining its join handle so the actor task can
    // await it after sending the shutdown signal.
    let listener_join = maybe_listener.map(|listener| {
        tokio::spawn(run_listener(
            listener,
            monitoring_handle,
            snapshot,
            shutdown_rx,
        ))
    });

    let actor = Actor { cfg, rx };
    let join = tokio::spawn(async move {
        actor.run().await;
        // Signal the listener to stop, then wait for it to drain and exit.
        let _ = shutdown_tx.send(true);
        if let Some(lj) = listener_join {
            if let Err(e) = lj.await {
                tracing::warn!(error = %e, "extension-ipc: listener task panicked");
            }
        }
    });
    Ok((Handle { tx }, join))
}

#[cfg(test)]
mod tests {
    use super::*;
    use async_trait::async_trait;
    use std::{path::PathBuf, sync::Mutex};

    use crate::multiplex::MonitoringEvent;

    #[derive(Default)]
    struct CapturingMonitoringHandle {
        events: Mutex<Vec<MonitoringEvent>>,
    }

    #[async_trait]
    impl MonitoringHandle for CapturingMonitoringHandle {
        async fn record_event(&self, event: MonitoringEvent) {
            self.events.lock().expect("events lock").push(event);
        }

        async fn record_verdict(&self, _verdict: crate::multiplex::MonitoringVerdict) {}
    }

    fn deny_all_snapshot() -> policy_control::SnapshotHandle {
        let (_, _, handle) = policy_control::start(policy_control::Config::default());
        handle
    }

    async fn write_frame(stream: &UnixStream, payload: &str) {
        write_all_nonblocking(stream, payload.as_bytes())
            .await
            .expect("write frame");
    }

    async fn wait_for_line(stream: &UnixStream, max_spins: usize) -> Option<String> {
        let mut pending = Vec::new();
        let mut buf = [0_u8; 1024];
        for _ in 0..max_spins {
            match stream.try_read(&mut buf) {
                Ok(0) => return None,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    if let Some(pos) = pending.iter().position(|b| *b == b'\n') {
                        let line = String::from_utf8(pending.drain(..=pos).collect()).ok()?;
                        return Some(line);
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::task::yield_now().await;
                }
                Err(e) => panic!("read error: {e}"),
            }
        }
        None
    }

    async fn wait_for_eof(stream: &UnixStream, max_spins: usize) -> bool {
        let mut buf = [0_u8; 8];
        for _ in 0..max_spins {
            match stream.try_read(&mut buf) {
                Ok(0) => return true,
                Ok(_) => return false,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::task::yield_now().await;
                }
                Err(e) => panic!("read error: {e}"),
            }
        }
        false
    }

    #[tokio::test(flavor = "current_thread")]
    async fn handle_is_clonable() {
        let (handle, task) = start(Config::default()).expect("start extension-ipc");

        let _clone = handle.clone();

        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn start_with_sock_path_creates_socket_file() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let sock_path = tmp.path().join("extension.sock");

        let probe = listener::Listener::bind(listener::ListenerConfig {
            extension_sock_path: sock_path.clone(),
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

        let (_, task) = start(cfg).expect("start extension-ipc");
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
        let (_, task) = start(cfg).expect("start extension-ipc");
        task.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connection_authz_frame_returns_deny_verdict_with_same_session() {
        let (client, server) = UnixStream::pair().expect("socket pair");
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(CapturingMonitoringHandle::default());
        let conn = tokio::spawn(run_connection(server, monitoring, deny_all_snapshot()));

        let session = bob_core::types::SessionId::new();
        let authz = format!(
            "{{\"kind\":\"authz\",\"session\":\"{session}\",\"tool\":\"bash\",\"arguments\":{{\"cmd\":\"ls\"}}}}\n"
        );

        write_frame(&client, &authz).await;
        let line = wait_for_line(&client, 500).await.expect("reply frame");

        let reply: serde_json::Value =
            serde_json::from_str(line.trim_end_matches('\n')).expect("valid json");
        assert_eq!(reply["kind"], "authz_verdict");
        assert_eq!(reply["session"], session.to_string());
        assert_eq!(reply["verdict"]["allow"], false);
        assert!(reply["verdict"]["reason"].is_string());

        drop(client);
        conn.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connection_event_frame_forwards_to_monitoring_without_reply() {
        let (client, server) = UnixStream::pair().expect("socket pair");
        let monitoring = Arc::new(CapturingMonitoringHandle::default());
        let sink: Arc<dyn MonitoringHandle> = monitoring.clone();
        let conn = tokio::spawn(run_connection(server, sink, deny_all_snapshot()));
        let session = bob_core::types::SessionId::new();

        let event = format!(
            "{{\"kind\":\"event\",\"session\":\"{session}\",\"payload\":{{\"event\":\"session.started\"}}}}\n"
        );

        write_frame(&client, &event).await;

        let line = wait_for_line(&client, 100).await;
        assert!(line.is_none(), "event frame should not produce wire reply");

        let events = monitoring.events.lock().expect("events lock");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].session, session);
        assert_eq!(events[0].payload["event"], "session.started");
        drop(events);

        drop(client);
        conn.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connection_parse_failures_close_socket_without_echo() {
        let (client, server) = UnixStream::pair().expect("socket pair");
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(CapturingMonitoringHandle::default());
        let conn = tokio::spawn(run_connection(server, monitoring, deny_all_snapshot()));

        write_frame(&client, "{\"kind\":\"event\",\"payload\":{\"bad\":true}}\n").await;

        assert!(
            wait_for_eof(&client, 500).await,
            "connection should close and echo no payload"
        );

        conn.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connection_malformed_json_closes_socket_without_echo() {
        let (client, server) = UnixStream::pair().expect("socket pair");
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(CapturingMonitoringHandle::default());
        let conn = tokio::spawn(run_connection(server, monitoring, deny_all_snapshot()));

        write_frame(&client, "{\"kind\":\"authz\" this is invalid\n").await;

        assert!(
            wait_for_eof(&client, 500).await,
            "malformed json should close connection"
        );

        conn.abort();
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connection_invalid_utf8_closes_socket_without_echo() {
        let (client, server) = UnixStream::pair().expect("socket pair");
        let monitoring: Arc<dyn MonitoringHandle> = Arc::new(CapturingMonitoringHandle::default());
        let conn = tokio::spawn(run_connection(server, monitoring, deny_all_snapshot()));

        write_all_nonblocking(&client, b"\xff\n")
            .await
            .expect("write invalid utf-8 frame");

        assert!(
            wait_for_eof(&client, 500).await,
            "invalid utf-8 frame should close connection without echo"
        );

        conn.abort();
    }

    // B-012 part 1: a non-empty extension socket path that cannot be bound must
    // fail `start` so `bob serve` refuses to run rather than continuing without
    // owning the socket (and handing the path to pi-agent workers).
    #[tokio::test(flavor = "current_thread")]
    async fn start_with_unbindable_path_returns_err() {
        let tmp = tempfile::tempdir().expect("temp dir");
        // The socket's parent is a regular file, so `Listener::bind`'s
        // `create_dir_all` on the parent fails deterministically.
        let blocker = tmp.path().join("not-a-dir");
        std::fs::write(&blocker, b"x").expect("write blocker file");
        let sock_path = blocker.join("extension.sock");

        let cfg = Config {
            extension_sock_path: sock_path,
            ..Config::default()
        };

        assert!(
            start(cfg).is_err(),
            "start must return Err when a non-empty extension socket path cannot be bound"
        );
    }

    // B-012 part 2: in-flight connections accepted by the listener must be torn
    // down when the listener shuts down, so they release their cloned subsystem
    // handles and do not stall shutdown until the drain deadline.
    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_tears_down_in_flight_connections() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let sock_path = tmp.path().join("extension.sock");

        // Skip in sandboxes where binding/peer-cred is not permitted.
        match listener::Listener::bind(listener::ListenerConfig {
            extension_sock_path: sock_path.clone(),
        }) {
            Ok(listener) => drop(listener),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(e) => panic!("probe bind failed: {e}"),
        }
        let _ = std::fs::remove_file(&sock_path);

        let cfg = Config {
            extension_sock_path: sock_path.clone(),
            ..Config::default()
        };
        let (handle, join) = start(cfg).expect("start extension-ipc");

        // Connect a peer and wait for the listener to accept it.
        let client = loop {
            match UnixStream::connect(&sock_path).await {
                Ok(s) => break s,
                Err(_) => tokio::task::yield_now().await,
            }
        };

        // Send an authz frame and read the deny verdict. A reply proves the
        // connection task is live and holding the monitoring/snapshot clones.
        let session = bob_core::types::SessionId::new();
        let authz = format!(
            "{{\"kind\":\"authz\",\"session\":\"{session}\",\"tool\":\"bash\",\"arguments\":{{\"cmd\":\"ls\"}}}}\n"
        );
        write_frame(&client, &authz).await;
        let _verdict = wait_for_line(&client, 1000)
            .await
            .expect("verdict proves the connection task is live");

        // Drop the handle: actor stops -> listener shutdown -> connection teardown.
        drop(handle);

        // The actor join completes only after the listener has joined the
        // aborted connection tasks.
        tokio::time::timeout(std::time::Duration::from_secs(5), join)
            .await
            .expect("shutdown must complete promptly, not hang")
            .expect("actor task must not panic");

        // The server side of the connection was dropped, so the peer sees EOF.
        assert!(
            wait_for_eof(&client, 1000).await,
            "connected peer should see EOF after shutdown tears down the connection"
        );
    }
}
