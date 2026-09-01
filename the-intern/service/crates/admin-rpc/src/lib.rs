// admin-rpc allows unsafe code in the fd-passing helper function only
// (receive_interactive_fds). All other code in this crate uses no unsafe code.
// The workspace lint is set to "deny" so unsafe elsewhere is still denied;
// only the targeted #[allow(unsafe_code)] site uses it.

pub mod dispatch;
pub mod listener;
pub mod peer_cred;
pub mod protocol;
pub mod subscriptions;

use std::{
    io,
    os::fd::{AsRawFd as _, FromRawFd as _, RawFd},
    os::unix::io::OwnedFd,
    path::PathBuf,
    time::Duration,
};

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
    /// Optional scheduler-adapter reload handle.
    ///
    /// When `Some`, `schedule.*` methods (T-097) can push updated job tables to
    /// the scheduler actor.  When `None` (the default), `schedule.*` methods
    /// return `-32601 Method not found`.
    pub scheduler: Option<scheduler_adapter::ReloadHandle>,
    /// Optional path to the JSON schedule store (`schedules.json`, ADR-012).
    ///
    /// Required for `schedule.add`, `schedule.remove`, and `schedule.reload`
    /// to persist changes.  When `None` (the default), those methods return
    /// `-32601 Method not found`.
    pub schedule_store_path: Option<std::path::PathBuf>,
    /// Effective uid of the trusted service principal (ADR-012 / ADR-005).
    ///
    /// When `Some`, schedule reads verify the store is inside the Unix trust
    /// boundary before trusting it and writes enforce an owner-only parent
    /// directory. When `None` (the default), the trust-boundary checks are
    /// skipped.
    pub schedule_store_uid: Option<u32>,
    /// Configuration for spawning interactive pi sessions (T-105 / ADR-011).
    ///
    /// When `Some`, `session.interactive.open` uses these values to spawn the
    /// child process.  When `None` (the default), the built-in defaults are used:
    /// command `"pi"`, no extra args, 10-second deadline, and the current process
    /// executable as the extension path (the latter is overridden in production by
    /// the real `bob.ts` extension path).
    pub interactive_session: Option<InteractiveSessionConfig>,
    /// Version string reported by the `service.status` RPC.
    ///
    /// Defaults to this crate's compile-time `CARGO_PKG_VERSION`. `bob serve`
    /// overrides it with the binary's release version (`APP_VERSION`, derived
    /// from the release tag in `bob/build.rs`) so that `service.status` and
    /// `bob --version` report the same value.
    pub version: &'static str,
}

/// Spawn parameters used by `session.interactive.open` (T-105 / ADR-011).
///
/// These mirror the subset of `pi_agent_supervisor::Config` that applies to
/// interactive (non-RPC) pi sessions.  All fields are required when the struct
/// is provided.
#[derive(Clone, Debug)]
pub struct InteractiveSessionConfig {
    /// The pi command to execute (e.g. `"pi"`).
    pub command: String,
    /// Arguments passed to pi (empty for default interactive mode).
    pub args: Vec<String>,
    /// Maximum time to wait for the child to exit after SIGTERM before SIGKILL.
    pub child_termination_deadline: Duration,
    /// Absolute path to the extension socket set as `BOB_EXTENSION_SOCK_PATH`.
    /// Pass an empty `PathBuf` to leave the variable unset.
    pub extension_sock_path: PathBuf,
    /// Resolved path to the pi extension file passed as `--extension <path>`.
    pub extension_path: PathBuf,
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
            scheduler: None,
            schedule_store_path: None,
            schedule_store_uid: None,
            interactive_session: None,
            version: env!("CARGO_PKG_VERSION"),
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

    // Build the per-connection registry.
    let registry = ConnectionRegistry::new();

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
///
/// Tracks an optional active interactive session (`active_interactive`).
/// When the connection closes (EOF, parse error, I/O error, or shutdown),
/// the loop calls `supervisor.kill_session(session_id)` to terminate the
/// pi process (AC-3).
async fn read_loop(
    shutdown_rx: &mut watch::Receiver<bool>,
    mut reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    dispatcher: Dispatcher,
    mut registry: ConnectionRegistry,
    out_tx: mpsc::Sender<OutboundMsg>,
    notif_tx: mpsc::Sender<NotifMsg>,
) {
    // AC-3: track the session_id of any active interactive session opened on
    // this connection so it can be killed when the connection closes.
    let mut active_interactive: Option<(bob_core::types::SessionId, pi_agent_supervisor::Handle)> =
        None;

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
                    // AC-1 / ADR-011: receive terminal fds via SCM_RIGHTS, start
                    // interactive pi session, set up AC-2 exit watcher.
                    DispatchOutcome::InteractiveSessionOpening {
                        id,
                        session_id,
                        cwd,
                    } => {
                        handle_interactive_session_opening(
                            id,
                            session_id,
                            cwd,
                            &reader,
                            &dispatcher,
                            &out_tx,
                            &notif_tx,
                            &mut active_interactive,
                        )
                        .await
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

    // AC-3: terminate the interactive pi session when the client disconnects.
    if let Some((session_id, supervisor)) = active_interactive.take() {
        tracing::debug!(
            session_id = %session_id,
            "admin-rpc: client disconnected; terminating interactive session (AC-3)"
        );
        if let Err(e) = supervisor.kill_session(session_id).await {
            tracing::debug!(
                error = ?e,
                session_id = %session_id,
                "admin-rpc: kill_session on client disconnect returned error (session may have already exited)"
            );
        }
    }

    // `registry` drops here, cancelling all audit subscriptions and
    // removing all chat subscriptions from the bus.
}

/// Handles the `InteractiveSessionOpening` dispatch outcome.
///
/// 1. Reads three file descriptors from the socket via `SCM_RIGHTS` (ADR-011).
/// 2. Calls `supervisor.start_interactive_session` with those fds (AC-1).
/// 3. Sends a JSON-RPC success (or error) response.
/// 4. If successful, spawns an exit-watcher task that sends a
///    `session.interactive.exited` notification when pi exits (AC-2).
/// 5. Records the session in `active_interactive` for cleanup on disconnect
///    (AC-3 handled by the caller on `read_loop` exit).
///
/// Returns `true` to continue the connection loop, `false` to close it.
async fn handle_interactive_session_opening(
    id: serde_json::Value,
    session_id: bob_core::types::SessionId,
    cwd: Option<PathBuf>,
    reader: &BufReader<tokio::net::unix::OwnedReadHalf>,
    dispatcher: &Dispatcher,
    out_tx: &mpsc::Sender<OutboundMsg>,
    notif_tx: &mpsc::Sender<NotifMsg>,
    active_interactive: &mut Option<(bob_core::types::SessionId, pi_agent_supervisor::Handle)>,
) -> bool {
    use crate::dispatch::map_service_error;
    use crate::protocol::{ErrorResponse, Response, CODE_METHOD_NOT_FOUND};

    // Get supervisor handle (guaranteed present — dispatch would have returned
    // Err(-32601) if supervisor was None).
    let supervisor = match dispatcher.supervisor_handle() {
        Some(h) => h,
        None => {
            let err = ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "session.interactive.open: supervisor not available",
                Some(serde_json::json!({ "method": "session.interactive.open" })),
            );
            return out_tx
                .send(OutboundMsg::Frame(serialize_frame(&err)))
                .await
                .is_ok();
        }
    };

    // Get the raw socket fd from the read half so we can call recvmsg on it.
    // OwnedReadHalf implements AsRef<UnixStream>, and UnixStream implements AsRawFd.
    let raw_fd: RawFd = reader.get_ref().as_ref().as_raw_fd();

    // Send "await_fds" notification BEFORE calling recvmsg.
    //
    // This is a mandatory synchronisation step to prevent a BufReader
    // read-ahead race.  BufReader uses plain `read()` (not `recvmsg`), which
    // discards ancillary data.  If the client sends the SCM_RIGHTS message
    // before the server calls `recvmsg`, BufReader's next internal `read()`
    // would consume the anchor byte and silently discard the fds.
    //
    // By sending this notification first the server gives the client a signal
    // to send its fds only after the server has stopped using BufReader (i.e.
    // is blocked in `spawn_blocking`/`recvmsg`).  The client MUST read this
    // notification before calling `sendmsg`.
    let await_notif = crate::protocol::Notification::new(
        "session.interactive.await_fds",
        serde_json::json!({ "session_id": session_id.to_string() }),
    );
    if out_tx
        .send(OutboundMsg::Frame(serialize_frame(&await_notif)))
        .await
        .is_err()
    {
        return false;
    }

    // Receive the 3 terminal fds via SCM_RIGHTS (ADR-011 mechanism A).
    // `recvmsg` is a blocking syscall, so we offload it to a blocking thread
    // pool to avoid stalling the async runtime.
    //
    // The client MUST read the `session.interactive.await_fds` notification
    // above before sending the SCM_RIGHTS message to guarantee that no
    // BufReader read() has consumed the anchor byte.
    let fd_result = tokio::task::spawn_blocking(move || receive_interactive_fds(raw_fd))
        .await
        .unwrap_or_else(|e| Err(io::Error::new(io::ErrorKind::Other, e.to_string())));

    let [stdin_fd, stdout_fd, stderr_fd] = match fd_result {
        Ok(fds) => fds,
        Err(e) => {
            tracing::warn!(error = %e, "admin-rpc: failed to receive SCM_RIGHTS fds");
            let err = ErrorResponse::error(
                id,
                crate::protocol::CODE_INVALID_REQUEST,
                "session.interactive.open: failed to receive stdio file descriptors",
                Some(serde_json::json!({
                    "category": "fd_receive_error",
                    "reason": e.to_string(),
                })),
            );
            return out_tx
                .send(OutboundMsg::Frame(serialize_frame(&err)))
                .await
                .is_ok();
        }
    };

    // Retrieve spawn parameters from the dispatcher config, falling back to
    // production defaults (command "pi", no extra args, 10-second deadline).
    let interactive_cfg =
        dispatcher
            .interactive_session_config()
            .unwrap_or_else(|| InteractiveSessionConfig {
                command: "pi".to_string(),
                args: Vec::new(),
                child_termination_deadline: Duration::from_secs(10),
                extension_sock_path: PathBuf::new(),
                extension_path: std::env::current_exe().unwrap_or_default(),
            });

    // AC-1: start the supervised interactive pi session.
    //
    // `cwd` is the bob chat invocation cwd parsed from params.cwd (CR-005 /
    // B-021) — it takes precedence over the static InteractiveSessionConfig,
    // which has no cwd concept of its own. `pi_agent_cwd` is never consulted
    // on this path (CR-005).
    let result = supervisor
        .start_interactive_session(
            interactive_cfg.command,
            interactive_cfg.args,
            interactive_cfg.child_termination_deadline,
            session_id,
            interactive_cfg.extension_sock_path,
            interactive_cfg.extension_path,
            cwd,
            stdin_fd,
            stdout_fd,
            stderr_fd,
        )
        .await;

    match result {
        Ok(started_id) => {
            tracing::debug!(
                session_id = %started_id,
                "admin-rpc: interactive pi session started (AC-1)"
            );

            // Send success response to the client.
            let resp = Response::ok(
                id,
                serde_json::json!({
                    "ok": true,
                    "session_id": started_id.to_string(),
                }),
            );
            if out_tx
                .send(OutboundMsg::Frame(serialize_frame(&resp)))
                .await
                .is_err()
            {
                // Write task gone; kill the session we just started before exiting.
                let _ = supervisor.kill_session(started_id).await;
                return false;
            }

            // AC-2: subscribe to the exit event; spawn a forwarder that sends
            // `session.interactive.exited` when pi exits.
            match supervisor.watch_interactive_session_exit(started_id).await {
                Ok(exit_rx) => {
                    let ntx = notif_tx.clone();
                    let sup_for_cleanup = supervisor.clone();
                    tokio::spawn(async move {
                        // Wait for the child to exit (or for the watcher to be dropped).
                        let _ = exit_rx.await;
                        tracing::debug!(
                            session_id = %started_id,
                            "admin-rpc: interactive pi session exited; sending notification (AC-2)"
                        );
                        let notification = crate::protocol::Notification::new(
                            "session.interactive.exited",
                            serde_json::json!({ "session_id": started_id.to_string() }),
                        );
                        let _ = ntx
                            .send(NotifMsg::Frame(serialize_frame(&notification)))
                            .await;
                        // Ensure the session is removed from the pool after natural exit.
                        let _ = sup_for_cleanup.kill_session(started_id).await;
                    });
                    // AC-3: track the session for cleanup on client disconnect.
                    // Note: the watcher task moved the session out of the pool via
                    // `take_interactive_session`; `kill_session` after natural exit
                    // will return InvalidRequest (not an error). On client disconnect
                    // before pi exits, `kill_session` will terminate the child.
                    *active_interactive = Some((started_id, supervisor));
                }
                Err(e) => {
                    tracing::warn!(
                        error = ?e,
                        session_id = %started_id,
                        "admin-rpc: failed to subscribe to interactive session exit"
                    );
                    // Still track for AC-3 cleanup even without AC-2 watcher.
                    *active_interactive = Some((started_id, supervisor));
                }
            }

            true
        }
        Err(e) => {
            tracing::warn!(
                error = ?e,
                session_id = %session_id,
                "admin-rpc: start_interactive_session failed"
            );
            let err = map_service_error(id, &e);
            out_tx
                .send(OutboundMsg::Frame(serialize_frame(&err)))
                .await
                .is_ok()
        }
    }
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

/// Receive exactly three file descriptors sent by the client via `SCM_RIGHTS`
/// ancillary data over the Unix domain socket `fd`.
///
/// Per ADR-011, after the JSON-RPC `session.interactive.open` frame is sent
/// by the client, the client sends a one-data-byte `sendmsg` with three fds
/// (stdin, stdout, stderr) in `SCM_RIGHTS` ancillary data.  The single data
/// byte anchors the message in the byte stream (a zero-byte `sendmsg` is
/// silently discarded by Linux when the peer has already called `read()` on
/// the socket).  This function reads that ancillary message and returns the
/// three received `OwnedFd`s.
///
/// # Safety
///
/// `OwnedFd::from_raw_fd(raw)` is called here because `recvmsg` can only
/// return raw file descriptors from the kernel.  The kernel guarantees these
/// are valid, new, open file descriptors; we take ownership immediately and
/// close-on-drop them via `OwnedFd`.
///
/// # Errors
///
/// Returns `io::Error` if:
/// - the `recvmsg` syscall fails (I/O error), or
/// - the ancillary data does not carry exactly three fds (protocol violation).
#[allow(unsafe_code)]
fn receive_interactive_fds(fd: RawFd) -> io::Result<[OwnedFd; 3]> {
    use nix::poll::{poll, PollFd, PollFlags, PollTimeout};
    use nix::sys::socket::{recvmsg, ControlMessageOwned, MsgFlags};
    use std::io::IoSliceMut;

    // The tokio socket is in non-blocking mode. Use `poll` to block until
    // the client's SCM_RIGHTS `sendmsg` arrives before calling `recvmsg`.
    let pfd = PollFd::new(
        unsafe { std::os::fd::BorrowedFd::borrow_raw(fd) },
        PollFlags::POLLIN,
    );
    let n = poll(&mut [pfd], PollTimeout::from(30_000u16))
        .map_err(|e| io::Error::from_raw_os_error(e as i32))?;
    if n == 0 {
        return Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "session.interactive.open: timed out waiting for SCM_RIGHTS fds from client",
        ));
    }

    // Zero-byte data buffer: we only care about ancillary data.
    let mut buf = [0u8; 1];
    let mut iov = [IoSliceMut::new(&mut buf)];
    // Allocate space for 3 raw fds in the cmsg buffer.
    let mut cmsg_buf = nix::cmsg_space!([RawFd; 3]);

    let msg = recvmsg::<()>(fd, &mut iov, Some(&mut cmsg_buf), MsgFlags::empty())
        .map_err(|e| io::Error::from_raw_os_error(e as i32))?;

    // Extract ScmRights from the control messages.
    let mut raw_fds: Vec<RawFd> = Vec::new();
    for cmsg in msg
        .cmsgs()
        .map_err(|e| io::Error::from_raw_os_error(e as i32))?
    {
        if let ControlMessageOwned::ScmRights(fds) = cmsg {
            raw_fds.extend_from_slice(&fds);
        }
    }

    // Wrap every received fd in OwnedFd immediately so they are closed on drop
    // even if the count is wrong (prevents fd leaks on protocol violation).
    //
    // SAFETY: `recvmsg` with `SCM_RIGHTS` transfers ownership of fresh kernel
    // file descriptors to the receiving process.  We wrap each immediately in
    // `OwnedFd` so they are closed on drop.
    let mut owned_fds: Vec<OwnedFd> = raw_fds
        .iter()
        .map(|&raw| unsafe { OwnedFd::from_raw_fd(raw) })
        .collect();

    if owned_fds.len() != 3 {
        // `owned_fds` drops here, closing the fds.
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "session.interactive.open: expected 3 SCM_RIGHTS fds, got {}",
                owned_fds.len()
            ),
        ));
    }

    let stderr = owned_fds.pop().expect("length checked above");
    let stdout = owned_fds.pop().expect("length checked above");
    let stdin = owned_fds.pop().expect("length checked above");

    Ok([stdin, stdout, stderr])
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

/// Assemble the JSON-RPC [`Dispatcher`] from an actor [`Config`].
///
/// Split out from [`start`] so the wiring is unit-testable without binding a
/// socket — in particular that the `service.status` version string comes from
/// [`Config::version`] (the binary's release version, supplied by `bob serve`)
/// rather than this crate's own `CARGO_PKG_VERSION`.
fn build_dispatcher(cfg: &Config) -> Dispatcher {
    let mut dispatcher = Dispatcher::new(
        cfg.supervisor.clone(),
        cfg.policy.clone(),
        cfg.monitoring.clone(),
        cfg.version,
    );
    // Inject the scheduler-adapter handle when provided (AC-2 of T-096).
    if let Some(h) = cfg.scheduler.clone() {
        dispatcher = dispatcher.with_scheduler_handle(h);
    }
    // Inject the JSON schedule store path when provided (T-115 / ADR-012).
    if let Some(p) = cfg.schedule_store_path.clone() {
        dispatcher = dispatcher.with_schedule_store_path(p);
    }
    // Inject the trusted service-principal uid for the schedule-store trust
    // boundary (ADR-012 / ADR-005).
    if let Some(uid) = cfg.schedule_store_uid {
        dispatcher = dispatcher.with_schedule_store_uid(uid);
    }
    // Inject the interactive-session spawn config when provided (T-105).
    if let Some(interactive_cfg) = cfg.interactive_session.clone() {
        dispatcher = dispatcher.with_interactive_session_config(interactive_cfg);
    }
    dispatcher
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
    let dispatcher = build_dispatcher(&cfg);

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

    // Regression (issue #52): the `service.status` version string must be taken
    // from `Config::version` — the binary's release version supplied by
    // `bob serve` — and not from this crate's own `CARGO_PKG_VERSION`, which is
    // pinned at 0.1.0 and never bumped.
    #[tokio::test(flavor = "current_thread")]
    async fn build_dispatcher_threads_config_version_into_service_status() {
        let cfg = Config {
            version: "9.9.9-test",
            ..Config::default()
        };

        let dispatcher = build_dispatcher(&cfg);
        let mut registry = ConnectionRegistry::new();
        let req = crate::protocol::Request {
            jsonrpc: "2.0".to_string(),
            method: "service.status".to_string(),
            params: None,
            id: json!(1),
        };

        match dispatcher.dispatch(req, &mut registry).await {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.result["ok"], json!(true));
                assert_eq!(resp.result["version"], json!("9.9.9-test"));
            }
            DispatchOutcome::Err(e) => {
                panic!(
                    "expected Ok service.status outcome, got error: {}",
                    e.error.message
                )
            }
            _ => panic!("expected Ok service.status outcome, got another variant"),
        }
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
                resolved_cwd: None,
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
                resolved_cwd: None,
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
                resolved_cwd: None,
            }),
        };
        mon_handle
            .append_record(record)
            .await
            .expect("append after close must not panic");

        mon_task.abort();
    }

    // ── Interactive session tests (T-105) ─────────────────────────────────────
    //
    // These tests use a multi-thread executor because `spawn_blocking` is
    // called inside `handle_interactive_session_opening` for the `recvmsg` call.

    /// Build a supervisor and dispatcher configured for interactive session tests.
    ///
    /// The interactive command is `sh -c <script>` with the current executable
    /// as the extension path (it exists on disk, satisfying the extension-file check).
    fn make_supervisor_and_dispatcher(
        script: &str,
    ) -> (
        pi_agent_supervisor::Handle,
        tokio::task::JoinHandle<()>,
        Dispatcher,
    ) {
        let extension_path =
            std::env::current_exe().expect("current executable should exist in tests");
        let mut sup_cfg = pi_agent_supervisor::Config::default();
        sup_cfg.extension_path = extension_path.clone();
        // No warm pool needed for interactive-only tests.
        sup_cfg.warm_pool_size = 0;
        // Short reap tick so the actor polls interactive-session exits quickly
        // (AC-2: the exit notification must arrive within the test timeout).
        sup_cfg.idle_reap_timeout = Duration::from_millis(50);
        let (sup_handle, sup_task) =
            pi_agent_supervisor::start(sup_cfg).expect("supervisor start must succeed in tests");

        let interactive_cfg = InteractiveSessionConfig {
            command: "sh".to_string(),
            args: vec!["-c".to_string(), script.to_string()],
            child_termination_deadline: Duration::from_millis(500),
            extension_sock_path: PathBuf::new(),
            extension_path,
        };

        let dispatcher = Dispatcher::new(Some(sup_handle.clone()), None, None, "0.1.0-test")
            .with_interactive_session_config(interactive_cfg);

        (sup_handle, sup_task, dispatcher)
    }

    /// Send three file descriptors via `SCM_RIGHTS` over a Unix domain socket.
    ///
    /// Per ADR-011: the client sends a one-data-byte `sendmsg` after the
    /// JSON-RPC request frame.  The single byte anchors the ancillary data in
    /// the `SOCK_STREAM` byte stream — on Linux, a zero-byte `sendmsg` is
    /// silently discarded when the receiver calls `recvmsg` after a prior
    /// `read()` on the same socket (the data bytes carry ancillary data in the
    /// kernel's stream position tracking, and a zero-length message has no
    /// position to attach to).
    fn send_interactive_fds(
        socket_fd: std::os::fd::RawFd,
        stdin: std::os::fd::RawFd,
        stdout: std::os::fd::RawFd,
        stderr: std::os::fd::RawFd,
    ) -> io::Result<()> {
        use nix::sys::socket::{sendmsg, ControlMessage, MsgFlags};
        use std::io::IoSlice;

        let fds = [stdin, stdout, stderr];
        let cmsg = [ControlMessage::ScmRights(&fds)];
        // One sentinel byte anchors the ancillary data in the byte stream.
        // A zero-length sendmsg does not reliably deliver SCM_RIGHTS on
        // SOCK_STREAM when the peer has already read from the socket.
        let anchor = [0u8; 1];
        let iov = [IoSlice::new(&anchor)];
        sendmsg::<()>(socket_fd, &iov, &cmsg, MsgFlags::empty(), None)
            .map_err(|e| io::Error::from_raw_os_error(e as i32))?;
        Ok(())
    }

    /// Open an interactive session using the ADR-011 two-step SCM_RIGHTS protocol:
    ///
    /// 1. Send the `session.interactive.open` JSON-RPC request.
    /// 2. Wait for the `session.interactive.await_fds` notification from the server.
    /// 3. Send the three terminal fds via SCM_RIGHTS `sendmsg`.
    /// 4. Return the raw fd and reader so the caller can read the final response.
    ///
    /// Step 2 is required to avoid a BufReader read-ahead race: the server's
    /// BufReader uses `read()` (not `recvmsg`), which discards ancillary data
    /// when it reads the anchor byte from the SCM_RIGHTS message.  The
    /// `await_fds` notification signals that the server has stopped using
    /// BufReader and is blocked in `recvmsg` — safe to send now.
    async fn open_interactive_session(
        reader: &mut tokio::io::BufReader<tokio::io::ReadHalf<UnixStream>>,
        write_half: &mut tokio::io::WriteHalf<UnixStream>,
        client_raw_fd: std::os::fd::RawFd,
        request_id: u64,
        stdin_fd: std::os::fd::RawFd,
        stdout_fd: std::os::fd::RawFd,
        stderr_fd: std::os::fd::RawFd,
    ) {
        open_interactive_session_with_params(
            reader,
            write_half,
            client_raw_fd,
            request_id,
            None,
            stdin_fd,
            stdout_fd,
            stderr_fd,
        )
        .await;
    }

    /// Like [`open_interactive_session`], but lets the caller supply
    /// `params` on the `session.interactive.open` request (B-021 / CR-005:
    /// used to exercise `params.cwd` threading end-to-end).
    #[allow(clippy::too_many_arguments)]
    async fn open_interactive_session_with_params(
        reader: &mut tokio::io::BufReader<tokio::io::ReadHalf<UnixStream>>,
        write_half: &mut tokio::io::WriteHalf<UnixStream>,
        client_raw_fd: std::os::fd::RawFd,
        request_id: u64,
        params: Option<serde_json::Value>,
        stdin_fd: std::os::fd::RawFd,
        stdout_fd: std::os::fd::RawFd,
        stderr_fd: std::os::fd::RawFd,
    ) {
        use tokio::io::AsyncBufReadExt as _;

        // Step 1: send the JSON-RPC open request.
        let mut req_obj = serde_json::json!({
            "jsonrpc": "2.0",
            "method": "session.interactive.open",
            "id": request_id,
        });
        if let Some(params) = params {
            req_obj["params"] = params;
        }
        let mut req = serde_json::to_vec(&req_obj).expect("serialize open request");
        req.push(b'\n');
        write_half
            .write_all(&req)
            .await
            .expect("write session.interactive.open request");

        // Step 2: wait for the server's `session.interactive.await_fds` notification.
        let mut notif_line = String::new();
        tokio::time::timeout(
            Duration::from_millis(2000),
            reader.read_line(&mut notif_line),
        )
        .await
        .expect("timed out waiting for session.interactive.await_fds notification")
        .expect("read await_fds notification");

        let notif: serde_json::Value =
            serde_json::from_str(notif_line.trim()).expect("valid JSON await_fds notification");
        assert_eq!(
            notif["method"], "session.interactive.await_fds",
            "server must send session.interactive.await_fds before fds; got: {notif:?}"
        );

        // Step 3: send the three terminal fds via SCM_RIGHTS.
        // This is safe now because the server is blocked in spawn_blocking/recvmsg,
        // not in BufReader::read() — so the anchor byte won't be silently consumed.
        send_interactive_fds(client_raw_fd, stdin_fd, stdout_fd, stderr_fd)
            .expect("sendmsg SCM_RIGHTS must succeed");
    }

    // AC-1 (T-105): session.interactive.open with SCM_RIGHTS fds starts a
    // supervised interactive pi session and returns a success response with
    // a non-empty session_id.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_session_interactive_open_starts_session_and_returns_session_id() {
        use std::fs::File;
        use std::os::fd::{AsRawFd as _, RawFd};

        // Use a script that stays alive until SIGTERM so the session exists long enough to check.
        let (_, sup_task, dispatcher) =
            make_supervisor_and_dispatcher("trap 'exit 0' TERM; while :; do sleep 0.1; done");
        let bus = make_bus();

        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        tokio::spawn(run_connection(server, dispatcher, bus));

        let client_raw_fd: RawFd = client.as_raw_fd();
        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = tokio::io::BufReader::new(read_half);

        // Use /dev/null as placeholder terminal fds.  Keep File alive until
        // after sendmsg; the kernel duplicates the fds on sendmsg.
        let stdin_file = File::open("/dev/null").expect("open /dev/null for stdin");
        let stdout_file = File::open("/dev/null").expect("open /dev/null for stdout");
        let stderr_file = File::open("/dev/null").expect("open /dev/null for stderr");

        // Open the interactive session using the two-step protocol (see helper).
        open_interactive_session(
            &mut reader,
            &mut write_half,
            client_raw_fd,
            700,
            stdin_file.as_raw_fd(),
            stdout_file.as_raw_fd(),
            stderr_file.as_raw_fd(),
        )
        .await;
        // Files drop here, closing the parent's copies (child has its own copies).
        drop(stdin_file);
        drop(stdout_file);
        drop(stderr_file);

        // Read the final response (session_id + ok).
        let mut resp_line = String::new();
        tokio::time::timeout(
            Duration::from_millis(2000),
            reader.read_line(&mut resp_line),
        )
        .await
        .expect("timed out waiting for session.interactive.open response")
        .expect("read response line");

        let resp: serde_json::Value =
            serde_json::from_str(resp_line.trim()).expect("valid JSON response");

        assert_eq!(resp["jsonrpc"], "2.0");
        assert_eq!(resp["id"], 700);
        assert_eq!(
            resp["result"]["ok"], true,
            "session.interactive.open must return ok:true"
        );
        let session_id_str = resp["result"]["session_id"]
            .as_str()
            .expect("result.session_id must be a string");
        assert!(
            !session_id_str.is_empty(),
            "AC-1: session_id must be non-empty; got: {resp:?}"
        );

        sup_task.abort();
    }

    // B-021 / CR-005: session.interactive.open with params.cwd spawns the pi
    // child in that directory (the bob chat invocation cwd) end-to-end
    // through the dispatcher and pi-agent-supervisor, not bob serve's own
    // launch cwd.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_session_interactive_open_with_params_cwd_spawns_child_in_that_directory(
    ) {
        use std::fs::File;
        use std::os::fd::{AsRawFd as _, RawFd};

        let (_, sup_task, dispatcher) = make_supervisor_and_dispatcher("printf '%s' \"$(pwd)\"");
        let bus = make_bus();

        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        tokio::spawn(run_connection(server, dispatcher, bus));

        let client_raw_fd: RawFd = client.as_raw_fd();
        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = tokio::io::BufReader::new(read_half);

        let requested_cwd = std::env::temp_dir().join(format!(
            "admin-rpc-interactive-cwd-{}",
            bob_core::types::SessionId::new()
        ));
        std::fs::create_dir_all(&requested_cwd).expect("create requested cwd dir");

        let out_file = std::env::temp_dir().join(format!(
            "admin-rpc-interactive-cwd-out-{}.txt",
            bob_core::types::SessionId::new()
        ));
        let _ = std::fs::remove_file(&out_file);

        let stdin_file = File::open("/dev/null").expect("open /dev/null for stdin");
        let stdout_file = File::create(&out_file).expect("create output file for stdout");
        let stderr_file = File::open("/dev/null").expect("open /dev/null for stderr");

        open_interactive_session_with_params(
            &mut reader,
            &mut write_half,
            client_raw_fd,
            701,
            Some(serde_json::json!({ "cwd": requested_cwd.to_string_lossy() })),
            stdin_file.as_raw_fd(),
            stdout_file.as_raw_fd(),
            stderr_file.as_raw_fd(),
        )
        .await;
        drop(stdin_file);
        drop(stdout_file);
        drop(stderr_file);

        let mut resp_line = String::new();
        tokio::time::timeout(
            Duration::from_millis(2000),
            reader.read_line(&mut resp_line),
        )
        .await
        .expect("timed out waiting for session.interactive.open response")
        .expect("read response line");
        let resp: serde_json::Value =
            serde_json::from_str(resp_line.trim()).expect("valid JSON response");
        assert_eq!(
            resp["result"]["ok"], true,
            "session.interactive.open must return ok:true; got: {resp:?}"
        );

        // Give the short-lived child time to run its printf and exit.
        tokio::time::sleep(Duration::from_millis(150)).await;

        let written = std::fs::read_to_string(&out_file)
            .expect("output file should have been written by child");
        let expected =
            std::fs::canonicalize(&requested_cwd).expect("canonicalize expected requested cwd");
        let actual =
            std::fs::canonicalize(written.trim()).expect("canonicalize child-reported cwd");
        assert_eq!(
            actual, expected,
            "interactive child must run in params.cwd, not bob serve's own launch cwd"
        );

        std::fs::remove_dir_all(&requested_cwd).ok();
        let _ = std::fs::remove_file(&out_file);
        sup_task.abort();
    }

    // AC-2 (T-105): when the pi session exits, the client receives a
    // `session.interactive.exited` notification.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_session_interactive_exited_notification_delivered_when_pi_exits() {
        use std::fs::File;
        use std::os::fd::{AsRawFd as _, RawFd};

        // A script that exits quickly after a brief pause.
        let (_, sup_task, dispatcher) = make_supervisor_and_dispatcher("sleep 0.05; exit 0");
        let bus = make_bus();

        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let client_raw_fd: RawFd = client.as_raw_fd();
        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = tokio::io::BufReader::new(read_half);

        let stdin_file = File::open("/dev/null").expect("open /dev/null for stdin");
        let stdout_file = File::open("/dev/null").expect("open /dev/null for stdout");
        let stderr_file = File::open("/dev/null").expect("open /dev/null for stderr");

        // Step 1+2+3: send open request, wait for await_fds, send fds.
        open_interactive_session(
            &mut reader,
            &mut write_half,
            client_raw_fd,
            800,
            stdin_file.as_raw_fd(),
            stdout_file.as_raw_fd(),
            stderr_file.as_raw_fd(),
        )
        .await;
        drop(stdin_file);
        drop(stdout_file);
        drop(stderr_file);

        // Read the session.interactive.open success response.
        let mut open_line = String::new();
        tokio::time::timeout(
            Duration::from_millis(2000),
            reader.read_line(&mut open_line),
        )
        .await
        .expect("timed out waiting for open response")
        .expect("read open response");
        let open_resp: serde_json::Value =
            serde_json::from_str(open_line.trim()).expect("valid JSON");
        assert_eq!(
            open_resp["result"]["ok"], true,
            "open must succeed for AC-2 test"
        );

        // AC-2: wait for the `session.interactive.exited` notification.
        let mut notif_line = String::new();
        tokio::time::timeout(
            Duration::from_millis(3000),
            reader.read_line(&mut notif_line),
        )
        .await
        .expect("timed out waiting for session.interactive.exited notification")
        .expect("read notification");

        let notif: serde_json::Value =
            serde_json::from_str(notif_line.trim()).expect("valid JSON notification");

        assert_eq!(
            notif["method"], "session.interactive.exited",
            "AC-2: must receive session.interactive.exited notification when pi exits; got: {notif:?}"
        );
        assert!(
            notif["params"]["session_id"].is_string(),
            "AC-2: notification must carry session_id; got: {notif:?}"
        );

        sup_task.abort();
    }

    // AC-3 (T-105): when the client disconnects, the interactive pi session is
    // terminated (kill_session is called).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn run_connection_client_disconnect_terminates_interactive_session() {
        use std::fs::File;
        use std::os::fd::{AsRawFd as _, RawFd};

        // A long-lived script that we expect to be killed when the client disconnects.
        let pid_file = std::env::temp_dir().join(format!(
            "admin-rpc-interactive-ac3-{}.txt",
            bob_core::types::SessionId::new()
        ));
        let _ = std::fs::remove_file(&pid_file);
        let pid_file_path = pid_file.to_string_lossy().into_owned();

        let script = format!(
            "printf '%s\\n' $$ >> \"{}\"; trap 'exit 0' TERM; while :; do sleep 0.1; done",
            pid_file_path
        );

        let (sup_handle, sup_task, dispatcher) = make_supervisor_and_dispatcher(&script);
        let bus = make_bus();

        let (client, server) = UnixStream::pair().expect("UnixStream::pair");
        let client_raw_fd: RawFd = client.as_raw_fd();
        tokio::spawn(run_connection(server, dispatcher, bus));

        let (read_half, mut write_half) = tokio::io::split(client);
        let mut reader = tokio::io::BufReader::new(read_half);

        let stdin_file = File::open("/dev/null").expect("open /dev/null for stdin");
        let stdout_file = File::open("/dev/null").expect("open /dev/null for stdout");
        let stderr_file = File::open("/dev/null").expect("open /dev/null for stderr");

        // Step 1+2+3: send open request, wait for await_fds, send fds.
        open_interactive_session(
            &mut reader,
            &mut write_half,
            client_raw_fd,
            900,
            stdin_file.as_raw_fd(),
            stdout_file.as_raw_fd(),
            stderr_file.as_raw_fd(),
        )
        .await;
        drop(stdin_file);
        drop(stdout_file);
        drop(stderr_file);

        // Read the success response.
        let mut open_line = String::new();
        tokio::time::timeout(
            Duration::from_millis(2000),
            reader.read_line(&mut open_line),
        )
        .await
        .expect("timed out waiting for open response")
        .expect("read open response");
        let open_resp: serde_json::Value =
            serde_json::from_str(open_line.trim()).expect("valid JSON");
        assert_eq!(
            open_resp["result"]["ok"], true,
            "open must succeed for AC-3 test"
        );

        // Give the child a moment to start and write its pid.
        tokio::time::sleep(Duration::from_millis(100)).await;

        // Verify the child pid was written.
        let pid_content =
            std::fs::read_to_string(&pid_file).expect("child should have written its pid to file");
        let child_pid: i32 = pid_content.trim().parse().expect("pid must be numeric");

        // AC-3: close the client connection.
        drop(write_half);
        drop(reader);

        // Give the server time to detect EOF and call kill_session.
        tokio::time::sleep(Duration::from_millis(500)).await;

        // The child process should no longer exist.
        let proc_path = format!("/proc/{child_pid}");
        assert!(
            !std::path::Path::new(&proc_path).exists(),
            "AC-3: interactive child process (pid {child_pid}) must not exist after client disconnect"
        );

        // list_sessions should not include the session (it was removed by kill_session
        // or the watcher task).
        let sessions = sup_handle
            .list_sessions()
            .await
            .expect("list_sessions should succeed");
        assert!(
            sessions.is_empty(),
            "AC-3: session list should be empty after client disconnect; got {sessions:?}"
        );

        let _ = std::fs::remove_file(&pid_file);
        sup_task.abort();
    }
}
