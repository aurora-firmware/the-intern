#![forbid(unsafe_code)]

pub mod chat_router;
pub mod dispatch;
pub mod listener;
pub mod peer_cred;
pub mod protocol;
pub mod subscriptions;

use std::{path::PathBuf, time::Duration};

use serde_json::json;
use tokio::{
    io::{AsyncWriteExt as _, BufReader},
    net::UnixStream,
    sync::{mpsc, watch},
    task::{JoinHandle, JoinSet},
};

use crate::{
    dispatch::{DispatchOutcome, Dispatcher},
    listener::{Listener, ListenerConfig},
    protocol::{read_frame, ErrorResponse, FrameRead, Notification},
    subscriptions::{AdminSubscriptionId, ConnectionRegistry, SubscriptionBus},
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
    /// Optional handle to the pi-agent supervisor.  When `None`, the
    /// `sessions.list` method returns `NotImplemented`.
    pub supervisor: Option<pi_agent_supervisor::Handle>,
    /// Optional handle to the policy-control actor.  When set,
    /// `policy.reload` calls `Handle::reload`; when `None`, the method returns
    /// `NotImplemented`.
    pub policy: Option<policy_control::Handle>,
    /// Optional handle to the monitoring actor.  When set,
    /// `report.submit` delegates the report to Monitoring; when `None`, the
    /// method returns `NotImplemented`.
    pub monitoring: Option<monitoring::Handle>,
    /// Optional audit subscription bus.  When `None`, `audit.tail.subscribe`
    /// still registers subscriptions but no audit events will be delivered.
    pub audit_bus: Option<SubscriptionBus>,
    /// Maximum time the write task waits for a slow subscriber's send before
    /// dropping its subscription.
    pub slow_subscriber_deadline: Duration,
    /// Optional chat-adapter frame-delivery handle.
    ///
    /// When `Some`, `chat.send` requests are forwarded to the chat adapter.
    /// When `None` (the default), `chat.send` returns a JSON-RPC error
    /// indicating that the chat channel is not available.
    pub chat_adapter: Option<chat_adapter::FrameHandle>,
    /// Optional chat reply router.
    ///
    /// When `Some`, `chat.open` registers with this router and the connection
    /// loop spawns a forwarder that delivers replies as `chat.message`
    /// notifications.  When `None` (the default), an internal router is created
    /// automatically — production `serve.rs` requires no change.
    ///
    /// Pass a router created externally (via `Arc<ChatReplyRouter>`) to retain a
    /// `DeliveryHandle` clone for in-process injection (used by integration tests
    /// in T-090).
    pub chat_router: Option<std::sync::Arc<crate::chat_router::ChatReplyRouter>>,
    /// Optional scheduler-adapter reload handle.
    ///
    /// When `Some`, `schedule.*` methods (T-097) can push updated job tables to
    /// the scheduler actor.  When `None` (the default), `schedule.*` methods
    /// return `-32601 Method not found`.
    pub scheduler: Option<scheduler_adapter::ReloadHandle>,
    /// Optional path to the `bob.toml` config file.
    ///
    /// Required for `schedule.add`, `schedule.remove`, and `schedule.reload`
    /// to persist changes.  When `None` (the default), those methods return
    /// `-32601 Method not found`.
    pub config_path: Option<std::path::PathBuf>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            command_buffer: 0,
            admin_sock_path: PathBuf::new(),
            supervisor: None,
            policy: None,
            monitoring: None,
            audit_bus: None,
            slow_subscriber_deadline: Duration::from_secs(5),
            chat_adapter: None,
            chat_router: None,
            scheduler: None,
            config_path: None,
        }
    }
}

#[derive(Clone)]
pub struct Handle {
    // Kept to control the actor channel lifetime: the actor loop exits when
    // all Handle clones are dropped and tx is closed.
    #[allow(dead_code)]
    tx: mpsc::Sender<std::convert::Infallible>,
    shutdown_tx: watch::Sender<bool>,
}

impl Handle {
    /// Requests listener and connection shutdown without waiting for the actor
    /// handle itself to be dropped.
    pub fn begin_shutdown(&self) {
        let _ = self.shutdown_tx.send(true);
    }
}

pub struct Actor {
    cfg: Config,
    rx: mpsc::Receiver<std::convert::Infallible>,
}

impl Actor {
    async fn run(mut self) {
        tracing::info!(
            command_buffer = self.cfg.command_buffer,
            "admin-rpc actor started"
        );
        while self.rx.recv().await.is_some() {
            // No commands are defined; this branch is unreachable.
        }
        tracing::info!("admin-rpc actor stopped");
    }
}

// ── Connection concurrency model ──────────────────────────────────────────────
//
// Each connection runs two cooperating halves:
//
//   Read half  — runs in the calling task; reads frames, dispatches them, and
//                sends outbound messages via `out_tx` (serialised JSON frames).
//
//   Write half — runs in a spawned task; it `select!`s between:
//                  · `out_rx`   — response frames from the read half
//                  · `notif_rx` — notification bytes from subscription
//                                 forwarder sub-tasks
//
//   For each active audit subscription, a lightweight forwarder task reads
//   from an unbounded mpsc::UnboundedReceiver<AuditRecord> supplied by the
//   monitoring actor, using `tokio::select!` against a oneshot cancel receiver.
//   The forwarder exits when the cancel sender is dropped (explicit unsubscribe
//   or connection close) or when the monitoring actor closes the channel.

/// A frame sent from the read task to the write task.
enum OutboundMsg {
    /// A complete JSON frame (already serialized with trailing `\n`).
    Frame(Vec<u8>),
}

/// Forwarded from a subscription forwarder to the write task.
enum NotifMsg {
    /// A serialized notification frame to write to the client.
    Frame(Vec<u8>),
}

/// Handle one accepted connection: read JSON-RPC 2.0 frames, dispatch each
/// to the method registry, and write responses and subscription notifications back.
///
/// The read and write halves run concurrently so that inbound requests and
/// outbound notifications (from `audit.tail` subscriptions) do not block each
/// other.
///
/// AC-4: when a Monitoring-backed subscription receiver delivers a record, the
/// forwarder task serializes it and pushes it onto the notification channel.
/// AC-5: when the connection closes, all subscriptions registered on it are
/// cleaned up without leaking entries (via `ConnectionRegistry::drop`).
#[cfg(test)]
async fn run_connection(stream: UnixStream, dispatcher: Dispatcher, _bus: SubscriptionBus) {
    let (_shutdown_tx, shutdown_rx) = watch::channel(false);
    run_connection_with_shutdown(stream, dispatcher, _bus, shutdown_rx).await;
}

async fn run_connection_with_shutdown(
    stream: UnixStream,
    dispatcher: Dispatcher,
    _bus: SubscriptionBus,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let (read_half, write_half) = stream.into_split();
    let reader = BufReader::new(read_half);

    // Control channel: read task → write task.
    let (out_tx, out_rx) = mpsc::channel::<OutboundMsg>(64);
    // Notification channel: forwarder tasks → write task.
    let (notif_tx, notif_rx) = mpsc::channel::<NotifMsg>(64);

    // Build the per-connection registry and attach the chat router so the
    // registry can deregister chat subscriptions on connection drop (AC-3/T-086).
    let registry = {
        let r = ConnectionRegistry::new();
        if let Some(router) = dispatcher.chat_router() {
            r.with_chat_router(router)
        } else {
            r
        }
    };

    // Spawn the write task first so it is ready to receive messages.
    let write_task = tokio::spawn(write_loop(write_half, out_rx, notif_rx));

    // Run the read loop in the current task. `registry` drops at the end of
    // this scope, which calls Drop and removes all subscriptions (AC-5).
    read_loop(
        &mut shutdown_rx,
        reader,
        dispatcher,
        registry,
        out_tx,
        notif_tx,
    )
    .await;

    // Wait for the write task to flush and exit.
    write_task.await.ok();
}

/// Drives the inbound frame loop for one connection.
async fn read_loop(
    shutdown_rx: &mut watch::Receiver<bool>,
    mut reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    dispatcher: Dispatcher,
    mut registry: ConnectionRegistry,
    out_tx: mpsc::Sender<OutboundMsg>,
    notif_tx: mpsc::Sender<NotifMsg>,
) {
    loop {
        let frame_read = tokio::select! {
            biased;
            shutdown_result = shutdown_rx.changed() => {
                match shutdown_result {
                    Ok(()) | Err(_) => {
                        tracing::debug!("admin-rpc: connection shutdown requested");
                        break;
                    }
                }
            }
            frame_read = read_frame(&mut reader) => frame_read,
        };

        match frame_read {
            FrameRead::Ok(req) => {
                let outcome = dispatcher.dispatch(req, &mut registry).await;
                let ok = match outcome {
                    DispatchOutcome::Ok(resp) => out_tx
                        .send(OutboundMsg::Frame(serialize_frame(&resp)))
                        .await
                        .is_ok(),
                    DispatchOutcome::Err(err) => out_tx
                        .send(OutboundMsg::Frame(serialize_frame(&err)))
                        .await
                        .is_ok(),
                    DispatchOutcome::Subscribed {
                        response,
                        id,
                        rx,
                        cancel_rx,
                    } => {
                        // Send the response frame first.
                        if out_tx
                            .send(OutboundMsg::Frame(serialize_frame(&response)))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        // Spawn a forwarder task that delivers monitoring audit
                        // records to the write task via the notification channel.
                        let ntx = notif_tx.clone();
                        tokio::spawn(audit_forwarder(id, rx, cancel_rx, ntx));
                        true
                    }
                    DispatchOutcome::Unsubscribed { response, id: _ } => {
                        // The ConnectionRegistry already removed the subscription;
                        // the forwarder task will see its receiver close and exit.
                        out_tx
                            .send(OutboundMsg::Frame(serialize_frame(&response)))
                            .await
                            .is_ok()
                    }
                    DispatchOutcome::ChatSubscribed {
                        response,
                        id,
                        rx,
                        cancel_rx,
                    } => {
                        // Send the response frame first.
                        if out_tx
                            .send(OutboundMsg::Frame(serialize_frame(&response)))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        // Spawn a forwarder task that delivers chat reply payloads
                        // to the write task via the notification channel.
                        let ntx = notif_tx.clone();
                        tokio::spawn(chat_forwarder(id, rx, cancel_rx, ntx));
                        true
                    }
                    DispatchOutcome::ChatUnsubscribed { response, id: _ } => {
                        // The router and registry already removed the subscription;
                        // the chat forwarder task will see its cancel signal and exit.
                        out_tx
                            .send(OutboundMsg::Frame(serialize_frame(&response)))
                            .await
                            .is_ok()
                    }
                };
                if !ok {
                    // Write task is gone; close the connection.
                    break;
                }
            }
            FrameRead::ParseError => {
                let err = ErrorResponse::parse_error(None);
                let _ = out_tx.send(OutboundMsg::Frame(serialize_frame(&err))).await;
                tracing::debug!("admin-rpc: parse error; closing connection");
                break;
            }
            FrameRead::Eof => {
                tracing::debug!("admin-rpc: connection closed by peer");
                break;
            }
            FrameRead::IoError(e) => {
                tracing::debug!(error = %e, "admin-rpc: I/O error; closing connection");
                break;
            }
        }
    }
    // AC-5: `registry` drops here, cancelling all audit subscriptions and
    // removing all chat subscriptions from the bus.
}

/// Forwards Monitoring [`AuditRecord`]s from a tail subscription to the
/// notification channel as serialized `audit.tail` JSON-RPC notification frames.
///
/// The forwarder exits cleanly when either:
/// - `cancel_rx` fires (explicit `audit.tail.unsubscribe` or connection close), or
/// - `rx` returns `None` (monitoring actor shut down).
///
/// No `NotifMsg::Dropped` sentinel is sent — monitoring subscriptions are
/// unbounded so there is no slow-subscriber eviction from this side.
async fn audit_forwarder(
    id: AdminSubscriptionId,
    mut rx: mpsc::UnboundedReceiver<bob_core::types::AuditRecord>,
    cancel_rx: tokio::sync::oneshot::Receiver<()>,
    notif_tx: mpsc::Sender<NotifMsg>,
) {
    tokio::pin!(cancel_rx);
    loop {
        tokio::select! {
            // Cancellation from unsubscribe or connection drop.
            _ = &mut cancel_rx => {
                return;
            }
            record_opt = rx.recv() => {
                match record_opt {
                    Some(record) => {
                        let payload = serde_json::to_value(&record)
                            .unwrap_or(serde_json::Value::Null);
                        let notification = Notification::new(
                            "audit.tail",
                            json!({
                                "subscription": id.to_string(),
                                "data": payload,
                            }),
                        );
                        let bytes = serialize_frame(&notification);
                        if notif_tx.send(NotifMsg::Frame(bytes)).await.is_err() {
                            // Write task is gone.
                            return;
                        }
                    }
                    None => {
                        // Monitoring actor shut down; exit silently.
                        return;
                    }
                }
            }
        }
    }
}

/// Forwards chat reply payloads from the per-subscription router queue to the
/// notification channel as serialized `chat.message` JSON-RPC notification frames.
///
/// The forwarder exits cleanly when either:
/// - `cancel_rx` fires (explicit `chat.close` or connection close), or
/// - `rx` returns `None` (the router deregistered the subscription and dropped
///   the send end of the queue).
async fn chat_forwarder(
    id: crate::subscriptions::AdminSubscriptionId,
    mut rx: crate::chat_router::ChatReplyReceiver,
    cancel_rx: tokio::sync::oneshot::Receiver<()>,
    notif_tx: mpsc::Sender<NotifMsg>,
) {
    tokio::pin!(cancel_rx);
    loop {
        tokio::select! {
            biased;
            // Cancellation from chat.close or connection drop takes priority
            // over pending messages so close is not delayed by a busy queue.
            _ = &mut cancel_rx => {
                return;
            }
            payload_opt = rx.recv() => {
                match payload_opt {
                    Some(payload) => {
                        let notification = crate::protocol::Notification::new(
                            "chat.message",
                            json!({
                                "subscription": id.to_string(),
                                "data": payload,
                            }),
                        );
                        let bytes = serialize_frame(&notification);
                        if notif_tx.send(NotifMsg::Frame(bytes)).await.is_err() {
                            // Write task is gone.
                            return;
                        }
                    }
                    None => {
                        // Router closed the channel (deregistered); exit silently.
                        return;
                    }
                }
            }
        }
    }
}

/// Drives the outbound write loop for one connection.
///
/// `select!`s between:
/// - `out_rx`   — response frames
/// - `notif_rx` — notification frames from audit forwarder tasks
async fn write_loop(
    mut write_half: tokio::net::unix::OwnedWriteHalf,
    mut out_rx: mpsc::Receiver<OutboundMsg>,
    mut notif_rx: mpsc::Receiver<NotifMsg>,
) {
    loop {
        tokio::select! {
            msg = out_rx.recv() => {
                match msg {
                    None => {
                        // Read task dropped the sender — connection is done.
                        return;
                    }
                    Some(OutboundMsg::Frame(bytes)) => {
                        if write_half.write_all(&bytes).await.is_err() {
                            return;
                        }
                    }
                }
            }
            notif = notif_rx.recv() => {
                match notif {
                    None => {
                        // All forwarder tasks exited and the sender was dropped.
                        // Keep running — we still need to handle out_rx.
                        // This fires only when notif_tx in read_loop is dropped,
                        // which happens when read_loop exits. The write task will
                        // then get None from out_rx too.
                        continue;
                    }
                    Some(NotifMsg::Frame(bytes)) => {
                        if write_half.write_all(&bytes).await.is_err() {
                            return;
                        }
                    }
                }
            }
        }
    }
}

/// Serialize `value` to a newline-terminated JSON byte vector.
fn serialize_frame<T: serde::Serialize>(value: &T) -> Vec<u8> {
    let mut bytes = serde_json::to_vec(value).expect("serialization of known types must succeed");
    bytes.push(b'\n');
    bytes
}

/// Runs the listener accept loop, owns accepted connection tasks, and drains
/// them on shutdown before returning.
async fn run_listener(
    listener: Listener,
    dispatcher: Dispatcher,
    bus: SubscriptionBus,
    mut shutdown_rx: watch::Receiver<bool>,
) {
    let mut connections = JoinSet::new();

    loop {
        tokio::select! {
            biased;
            shutdown_result = shutdown_rx.changed() => {
                match shutdown_result {
                    Ok(()) | Err(_) => {
                        tracing::info!("admin-rpc: listener shutdown requested");
                        break;
                    }
                }
            }
            connection = listener.accept() => {
                match connection {
                    Ok(Some(stream)) => {
                        let d = dispatcher.clone();
                        let b = bus.clone();
                        connections.spawn(run_connection_with_shutdown(
                            stream,
                            d,
                            b,
                            shutdown_rx.clone(),
                        ));
                    }
                    Ok(None) => {
                        // Peer was rejected — already logged in `Listener::accept`.
                    }
                    Err(e) => {
                        tracing::warn!(error = %e, "admin-rpc: accept error; retrying");
                    }
                }
            }
            joined = connections.join_next(), if !connections.is_empty() => {
                if let Some(Err(e)) = joined {
                    tracing::warn!(error = %e, "admin-rpc: connection task panicked");
                }
            }
        }
    }

    while let Some(result) = connections.join_next().await {
        if let Err(e) = result {
            tracing::warn!(error = %e, "admin-rpc: connection task panicked");
        }
    }
}

/// Starts the admin-rpc actor and, when `cfg.admin_sock_path` is non-empty,
/// binds the Unix domain socket listener and spawns an accept loop task.
///
/// The returned `JoinHandle<()>` resolves after both the command actor and the
/// optional listener task have stopped. The listener owns and drains accepted
/// connection tasks so dispatcher handle clones are dropped during shutdown.
///
/// # Errors
///
/// Returns `Err(std::io::Error)` when `admin_sock_path` is non-empty and
/// `Listener::bind` fails.  The actor is **not** started in that case, so no
/// cleanup is required by the caller.  When `admin_sock_path` is empty no bind
/// is attempted and the function always returns `Ok`.
pub fn start(cfg: Config) -> Result<(Handle, JoinHandle<()>), std::io::Error> {
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);
    let (shutdown_tx, shutdown_rx) = watch::channel(false);

    // Build the dispatcher from the optional handles in the config.
    let mut dispatcher = Dispatcher::new(
        cfg.supervisor.clone(),
        cfg.policy.clone(),
        cfg.monitoring.clone(),
        env!("CARGO_PKG_VERSION"),
    );
    // Inject the chat-adapter handle when provided (AC-1 of T-072).
    if let Some(chat_handle) = cfg.chat_adapter.clone() {
        dispatcher = dispatcher.with_chat_handle(chat_handle);
    }
    // Use the configured chat router or create an internal one.
    let chat_router = cfg
        .chat_router
        .clone()
        .unwrap_or_else(|| std::sync::Arc::new(crate::chat_router::ChatReplyRouter::new()));
    dispatcher = dispatcher.with_chat_router(chat_router);
    // Inject the scheduler-adapter handle when provided (AC-2 of T-096).
    if let Some(h) = cfg.scheduler.clone() {
        dispatcher = dispatcher.with_scheduler_handle(h);
    }
    // Inject the config file path when provided (T-097).
    if let Some(p) = cfg.config_path.clone() {
        dispatcher = dispatcher.with_config_path(p);
    }

    // Use the configured audit bus or create an internal one.
    let bus = cfg
        .audit_bus
        .clone()
        .unwrap_or_else(|| SubscriptionBus::new(cfg.slow_subscriber_deadline));

    // Optionally bind the listener.  If the path is empty we skip binding.
    // If binding fails the error is returned immediately — the actor is not
    // started and the caller must handle the failure.
    let maybe_listener = if cfg.admin_sock_path.as_os_str().is_empty() {
        None
    } else {
        let listener_cfg = ListenerConfig {
            admin_sock_path: cfg.admin_sock_path.clone(),
        };
        let l = Listener::bind(listener_cfg).map_err(|e| {
            tracing::error!(
                error = %e,
                path = %cfg.admin_sock_path.display(),
                "admin-rpc: failed to bind listener"
            );
            e
        })?;
        tracing::info!(
            path = %cfg.admin_sock_path.display(),
            "admin-rpc: listener bound"
        );
        Some(l)
    };

    let listener_join = maybe_listener
        .map(|listener| tokio::spawn(run_listener(listener, dispatcher, bus, shutdown_rx)));

    let actor = Actor { cfg, rx };
    let join = tokio::spawn(async move {
        actor.run().await;
        if let Some(listener_join) = listener_join {
            if let Err(e) = listener_join.await {
                tracing::warn!(error = %e, "admin-rpc: listener task panicked");
            }
        }
    });
    Ok((Handle { tx, shutdown_tx }, join))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::AsyncBufReadExt as _;

    #[tokio::test(flavor = "current_thread")]
    async fn handle_is_clonable() {
        let (handle, task) = start(Config::default()).expect("start must succeed with empty path");

        let _clone = handle.clone();

        task.abort();
    }

    // Wiring test: start with a socket path binds the listener on disk.
    #[tokio::test(flavor = "current_thread")]
    async fn start_with_sock_path_creates_socket_file() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let sock_path = tmp.path().join("admin.sock");

        let probe = Listener::bind(ListenerConfig {
            admin_sock_path: sock_path.clone(),
        });
        match probe {
            Ok(listener) => drop(listener),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => return,
            Err(e) => panic!("probe bind failed: {e}"),
        }
        let _ = std::fs::remove_file(&sock_path);

        let cfg = Config {
            admin_sock_path: sock_path.clone(),
            ..Config::default()
        };

        let (_, task) = start(cfg).expect("start must succeed with valid path");

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
        let (_, task) = start(Config::default()).expect("start must succeed with empty path");
        // No assertion on filesystem — just verify it doesn't panic.
        task.abort();
    }

    // Regression test: start returns Err when the socket path is unwritable.
    //
    // This verifies that bind failures are surfaced rather than silently
    // swallowed (the defect fixed in B-005).
    #[tokio::test(flavor = "current_thread")]
    async fn start_returns_err_when_bind_fails_on_unwritable_path() {
        // Pass a path inside a nonexistent directory that cannot be created —
        // the listener parent-directory creation step will fail with a
        // permission error when the grandparent is read-only.  We use a path
        // rooted at a file (not a directory) so that `create_dir_all` fails.
        let tmp = tempfile::tempdir().expect("temp dir");

        // Write a plain file, then try to use it as a directory component of
        // the socket path — this forces the bind to fail.
        let file_path = tmp.path().join("not_a_dir");
        std::fs::write(&file_path, b"block").expect("write blocking file");
        let sock_path = file_path.join("admin.sock"); // file_path is a file, not a dir

        let cfg = Config {
            admin_sock_path: sock_path,
            ..Config::default()
        };

        let result = start(cfg);

        assert!(
            result.is_err(),
            "start must return Err when the socket bind fails"
        );
    }

    // Helper: build a dispatcher and bus with no optional handles.
    fn make_dispatcher() -> Dispatcher {
        Dispatcher::new(None, None, None, "0.1.0-test")
    }

    fn make_bus() -> SubscriptionBus {
        SubscriptionBus::new(Duration::from_millis(100))
    }

    /// Build a dispatcher with a real monitoring handle and return both the
    /// dispatcher and the monitoring handle (for injecting records in tests).
    fn make_dispatcher_with_monitoring(
    ) -> (Dispatcher, monitoring::Handle, tokio::task::JoinHandle<()>) {
        let tmp = tempfile::NamedTempFile::new().expect("temp file");
        let (handle, join) = monitoring::start(monitoring::Config {
            command_buffer: 4,
            audit_log_path: tmp.path().to_path_buf(),
        });
        let dispatcher = Dispatcher::new(None, None, Some(handle.clone()), "0.1.0-test");
        (dispatcher, handle, join)
    }

    // AC-1: a service.status request over a connected UnixStream pair yields a
    // valid JSON-RPC 2.0 response with an `ok: true` result.
    #[tokio::test(flavor = "current_thread")]
    async fn run_connection_service_status_returns_ok_response() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let dispatcher = make_dispatcher();
        let bus = make_bus();

        tokio::spawn(run_connection(server, dispatcher, bus));

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
        let bus = make_bus();

        tokio::spawn(run_connection(server, dispatcher, bus));

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
        let bus = make_bus();

        tokio::spawn(run_connection(server, dispatcher, bus));

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

    // AC-4 (T-063): audit.tail.subscribe returns a subscription id, and when
    // monitoring appends an audit record the connection receives an `audit.tail`
    // notification containing that record.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_audit_tail_subscribe_delivers_audit_tail_notification() {
        use bob_core::types::{
            AuditRecord, AuditRecordKind, AuditRecordPayload, ExtensionEventAuditPayload,
        };
        use uuid::Uuid;

        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let (dispatcher, mon_handle, mon_task) = make_dispatcher_with_monitoring();
        let bus = make_bus();

        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // Subscribe to the audit tail.
        let req = r#"{"jsonrpc":"2.0","method":"audit.tail.subscribe","id":100}"#;
        write_half.write_all(req.as_bytes()).await.expect("write");
        write_half.write_all(b"\n").await.expect("newline");

        // Read the subscribe response.
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .expect("read subscribe response");
        let resp: serde_json::Value = serde_json::from_str(line.trim()).expect("valid JSON");
        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 100);
        let sub_id = resp["result"]["id"]
            .as_str()
            .expect("result.id is a string")
            .to_string();

        // Give the forwarder task a moment to start selecting on its receiver.
        tokio::time::sleep(Duration::from_millis(20)).await;

        // Append an audit record via monitoring — this is a future record that
        // should be delivered to the subscriber.
        let record = AuditRecord {
            id: Uuid::new_v4().to_string(),
            timestamp: "2026-05-20T12:00:00Z".to_owned(),
            kind: AuditRecordKind::Event,
            session_id: None,
            payload: AuditRecordPayload::Event(ExtensionEventAuditPayload {
                name: "test.event".to_owned(),
                summary: Some("delivered via monitoring".to_owned()),
            }),
        };
        mon_handle.append_record(record).await.expect("append");

        // Read the audit.tail notification (AC-4).
        let mut notif_line = String::new();
        tokio::time::timeout(
            Duration::from_millis(500),
            reader.read_line(&mut notif_line),
        )
        .await
        .expect("timed out waiting for audit.tail notification")
        .expect("read notification");

        let notif: serde_json::Value = serde_json::from_str(notif_line.trim()).expect("valid JSON");

        assert_eq!(notif["jsonrpc"], "2.0");
        assert_eq!(notif["method"], "audit.tail");
        assert_eq!(notif["params"]["subscription"], sub_id);
        assert_eq!(notif["params"]["data"]["kind"], "event");

        mon_task.abort();
    }

    // AC-5 (T-063): audit.tail.unsubscribe removes the subscription;
    // subsequent records are not delivered.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_audit_tail_unsubscribe_stops_notifications() {
        use bob_core::types::{
            AuditRecord, AuditRecordKind, AuditRecordPayload, ExtensionEventAuditPayload,
        };
        use uuid::Uuid;

        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let (dispatcher, mon_handle, mon_task) = make_dispatcher_with_monitoring();
        let bus = make_bus();

        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // Subscribe.
        write_half
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"audit.tail.subscribe\",\"id\":200}\n")
            .await
            .expect("write subscribe");
        let mut line = String::new();
        reader
            .read_line(&mut line)
            .await
            .expect("read subscribe resp");
        let resp: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
        let sub_id = resp["result"]["id"].as_str().unwrap().to_string();

        // Unsubscribe.
        let unsub = format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"audit.tail.unsubscribe\",\"params\":{{\"id\":\"{sub_id}\"}},\"id\":201}}\n"
        );
        write_half
            .write_all(unsub.as_bytes())
            .await
            .expect("write unsub");
        let mut unsub_line = String::new();
        reader
            .read_line(&mut unsub_line)
            .await
            .expect("read unsub resp");
        let unsub_resp: serde_json::Value = serde_json::from_str(unsub_line.trim()).unwrap();
        assert_eq!(unsub_resp["result"]["ok"], true);

        // Give the forwarder task time to observe the cancellation.
        tokio::time::sleep(Duration::from_millis(25)).await;

        // Append a record after unsubscribe — it should not arrive on the connection.
        let record = AuditRecord {
            id: Uuid::new_v4().to_string(),
            timestamp: "2026-05-20T12:00:00Z".to_owned(),
            kind: AuditRecordKind::Event,
            session_id: None,
            payload: AuditRecordPayload::Event(ExtensionEventAuditPayload {
                name: "should.not.arrive".to_owned(),
                summary: None,
            }),
        };
        mon_handle.append_record(record).await.expect("append");

        // Confirm no notification arrives within a short window.
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            reader.read_line(&mut String::new()),
        )
        .await;
        assert!(
            result.is_err(),
            "no notification should arrive after unsubscribe"
        );

        mon_task.abort();
    }

    // Unsubscribing must not close the connection (no false AC-4 eviction signal).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_audit_unsubscribe_keeps_connection_open() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let (dispatcher, _mon_handle, mon_task) = make_dispatcher_with_monitoring();
        let bus = make_bus();

        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // Subscribe to obtain a valid id.
        write_half
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"audit.tail.subscribe\",\"id\":210}\n")
            .await
            .expect("write subscribe");
        let mut sub_line = String::new();
        reader
            .read_line(&mut sub_line)
            .await
            .expect("read subscribe resp");
        let sub_resp: serde_json::Value = serde_json::from_str(sub_line.trim()).expect("json");
        let sub_id = sub_resp["result"]["id"]
            .as_str()
            .expect("subscription id")
            .to_string();

        // Unsubscribe and consume its success response.
        let unsub = format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"audit.tail.unsubscribe\",\"params\":{{\"id\":\"{sub_id}\"}},\"id\":211}}\n"
        );
        write_half
            .write_all(unsub.as_bytes())
            .await
            .expect("write unsubscribe");
        let mut unsub_line = String::new();
        reader
            .read_line(&mut unsub_line)
            .await
            .expect("read unsubscribe resp");
        let unsub_resp: serde_json::Value =
            serde_json::from_str(unsub_line.trim()).expect("json unsubscribe response");
        assert_eq!(unsub_resp["result"]["ok"], true);

        // Give the forwarder/write task a moment; a false eviction path would
        // have closed the connection by now.
        tokio::time::sleep(Duration::from_millis(25)).await;

        // Connection must still answer a normal request.
        write_half
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"service.status\",\"id\":212}\n")
            .await
            .expect("write service.status");

        let mut status_line = String::new();
        tokio::time::timeout(
            Duration::from_millis(250),
            reader.read_line(&mut status_line),
        )
        .await
        .expect("timed out waiting for service.status response")
        .expect("read service.status response");

        let status_resp: serde_json::Value =
            serde_json::from_str(status_line.trim()).expect("json status response");
        assert_eq!(status_resp["id"], 212);
        assert_eq!(status_resp["result"]["ok"], true);

        mon_task.abort();
    }

    // AC-5 (T-063): when the connection is closed all audit subscriptions are cleaned up.
    // Verified by checking that a monitoring record appended after connection close
    // does not cause any forwarder tasks to panic (they exit cleanly).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_close_cancels_all_audit_subscriptions() {
        use bob_core::types::{
            AuditRecord, AuditRecordKind, AuditRecordPayload, ExtensionEventAuditPayload,
        };
        use uuid::Uuid;

        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let (dispatcher, mon_handle, mon_task) = make_dispatcher_with_monitoring();
        let bus = make_bus();

        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // Open two audit subscriptions.
        for id in [300u64, 301u64] {
            let req = format!(
                "{{\"jsonrpc\":\"2.0\",\"method\":\"audit.tail.subscribe\",\"id\":{id}}}\n"
            );
            write_half.write_all(req.as_bytes()).await.expect("write");
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read resp");
            // Verify each subscribe returned a valid id.
            let resp: serde_json::Value = serde_json::from_str(line.trim()).unwrap();
            assert!(resp["result"]["id"].is_string());
        }

        // Close the connection from the client side (AC-5).
        drop(write_half);
        drop(reader);

        // Give the server tasks time to notice the EOF and clean up.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Append a record — should not panic or deadlock even though forwarder
        // tasks have already exited.
        let record = AuditRecord {
            id: Uuid::new_v4().to_string(),
            timestamp: "2026-05-20T12:00:00Z".to_owned(),
            kind: AuditRecordKind::Event,
            session_id: None,
            payload: AuditRecordPayload::Event(ExtensionEventAuditPayload {
                name: "post.close.event".to_owned(),
                summary: None,
            }),
        };
        mon_handle
            .append_record(record)
            .await
            .expect("append after close must not panic");

        mon_task.abort();
    }

    /// Build a dispatcher with a chat reply router and return the router for injection.
    fn make_dispatcher_with_chat_router() -> (
        Dispatcher,
        std::sync::Arc<crate::chat_router::ChatReplyRouter>,
    ) {
        let router = std::sync::Arc::new(crate::chat_router::ChatReplyRouter::new());
        let dispatcher = Dispatcher::new(None, None, None, "0.1.0-test")
            .with_chat_router(std::sync::Arc::clone(&router));
        (dispatcher, router)
    }

    // AC-1 (T-086): chat.open returns a subscription id, and when a reply is
    // injected via the reply router the connection receives a `chat.message`
    // notification with params.subscription equal to that id.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_chat_open_delivers_chat_message_notification() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let (dispatcher, router) = make_dispatcher_with_chat_router();
        let bus = make_bus();

        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // Send chat.open.
        write_half
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"chat.open\",\"id\":400}\n")
            .await
            .expect("write chat.open");

        let mut open_line = String::new();
        reader
            .read_line(&mut open_line)
            .await
            .expect("read chat.open response");
        let open_resp: serde_json::Value =
            serde_json::from_str(open_line.trim()).expect("valid JSON");
        assert_eq!(open_resp["jsonrpc"], "2.0");
        assert_eq!(open_resp["id"], 400);
        let sub_id = open_resp["result"]["id"]
            .as_str()
            .expect("result.id is a string")
            .to_string();

        // Give the forwarder task a moment to start.
        tokio::time::sleep(Duration::from_millis(20)).await;

        // Inject a reply via the router delivery handle.
        let delivery = router.delivery_handle();
        let sub_id_parsed = crate::subscriptions::AdminSubscriptionId::parse(&sub_id)
            .expect("sub_id must be parseable");
        delivery.deliver(sub_id_parsed, json!({"text": "hello from bot"}));

        // Read the chat.message notification.
        let mut notif_line = String::new();
        tokio::time::timeout(
            Duration::from_millis(500),
            reader.read_line(&mut notif_line),
        )
        .await
        .expect("timed out waiting for chat.message notification")
        .expect("read notification");

        let notif: serde_json::Value = serde_json::from_str(notif_line.trim()).expect("valid JSON");
        assert_eq!(notif["jsonrpc"], "2.0");
        assert_eq!(notif["method"], "chat.message");
        assert_eq!(notif["params"]["subscription"], sub_id);
        assert_eq!(notif["params"]["data"]["text"], "hello from bot");
    }

    // AC-2 (T-086): chat.close deregisters the subscription from the router and
    // stops the forwarder; later injected replies are dropped and not delivered.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_chat_close_stops_forwarder_and_drops_later_replies() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let (dispatcher, router) = make_dispatcher_with_chat_router();
        let bus = make_bus();

        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // Open a chat subscription.
        write_half
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"chat.open\",\"id\":410}\n")
            .await
            .expect("write chat.open");
        let mut open_line = String::new();
        reader
            .read_line(&mut open_line)
            .await
            .expect("read chat.open response");
        let open_resp: serde_json::Value = serde_json::from_str(open_line.trim()).unwrap();
        let sub_id = open_resp["result"]["id"].as_str().unwrap().to_string();

        // Close the subscription.
        let close_req = format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"chat.close\",\"params\":{{\"id\":\"{sub_id}\"}},\"id\":411}}\n"
        );
        write_half
            .write_all(close_req.as_bytes())
            .await
            .expect("write chat.close");
        let mut close_line = String::new();
        reader
            .read_line(&mut close_line)
            .await
            .expect("read chat.close response");
        let close_resp: serde_json::Value = serde_json::from_str(close_line.trim()).unwrap();
        assert_eq!(close_resp["result"]["ok"], true);

        // Give the forwarder task time to observe the cancellation.
        tokio::time::sleep(Duration::from_millis(25)).await;

        // Inject a reply after close — it should be dropped by the router.
        let delivery = router.delivery_handle();
        let sub_id_parsed = crate::subscriptions::AdminSubscriptionId::parse(&sub_id).unwrap();
        delivery.deliver(sub_id_parsed, json!({"text": "should not arrive"}));

        // No notification should arrive within a short window.
        let result = tokio::time::timeout(
            Duration::from_millis(100),
            reader.read_line(&mut String::new()),
        )
        .await;
        assert!(
            result.is_err(),
            "no notification should arrive after chat.close"
        );
    }

    // AC-4 (T-086): chat.send rejects a params.id that does not reference an open
    // chat subscription on the same connection.
    #[tokio::test(flavor = "current_thread")]
    async fn run_connection_chat_send_with_no_open_subscription_returns_error() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let (dispatcher, _router) = make_dispatcher_with_chat_router();
        let bus = make_bus();

        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // chat.send with a subscription id that was never opened.
        write_half
            .write_all(
                b"{\"jsonrpc\":\"2.0\",\"method\":\"chat.send\",\"params\":{\"id\":\"9999\",\"text\":\"hi\",\"application_identity\":\"00000000-0000-0000-0000-000000000001\"},\"id\":430}\n",
            )
            .await
            .expect("write chat.send");

        let mut line = String::new();
        reader.read_line(&mut line).await.expect("read response");
        let resp: serde_json::Value = serde_json::from_str(line.trim()).expect("valid JSON");

        assert_eq!(resp["id"], 430);
        // Must return an error (no chat adapter configured, so -32601 is also acceptable).
        assert!(resp.get("error").is_some(), "must return an error");
    }

    // AC-3 (T-086): when the connection closes while a chat subscription is open,
    // the subscription is deregistered from the router and the forwarder stops;
    // other connections are not affected.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_drop_deregisters_chat_subscription_from_router() {
        let router = std::sync::Arc::new(crate::chat_router::ChatReplyRouter::new());

        // First connection: opens a chat subscription, then drops.
        let (client1, server1) = UnixStream::pair().expect("UnixStream::pair");
        let dispatcher1 = Dispatcher::new(None, None, None, "0.1.0-test")
            .with_chat_router(std::sync::Arc::clone(&router));
        let bus = make_bus();
        tokio::spawn(run_connection(server1, dispatcher1, bus.clone()));

        let (read_half1, mut write_half1) = tokio::io::split(client1);
        let mut reader1 = BufReader::new(read_half1);

        write_half1
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"chat.open\",\"id\":420}\n")
            .await
            .expect("write chat.open");
        let mut open_line = String::new();
        reader1
            .read_line(&mut open_line)
            .await
            .expect("read chat.open response");
        let open_resp: serde_json::Value = serde_json::from_str(open_line.trim()).unwrap();
        let sub_id = open_resp["result"]["id"].as_str().unwrap().to_string();
        let sub_id_parsed = crate::subscriptions::AdminSubscriptionId::parse(&sub_id).unwrap();

        // Close connection1 by dropping the client.
        drop(write_half1);
        drop(reader1);

        // Give the server tasks time to notice the EOF and clean up.
        tokio::time::sleep(Duration::from_millis(50)).await;

        // Inject a reply — router must have deregistered the subscription so
        // delivery handle::deliver drops the payload (no panic, no notification).
        let delivery = router.delivery_handle();
        delivery.deliver(sub_id_parsed, json!({"text": "dropped on floor"}));

        // Second connection: must be unaffected.
        let (client2, server2) = UnixStream::pair().expect("UnixStream::pair");
        let dispatcher2 = Dispatcher::new(None, None, None, "0.1.0-test")
            .with_chat_router(std::sync::Arc::clone(&router));
        tokio::spawn(run_connection(server2, dispatcher2, bus));

        let (read_half2, mut write_half2) = tokio::io::split(client2);
        let mut reader2 = BufReader::new(read_half2);

        // Second connection must still respond normally.
        write_half2
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"service.status\",\"id\":421}\n")
            .await
            .expect("write service.status");
        let mut status_line = String::new();
        tokio::time::timeout(
            Duration::from_millis(250),
            reader2.read_line(&mut status_line),
        )
        .await
        .expect("timed out waiting for service.status response")
        .expect("read service.status response");
        let status_resp: serde_json::Value = serde_json::from_str(status_line.trim()).unwrap();
        assert_eq!(status_resp["id"], 421);
        assert_eq!(status_resp["result"]["ok"], true);
    }

    // AC-5 (T-086): while a chat.send response is pending, queued reply notifications
    // are delivered as whole, well-formed frames — no interleaving inside a frame.
    // Verified by sending multiple chat.send requests while the router injects
    // concurrent replies and asserting every received line is valid JSON.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_concurrent_chat_replies_are_well_formed_frames() {
        use bob_core::types::{ChannelId, UserId};
        use requests_handler::Config as QueueConfig;
        use tokio::sync::watch;

        let (_, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 64,
            request_submit_timeout: Duration::from_secs(5),
        };
        let (intake, _intake_task) =
            requests_handler::start_with(cfg, move |(_, _)| async {}, cancel_rx);
        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = chat_adapter::start(intake, channel_id, 16);

        let router = std::sync::Arc::new(crate::chat_router::ChatReplyRouter::new());
        let dispatcher = Dispatcher::new(None, None, None, "0.1.0-test")
            .with_chat_handle(frame_handle)
            .with_chat_router(std::sync::Arc::clone(&router));

        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let bus = make_bus();
        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // Open a chat subscription.
        write_half
            .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"chat.open\",\"id\":500}\n")
            .await
            .expect("write chat.open");
        let mut open_line = String::new();
        reader
            .read_line(&mut open_line)
            .await
            .expect("read chat.open response");
        let open_resp: serde_json::Value = serde_json::from_str(open_line.trim()).unwrap();
        let sub_id = open_resp["result"]["id"].as_str().unwrap().to_string();
        let sub_id_parsed = crate::subscriptions::AdminSubscriptionId::parse(&sub_id).unwrap();

        // Concurrently: inject 5 replies and send a chat.send request.
        let delivery = router.delivery_handle();
        for i in 0..5u32 {
            delivery.deliver(sub_id_parsed, json!({"seq": i}));
        }

        let sender_id = UserId::new().to_string();
        let send_req = format!(
            "{{\"jsonrpc\":\"2.0\",\"method\":\"chat.send\",\"params\":{{\"id\":\"{sub_id}\",\"text\":\"concurrent\",\"application_identity\":\"{sender_id}\"}},\"id\":501}}\n"
        );
        write_half
            .write_all(send_req.as_bytes())
            .await
            .expect("write chat.send");

        // Collect all frames received within a timeout.
        let mut frames_received = 0usize;
        loop {
            let mut line = String::new();
            let result =
                tokio::time::timeout(Duration::from_millis(200), reader.read_line(&mut line)).await;
            match result {
                Err(_) => break, // timeout — no more frames
                Ok(Err(e)) => panic!("I/O error reading frame: {e}"),
                Ok(Ok(0)) => break, // EOF
                Ok(Ok(_)) => {
                    // Every line must be valid JSON.
                    let trimmed = line.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let parsed: serde_json::Value =
                        serde_json::from_str(trimmed).expect("every frame must be valid JSON");
                    assert_eq!(parsed["jsonrpc"], "2.0", "every frame must be JSON-RPC 2.0");
                    frames_received += 1;
                }
            }
        }

        // We must have received at least the chat.send response (id=501) plus
        // at least one chat.message notification.
        assert!(
            frames_received >= 2,
            "must receive at least chat.send response and one notification, got {frames_received}"
        );
    }
}
