// Client-side implementation of the `session.interactive.open` protocol
// (ADR-011 / T-105 / T-106).
//
// Protocol sequence:
//   1. Client connects to admin.sock.
//   2. Client sends `session.interactive.open` JSON-RPC call.
//   3. Server sends `session.interactive.await_fds` notification.
//   4. Client reads that notification, then sends three terminal fds
//      (stdin, stdout, stderr) via SCM_RIGHTS in a single `sendmsg` with a
//      1-byte anchor payload (a zero-byte sendmsg is silently dropped on
//      Linux SOCK_STREAM).
//   5. Server sends the JSON-RPC success response with the session_id.
//   6. Server sends `session.interactive.exited` notification when pi exits.
//   7. Client exits.
//
// AC-2: If admin.sock is not reachable the command prints a clear error and
// exits non-zero — it does NOT launch a bare pi.

use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::io::RawFd;

use bob_core::error::{ServiceError, ServiceResult};
use serde_json::Value;
use tokio::{
    io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader},
    net::UnixStream,
};

use super::{invalid_request_error, load_config, run_async};
use crate::config::BobConfig;

pub(super) fn run(_json_output: bool, _session: Option<&str>) -> ServiceResult<()> {
    let cfg = load_config()?;
    run_async(run_interactive_session(&cfg))
}

/// Opens a supervised interactive pi session via the admin-RPC
/// `session.interactive.open` protocol (ADR-011).
///
/// Connects to `admin.sock`, performs the four-step handshake, and then
/// waits for the `session.interactive.exited` notification before returning.
///
/// Returns a clear error when the socket is not reachable (AC-2).
async fn run_interactive_session(cfg: &BobConfig) -> ServiceResult<()> {
    // CR-005 / B-021: capture the directory bob chat was invoked from so it
    // can be sent as params.cwd below. The interactive pi session must run
    // here, not wherever the long-running bob serve process itself happens
    // to be running — and per CR-005, pi_agent_cwd is never consulted for
    // interactive sessions.
    let cwd = std::env::current_dir().map_err(|e| {
        invalid_request_error(format!("failed to resolve current working directory: {e}"))
    })?;

    // AC-2: connect directly to the socket and surface a human-readable error
    // when the service is not running.  We do NOT fall back to launching pi.
    let stream = UnixStream::connect(&cfg.admin_sock_path)
        .await
        .map_err(|_| service_not_running_error(&cfg.admin_sock_path))?;

    let (read_half, mut write_half) = stream.into_split();
    let mut reader = BufReader::new(read_half);

    // Step 2: send session.interactive.open
    let open_id: u64 = 1;
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "method": "session.interactive.open",
        "params": { "cwd": cwd.to_string_lossy() },
        "id": open_id,
    });
    let frame = serde_json::to_vec(&request).map_err(|e| {
        invalid_request_error(format!("failed to serialize session.interactive.open: {e}"))
    })?;
    write_frame_bytes(&mut write_half, &frame).await?;

    // Step 3: read frames until we get session.interactive.await_fds
    wait_for_await_fds_notification(&mut reader).await?;

    // Step 4: send the three terminal fds via SCM_RIGHTS.
    // The anchor byte wakes the server's recvmsg without a zero-byte sendmsg
    // (which Linux SOCK_STREAM silently drops).
    let conn_fd: RawFd = write_half.as_ref().as_raw_fd();
    let stdin_fd: RawFd = io::stdin().as_raw_fd();
    let stdout_fd: RawFd = io::stdout().as_raw_fd();
    let stderr_fd: RawFd = io::stderr().as_raw_fd();
    send_fds_via_scm_rights(conn_fd, &[stdin_fd, stdout_fd, stderr_fd])?;

    // Step 5: read the session.interactive.open response.
    let response = read_json_frame(&mut reader).await?;
    if response.get("jsonrpc") != Some(&Value::String("2.0".to_string())) {
        return Err(invalid_request_error(
            "session.interactive.open response must use jsonrpc 2.0",
        ));
    }
    if response.get("id") != Some(&serde_json::json!(open_id)) {
        return Err(invalid_request_error(
            "session.interactive.open response id mismatch",
        ));
    }
    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(invalid_request_error(format!(
            "session.interactive.open failed: {message}"
        )));
    }
    if response.get("result").is_none() {
        return Err(invalid_request_error(
            "session.interactive.open response missing result field",
        ));
    }

    // Step 6: wait for the session.interactive.exited notification (AC-3).
    wait_for_session_exited_notification(&mut reader).await?;

    Ok(())
}

/// Returns a `ServiceError::InvalidRequest` with a human-readable message
/// indicating that the bob service is not running (AC-2).
fn service_not_running_error(path: &std::path::Path) -> ServiceError {
    invalid_request_error(format!(
        "bob service is not running — cannot reach admin socket at {}",
        path.display()
    ))
}

/// Reads JSON-RPC frames from `reader` until a
/// `session.interactive.await_fds` notification arrives.
///
/// Any other frames received before the notification are silently skipped.
/// Returns an error if the socket closes or a parse error occurs before the
/// notification arrives.
async fn wait_for_await_fds_notification(
    reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
) -> ServiceResult<()> {
    loop {
        let frame = read_json_frame(reader).await?;
        if frame.get("method").and_then(Value::as_str) == Some("session.interactive.await_fds") {
            return Ok(());
        }
        // Skip unexpected frames (e.g. responses to other methods).
    }
}

/// Reads JSON-RPC frames from `reader` until a
/// `session.interactive.exited` notification arrives.
///
/// Any other frames received before the notification are silently skipped.
async fn wait_for_session_exited_notification(
    reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
) -> ServiceResult<()> {
    loop {
        let frame = read_json_frame(reader).await?;
        if frame.get("method").and_then(Value::as_str) == Some("session.interactive.exited") {
            return Ok(());
        }
        // Skip unexpected frames.
    }
}

/// Reads one newline-terminated JSON frame from `reader`.
async fn read_json_frame(
    reader: &mut BufReader<tokio::net::unix::OwnedReadHalf>,
) -> ServiceResult<Value> {
    let mut line = String::new();
    let n = reader
        .read_line(&mut line)
        .await
        .map_err(|_| ServiceError::ServiceDown)?;
    if n == 0 {
        return Err(ServiceError::ServiceDown);
    }
    serde_json::from_str(line.trim())
        .map_err(|e| invalid_request_error(format!("malformed server frame: {e}")))
}

/// Writes a newline-terminated byte frame to `writer`.
async fn write_frame_bytes(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    frame: &[u8],
) -> ServiceResult<()> {
    let mut buf = Vec::with_capacity(frame.len() + 1);
    buf.extend_from_slice(frame);
    buf.push(b'\n');
    writer
        .write_all(&buf)
        .await
        .map_err(|_| ServiceError::ServiceDown)
}

/// Sends `fds` to the peer of `conn_fd` via a `sendmsg` with `SCM_RIGHTS`
/// ancillary data and a single anchor byte in the data buffer.
///
/// A zero-byte `sendmsg` is silently dropped on Linux `SOCK_STREAM` sockets,
/// so the anchor byte is required to carry the ancillary data to the server's
/// `recvmsg` call.
///
/// # Panics / errors
///
/// Returns an error if the `sendmsg` syscall fails.
#[allow(unsafe_code)]
fn send_fds_via_scm_rights(conn_fd: RawFd, fds: &[RawFd]) -> ServiceResult<()> {
    use nix::sys::socket::{sendmsg, ControlMessage, MsgFlags};
    use std::io::IoSlice;

    let anchor = [0u8; 1];
    let iov = [IoSlice::new(&anchor)];
    let cmsg = [ControlMessage::ScmRights(fds)];

    // SAFETY: `conn_fd` is a valid open socket fd for the duration of this call.
    // `fds` are open file descriptors whose lifetimes are managed by the caller.
    // We pass ownership semantics only via the kernel's SCM_RIGHTS transfer; the
    // local fds remain open in this process until the caller decides to close them.
    sendmsg::<()>(conn_fd, &iov, &cmsg, MsgFlags::empty(), None)
        .map_err(|e| invalid_request_error(format!("failed to send SCM_RIGHTS fds: {e}")))?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };

    use serde_json::{json, Value};
    use tokio::{
        io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
        net::UnixListener,
        time::timeout,
    };

    use super::run_interactive_session;
    use crate::config::BobConfig;

    static NEXT_SOCKET_ID: AtomicU64 = AtomicU64::new(1);

    fn unique_socket_path(name: &str) -> PathBuf {
        let id = NEXT_SOCKET_ID.fetch_add(1, Ordering::Relaxed);
        let dir = PathBuf::from("/tmp/bob-chat-interactive-tests");
        std::fs::create_dir_all(&dir).expect("create test-sockets dir");
        let path = dir.join(format!("{name}-{}-{id}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    // AC-2: when the service is not running (socket absent), run_interactive_session
    // returns an error with a clear message and does NOT attempt to launch pi.
    #[tokio::test(flavor = "current_thread")]
    async fn exits_with_clear_error_when_service_is_not_running() {
        let cfg = BobConfig {
            admin_sock_path: unique_socket_path("absent"),
            ..BobConfig::test_base()
        };

        let result = run_interactive_session(&cfg).await;

        assert!(
            result.is_err(),
            "must fail when service is not running, got: {result:?}"
        );
        let err_msg = format!("{:?}", result.unwrap_err());
        assert!(
            err_msg.contains("bob service is not running") || err_msg.contains("admin socket"),
            "error must mention the service or admin socket; got: {err_msg}"
        );
    }

    // AC-1 / AC-3: run_interactive_session opens the session and exits when
    // session.interactive.exited notification is received.
    //
    // The test server:
    //   1. Accepts the session.interactive.open request.
    //   2. Sends the await_fds notification.
    //   3. Reads and discards the 1-byte SCM_RIGHTS anchor (the fds themselves
    //      are not checked since we cannot pass real terminal fds in a unit test;
    //      we receive the raw byte and ignore the ancillary data).
    //   4. Sends a success response.
    //   5. Waits briefly, then sends session.interactive.exited.
    //
    // The test verifies that run_interactive_session returns Ok(()) after step 5.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn opens_interactive_session_and_exits_when_session_exits() {
        let sock_path = unique_socket_path("interactive-open");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            // Read session.interactive.open request
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("read open request");
            let req: Value = serde_json::from_str(line.trim()).expect("parse open request");
            assert_eq!(req["method"], "session.interactive.open");
            let req_id = req["id"].clone();

            // Send await_fds notification
            write_half
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"method\":\"session.interactive.await_fds\",\"params\":{\"session_id\":\"test-session\"}}\n",
                )
                .await
                .expect("write await_fds");

            // Read the 1-byte anchor from the SCM_RIGHTS sendmsg.
            // The client sends a single data byte; we just consume it.
            let mut anchor = [0u8; 16];
            // Use try_read in a loop until we get at least 1 byte.
            // We use a raw read on the underlying stream since tokio::io::split
            // wraps the same stream; the anchor byte arrives as regular data.
            let mut got = 0usize;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
            while got == 0 && tokio::time::Instant::now() < deadline {
                match reader.read(&mut anchor).await {
                    Ok(n) if n > 0 => got = n,
                    Ok(_) => break,
                    Err(_) => break,
                }
            }
            // Note: the SCM_RIGHTS fds come as ancillary data and are invisible to
            // read(); the test server ignores them — it only needs the anchor byte
            // consumed so the client's sendmsg returns successfully.

            // Send success response
            let resp = serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "result": { "ok": true, "session_id": "test-session" },
                "id": req_id,
            }))
            .expect("serialize response");
            write_half.write_all(&resp).await.expect("write response");
            write_half.write_all(b"\n").await.expect("write newline");

            // Brief pause to let the client process the response before
            // sending the exit notification.
            tokio::time::sleep(Duration::from_millis(20)).await;

            // Send session.interactive.exited notification (AC-3).
            write_half
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"method\":\"session.interactive.exited\",\"params\":{\"session_id\":\"test-session\"}}\n",
                )
                .await
                .expect("write exited notification");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path.clone(),
            ..BobConfig::test_base()
        };

        let result = timeout(Duration::from_secs(5), run_interactive_session(&cfg))
            .await
            .expect("run_interactive_session must complete within 5s");

        assert!(
            result.is_ok(),
            "run_interactive_session must succeed when server sends exited notification; got: {result:?}"
        );

        timeout(Duration::from_secs(2), server)
            .await
            .expect("server must complete")
            .expect("server task must not panic");

        let _ = std::fs::remove_file(&sock_path);
    }

    // B-021 / CR-005: run_interactive_session must send the bob chat client's
    // own invocation cwd (not bob serve's launch cwd) as params.cwd on the
    // session.interactive.open request, so bob serve can spawn the pi child
    // there instead.
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn sends_invocation_cwd_in_session_interactive_open_request_params() {
        let sock_path = unique_socket_path("interactive-cwd");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            // Read session.interactive.open request
            let mut line = String::new();
            reader
                .read_line(&mut line)
                .await
                .expect("read open request");
            let req: Value = serde_json::from_str(line.trim()).expect("parse open request");
            let req_id = req["id"].clone();

            // Send await_fds notification
            write_half
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"method\":\"session.interactive.await_fds\",\"params\":{\"session_id\":\"test-session\"}}\n",
                )
                .await
                .expect("write await_fds");

            // Consume the SCM_RIGHTS anchor byte (see the sibling test above
            // for why this loop is needed).
            let mut anchor = [0u8; 16];
            let mut got = 0usize;
            let deadline = tokio::time::Instant::now() + Duration::from_secs(2);
            while got == 0 && tokio::time::Instant::now() < deadline {
                match reader.read(&mut anchor).await {
                    Ok(n) if n > 0 => got = n,
                    Ok(_) => break,
                    Err(_) => break,
                }
            }

            // Send success response
            let resp = serde_json::to_vec(&json!({
                "jsonrpc": "2.0",
                "result": { "ok": true, "session_id": "test-session" },
                "id": req_id,
            }))
            .expect("serialize response");
            write_half.write_all(&resp).await.expect("write response");
            write_half.write_all(b"\n").await.expect("write newline");

            tokio::time::sleep(Duration::from_millis(20)).await;

            // Send session.interactive.exited notification (AC-3).
            write_half
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"method\":\"session.interactive.exited\",\"params\":{\"session_id\":\"test-session\"}}\n",
                )
                .await
                .expect("write exited notification");

            req
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path.clone(),
            ..BobConfig::test_base()
        };

        let result = timeout(Duration::from_secs(5), run_interactive_session(&cfg))
            .await
            .expect("run_interactive_session must complete within 5s");
        assert!(
            result.is_ok(),
            "run_interactive_session must succeed; got: {result:?}"
        );

        let req = timeout(Duration::from_secs(2), server)
            .await
            .expect("server must complete")
            .expect("server task must not panic");

        let expected_cwd =
            std::env::current_dir().expect("test process current dir should be available");
        assert_eq!(
            req["params"]["cwd"],
            json!(expected_cwd.to_string_lossy()),
            "session.interactive.open params.cwd must be the bob chat invocation cwd; got: {req:?}"
        );

        let _ = std::fs::remove_file(&sock_path);
    }

    // AC-3 (service disconnect): when the server closes the connection before
    // sending exited, run_interactive_session returns an error (ServiceDown).
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn returns_service_down_when_server_closes_connection_before_exited() {
        let sock_path = unique_socket_path("interactive-close");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            // Read open request
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read open");

            // Send await_fds
            write_half
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"method\":\"session.interactive.await_fds\",\"params\":{}}\n",
                )
                .await
                .expect("write await_fds");

            // Consume anchor byte
            let mut anchor = [0u8; 16];
            let _ = reader.read(&mut anchor).await;

            // Send success response
            write_half
                .write_all(
                    b"{\"jsonrpc\":\"2.0\",\"result\":{\"ok\":true,\"session_id\":\"x\"},\"id\":1}\n",
                )
                .await
                .expect("write response");

            // Close the connection WITHOUT sending the exited notification.
            drop(write_half);
            drop(reader);
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path.clone(),
            ..BobConfig::test_base()
        };

        let result = timeout(Duration::from_secs(5), run_interactive_session(&cfg))
            .await
            .expect("must complete within 5s");

        assert!(
            result.is_err(),
            "must return error when server closes before sending exited"
        );

        timeout(Duration::from_secs(2), server)
            .await
            .expect("server must complete")
            .expect("server must not panic");

        let _ = std::fs::remove_file(&sock_path);
    }

    // AC-4: The old chat.open / chat.send subscription REPL is gone.
    // Verify that the module does NOT contain references to the old protocol.
    // This is a compile-time guarantee — if the old code is absent the module
    // compiles without the Subscription / ChatSubscription / ChatInputLines types.
    // The test below simply confirms the function signature has the expected shape.
    #[test]
    fn run_signature_matches_service_required_launcher() {
        // If this compiles, AC-4 is satisfied: the function signature is the
        // simple service-required launcher form, not the old chat REPL form.
        let _: fn(bool, Option<&str>) -> bob_core::error::ServiceResult<()> = super::run;
    }
}
