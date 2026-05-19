#![forbid(unsafe_code)]

pub mod dispatch;
pub mod listener;
pub mod peer_cred;
pub mod protocol;
pub mod subscriptions;

use std::{path::PathBuf, time::Duration};

use bob_core::error::{ServiceError, ServiceResult};
use serde_json::json;
use tokio::{
    io::{AsyncWriteExt as _, BufReader},
    net::UnixStream,
    sync::mpsc,
    task::JoinHandle,
};

use crate::{
    dispatch::{DispatchOutcome, Dispatcher},
    listener::{Listener, ListenerConfig},
    protocol::{read_frame, ErrorResponse, FrameRead, Notification},
    subscriptions::{AuditRecord, ConnectionRegistry, SubscriptionBus, SubscriptionId},
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
    /// Optional audit subscription bus.  When `None`, `audit.tail.subscribe`
    /// still registers subscriptions but no audit events will be delivered.
    pub audit_bus: Option<SubscriptionBus>,
    /// Maximum time the write task waits for a slow subscriber's send before
    /// dropping its subscription.
    pub slow_subscriber_deadline: Duration,
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
            audit_bus: None,
            slow_subscriber_deadline: Duration::from_secs(5),
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

// ── Connection concurrency model ──────────────────────────────────────────────
//
// Each connection runs two cooperating halves:
//
//   Read half  — runs in the calling task; reads frames, dispatches them, and
//                sends outbound messages via `out_tx`:
//                  · serialised JSON frames (responses)
//                  · subscription control (AddAuditRx / RemoveAuditRx)
//
//   Write half — runs in a spawned task; it `select!`s between:
//                  · `out_rx`    — response frames and control messages
//                  · `notif_rx`  — notification bytes from subscription
//                                  forwarder sub-tasks
//
//   For each active audit subscription, a lightweight forwarder task reads
//   from the bounded mpsc::Receiver<AuditRecord> and pushes serialised
//   notification bytes onto `notif_rx`.  When the sender is dropped by the
//   bus (AC-4 slow-subscriber), the forwarder detects it and sends a sentinel
//   that causes the write task to close the connection.

/// A frame sent from the read task to the write task.
enum OutboundMsg {
    /// A complete JSON frame (already serialized with trailing `\n`).
    Frame(Vec<u8>),
}

/// Forwarded from a subscription forwarder to the write task.
enum NotifMsg {
    /// A serialized notification frame to write to the client.
    Frame(Vec<u8>),
    /// The subscription sender was dropped (bus removed it — AC-4).
    Dropped { id: SubscriptionId },
}

/// Handle one accepted connection: read JSON-RPC 2.0 frames, dispatch each
/// to the method registry, and write responses and subscription notifications back.
///
/// The read and write halves run concurrently so that inbound requests and
/// outbound notifications (from `audit.tail` subscriptions) do not block each
/// other.
///
/// AC-4: if a subscription receiver's sender is dropped (bus evicted it for
/// being slow) the write task closes the connection after logging a warning.
/// AC-5: when the connection closes, all subscriptions registered on it are
/// removed from the bus without leaking entries (via `ConnectionRegistry::drop`).
async fn run_connection(stream: UnixStream, dispatcher: Dispatcher, bus: SubscriptionBus) {
    let (read_half, write_half) = stream.into_split();
    let reader = BufReader::new(read_half);

    // Control channel: read task → write task.
    let (out_tx, out_rx) = mpsc::channel::<OutboundMsg>(64);
    // Notification channel: forwarder tasks → write task.
    let (notif_tx, notif_rx) = mpsc::channel::<NotifMsg>(64);

    let registry = ConnectionRegistry::new(bus.clone());

    // Spawn the write task first so it is ready to receive messages.
    let write_task = tokio::spawn(write_loop(write_half, out_rx, notif_rx));

    // Run the read loop in the current task. `registry` drops at the end of
    // this scope, which calls Drop and removes all subscriptions (AC-5).
    read_loop(reader, dispatcher, registry, bus, out_tx, notif_tx).await;

    // Wait for the write task to flush and exit.
    write_task.await.ok();
}

/// Drives the inbound frame loop for one connection.
async fn read_loop(
    mut reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    dispatcher: Dispatcher,
    mut registry: ConnectionRegistry,
    bus: SubscriptionBus,
    out_tx: mpsc::Sender<OutboundMsg>,
    notif_tx: mpsc::Sender<NotifMsg>,
) {
    loop {
        match read_frame(&mut reader).await {
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
                    DispatchOutcome::Subscribed { response, id, rx } => {
                        // Send the response frame first.
                        if out_tx
                            .send(OutboundMsg::Frame(serialize_frame(&response)))
                            .await
                            .is_err()
                        {
                            break;
                        }
                        // Spawn a forwarder task that delivers audit records to the
                        // write task via the notification channel.
                        let ntx = notif_tx.clone();
                        let bus_for_forwarder = bus.clone();
                        tokio::spawn(audit_forwarder(id, rx, bus_for_forwarder, ntx));
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
    // AC-5: `registry` drops here, removing all subscriptions from the bus.
}

/// Forwards `AuditRecord`s from one subscription receiver to the notification
/// channel as serialized `audit.event` frames.
///
/// When the sender is dropped (bus evicted the subscriber — AC-4), sends a
/// `NotifMsg::Dropped` sentinel and exits.
async fn audit_forwarder(
    id: SubscriptionId,
    mut rx: mpsc::Receiver<AuditRecord>,
    bus: SubscriptionBus,
    notif_tx: mpsc::Sender<NotifMsg>,
) {
    loop {
        match rx.recv().await {
            Some(record) => {
                let notification = Notification::new(
                    "audit.event",
                    json!({
                        "subscription": id.to_string(),
                        "data": record.payload,
                    }),
                );
                let bytes = serialize_frame(&notification);
                if notif_tx.send(NotifMsg::Frame(bytes)).await.is_err() {
                    // Write task is gone.
                    return;
                }
            }
            None => {
                // Differentiate AC-4 slow eviction from normal unsubscribe
                // or connection cleanup, which also close the receiver.
                if bus.take_slow_evicted(id) {
                    let _ = notif_tx.send(NotifMsg::Dropped { id }).await;
                }
                return;
            }
        }
    }
}

/// Drives the outbound write loop for one connection.
///
/// `select!`s between:
/// - `out_rx`   — response frames and subscription control messages
/// - `notif_rx` — notification frames and drop sentinels from forwarder tasks
///
/// AC-4: when `NotifMsg::Dropped` arrives, the write loop exits, closing
/// the connection.
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
                        // Keep running — we still need to handle the out_rx.
                        // This branch fires only when notif_tx in read_loop is dropped.
                        // That happens when read_loop exits. The write task will
                        // then get None from out_rx too.
                        continue;
                    }
                    Some(NotifMsg::Frame(bytes)) => {
                        if write_half.write_all(&bytes).await.is_err() {
                            return;
                        }
                    }
                    Some(NotifMsg::Dropped { id }) => {
                        // AC-4: a subscription was dropped by the bus.
                        // Close the connection.
                        tracing::warn!(
                            subscription_id = %id,
                            "closing connection: audit subscription queue was full"
                        );
                        return;
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

/// Runs the listener accept loop and dispatches each accepted connection to
/// [`run_connection`] in a spawned task.
async fn run_listener(listener: Listener, dispatcher: Dispatcher, bus: SubscriptionBus) {
    loop {
        match listener.accept().await {
            Ok(Some(stream)) => {
                let d = dispatcher.clone();
                let b = bus.clone();
                tokio::spawn(run_connection(stream, d, b));
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
/// # Errors
///
/// Returns `Err(std::io::Error)` when `admin_sock_path` is non-empty and
/// `Listener::bind` fails.  The actor is **not** started in that case, so no
/// cleanup is required by the caller.  When `admin_sock_path` is empty no bind
/// is attempted and the function always returns `Ok`.
pub fn start(cfg: Config) -> Result<(Handle, JoinHandle<()>), std::io::Error> {
    let buffer = cfg.command_buffer.max(1);
    let (tx, rx) = mpsc::channel(buffer);

    // Build the dispatcher from the optional handles in the config.
    let dispatcher = Dispatcher::new(
        cfg.supervisor.clone(),
        cfg.policy.clone(),
        env!("CARGO_PKG_VERSION"),
    );

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
            admin_allowed_uids: cfg.admin_allowed_uids.clone(),
            service_uid: cfg.service_uid,
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

    if let Some(listener) = maybe_listener {
        tokio::spawn(run_listener(listener, dispatcher, bus));
    }

    let actor = Actor { cfg, rx };
    let join = tokio::spawn(async move {
        actor.run().await;
    });
    Ok((Handle { tx }, join))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::AsyncBufReadExt as _;

    #[tokio::test(flavor = "current_thread")]
    async fn handle_ping_returns_not_implemented() {
        let (handle, task) = start(Config::default()).expect("start must succeed with empty path");

        let result = handle.ping().await;

        assert!(matches!(result, Err(ServiceError::NotImplemented)));
        task.abort();
    }

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
        Dispatcher::new(None, None, "0.1.0-test")
    }

    fn make_bus() -> SubscriptionBus {
        SubscriptionBus::new(Duration::from_millis(100))
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

    // AC-1 / AC-2: audit.tail.subscribe returns a subscription id, and when
    // the bus publishes an audit record the connection receives an audit.event
    // notification containing that subscription id.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_audit_subscribe_delivers_notification() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let dispatcher = make_dispatcher();
        let bus = make_bus();
        let bus_clone = bus.clone();

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

        // Wait until the bus has at least one subscriber registered.
        // The forwarder task spawned from the connection may not yet be
        // polling the receiver.
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while bus_clone.subscriber_count() == 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert!(
            bus_clone.subscriber_count() > 0,
            "bus must have a subscriber before publishing"
        );

        // Publish an audit record via the bus.
        bus_clone.publish(AuditRecord {
            payload: json!({ "event": "test.event" }),
        });

        // Read the audit.event notification.
        let mut notif_line = String::new();
        reader
            .read_line(&mut notif_line)
            .await
            .expect("read notification");
        let notif: serde_json::Value = serde_json::from_str(notif_line.trim()).expect("valid JSON");

        assert_eq!(notif["jsonrpc"], "2.0");
        assert_eq!(notif["method"], "audit.event");
        assert_eq!(notif["params"]["subscription"], sub_id);
        assert_eq!(notif["params"]["data"]["event"], "test.event");
    }

    // AC-3: audit.tail.unsubscribe removes the subscription; no more notifications.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_audit_unsubscribe_stops_notifications() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let dispatcher = make_dispatcher();
        let bus = make_bus();
        let bus_clone = bus.clone();

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

        // Wait for subscriber to be registered.
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while bus_clone.subscriber_count() == 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

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

        // Wait for unsubscription to take effect.
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while bus_clone.subscriber_count() > 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        // Publish after unsubscribe — subscriber count must be 0.
        bus_clone.publish(AuditRecord {
            payload: json!({ "event": "should.not.arrive" }),
        });
        assert_eq!(bus_clone.subscriber_count(), 0);
    }

    // Unsubscribing must not be treated as AC-4 slow-subscriber eviction:
    // the connection must remain open for subsequent requests.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_audit_unsubscribe_keeps_connection_open() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let dispatcher = make_dispatcher();
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

        // Give the forwarder/write task a moment; a false AC-4 path would have
        // closed the connection by now.
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
    }

    // AC-5: when the connection is closed all subscriptions are cleaned up.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_close_removes_all_subscriptions() {
        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let dispatcher = make_dispatcher();
        let bus = make_bus();
        let bus_clone = bus.clone();

        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = BufReader::new(read_half);

        // Open two subscriptions.
        for id in [300u64, 301u64] {
            let req = format!(
                "{{\"jsonrpc\":\"2.0\",\"method\":\"audit.tail.subscribe\",\"id\":{id}}}\n"
            );
            write_half.write_all(req.as_bytes()).await.expect("write");
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read resp");
        }

        // Wait for both subscribers to register.
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while bus_clone.subscriber_count() < 2 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(bus_clone.subscriber_count(), 2);

        // Close the connection from the client side.
        drop(write_half);
        drop(reader);

        // Give the server tasks time to notice the EOF and clean up.
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        while bus_clone.subscriber_count() > 0 && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }

        assert_eq!(
            bus_clone.subscriber_count(),
            0,
            "all subscriptions must be removed when the connection closes"
        );
    }
}
