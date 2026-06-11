use std::{collections::VecDeque, marker::PhantomData};

use bob_core::error::{ServiceError, ServiceResult};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
    sync::mpsc,
    task::JoinHandle,
};

use crate::config::BobConfig;

#[derive(Debug)]
pub struct AdminClient {
    reader: Option<BufReader<tokio::net::unix::OwnedReadHalf>>,
    writer: Option<tokio::net::unix::OwnedWriteHalf>,
    next_id: u64,
}

impl AdminClient {
    pub async fn connect(cfg: &BobConfig) -> ServiceResult<Self> {
        let stream = UnixStream::connect(&cfg.admin_sock_path)
            .await
            .map_err(|_| ServiceError::ServiceDown)?;
        let (read_half, write_half) = stream.into_split();

        Ok(Self {
            reader: Some(BufReader::new(read_half)),
            writer: Some(write_half),
            next_id: 1,
        })
    }

    pub async fn call<P, R>(&mut self, method: &str, params: P) -> ServiceResult<R>
    where
        P: Serialize,
        R: serde::de::DeserializeOwned,
    {
        let id = self.next_request_id();
        let request = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": id,
        });

        let writer = self.writer.as_mut().ok_or(ServiceError::ServiceDown)?;
        write_frame(writer, &request).await?;

        let reader = self.reader.as_mut().ok_or(ServiceError::ServiceDown)?;
        let response = read_value_frame(reader).await?;
        parse_call_response(response, id)
    }

    pub async fn subscribe<P, N>(
        &mut self,
        method: &str,
        params: P,
    ) -> ServiceResult<Subscription<N>>
    where
        P: Serialize,
        N: serde::de::DeserializeOwned,
    {
        let result: Value = self.call(method, params).await?;
        let subscription_id = result
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                invalid_request_error("subscription response must include result.id string")
            })?
            .to_string();
        let close_method = derive_close_method(method)?;
        let close_request_id = self.next_request_id();

        let reader = self.reader.take().ok_or(ServiceError::ServiceDown)?;
        Ok(Subscription {
            frame_reader: FrameReaderTask::spawn(reader),
            writer: self.writer.take().ok_or(ServiceError::ServiceDown)?,
            subscription_id,
            close_method,
            next_call_id: close_request_id.saturating_add(1),
            close_request_id,
            notification_buffer: VecDeque::new(),
            _marker: PhantomData,
        })
    }

    fn next_request_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }
}

/// A background task that reads complete JSON-RPC frames from a `BufReader`
/// and forwards them to a channel.  The channel receive end is cancellation-safe:
/// dropping a `recv()` future does not consume or lose a partially-received frame
/// because the actual `read_line` call lives entirely inside the spawned task.
#[derive(Debug)]
struct FrameReaderTask {
    _handle: JoinHandle<()>,
    receiver: mpsc::Receiver<ServiceResult<Value>>,
}

impl FrameReaderTask {
    fn spawn(mut reader: BufReader<tokio::net::unix::OwnedReadHalf>) -> Self {
        // Buffer up to 64 frames. The chat loop processes notifications one at a
        // time so this is more than enough headroom for normal operation.
        let (tx, receiver) = mpsc::channel(64);
        let handle = tokio::spawn(async move {
            loop {
                let result = read_value_frame(&mut reader).await;
                let is_err = result.is_err();
                if tx.send(result).await.is_err() {
                    // Receiver was dropped; the subscription has been consumed.
                    return;
                }
                if is_err {
                    // Stop after forwarding the terminal error.
                    return;
                }
            }
        });
        Self {
            _handle: handle,
            receiver,
        }
    }

    /// Receive the next complete frame.  Returns `ServiceDown` when the
    /// background reader task has stopped (socket closed or error already sent).
    async fn next_frame(&mut self) -> ServiceResult<Value> {
        self.receiver
            .recv()
            .await
            .unwrap_or(Err(ServiceError::ServiceDown))
    }
}

#[derive(Debug)]
pub struct Subscription<N> {
    /// Background task that owns the reader and sends complete frames to this channel.
    /// Receiving from a channel is cancellation-safe: if a future that awaits
    /// `frame_reader.next_frame()` is dropped, the frame remains in the channel
    /// for the next `next_frame()` call.
    frame_reader: FrameReaderTask,
    writer: tokio::net::unix::OwnedWriteHalf,
    subscription_id: String,
    close_method: String,
    close_request_id: u64,
    /// Next id for ad-hoc `call()` requests issued on this subscription's connection.
    /// Starts above `close_request_id` to avoid id collisions.
    next_call_id: u64,
    /// Notification frames buffered while waiting for a `call()` response.
    notification_buffer: VecDeque<Value>,
    _marker: PhantomData<N>,
}

impl<N> Subscription<N>
where
    N: serde::de::DeserializeOwned,
{
    /// Returns the subscription id assigned by the server on `chat.open` /
    /// `*.subscribe`.
    pub fn subscription_id(&self) -> &str {
        &self.subscription_id
    }

    /// Send a JSON-RPC request on this subscription's connection and return
    /// the deserialized result.
    ///
    /// Notification frames that arrive on the wire before the response are
    /// buffered and made available to the next [`Subscription::recv`] call.
    ///
    /// # Errors
    ///
    /// Returns `InvalidRequest` if the server response id does not match, if
    /// the frame is malformed, or if the server returns a JSON-RPC error.
    /// Returns `ServiceDown` if the underlying socket is closed.
    pub async fn call<P, R>(&mut self, method: &str, params: P) -> ServiceResult<R>
    where
        P: Serialize,
        R: serde::de::DeserializeOwned,
    {
        let id = self.next_call_id;
        self.next_call_id = self.next_call_id.saturating_add(1);

        let request = json!({
            "jsonrpc": "2.0",
            "method": method,
            "params": params,
            "id": id,
        });
        write_frame(&mut self.writer, &request).await?;

        // Read frames until we see the response with the matching id.
        // Any notification frames (those with a `method` field and no numeric
        // `id`) are buffered and will be returned by subsequent `recv()` calls.
        loop {
            let frame = self.frame_reader.next_frame().await?;
            if is_notification(&frame) {
                self.notification_buffer.push_back(frame);
            } else {
                return parse_call_response(frame, id);
            }
        }
    }

    pub async fn recv(&mut self) -> ServiceResult<N> {
        // Drain any frames buffered during a preceding `call()` first.
        let frame = if let Some(buffered) = self.notification_buffer.pop_front() {
            buffered
        } else {
            self.frame_reader.next_frame().await?
        };

        if frame.get("jsonrpc") != Some(&Value::String("2.0".to_string())) {
            return Err(invalid_request_error(
                "notification frame must use jsonrpc 2.0",
            ));
        }

        let params = frame
            .get("params")
            .ok_or_else(|| invalid_request_error("notification frame missing params"))?;
        let got_id = params
            .get("subscription")
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_request_error("notification missing params.subscription"))?;
        if got_id != self.subscription_id {
            return Err(invalid_request_error(
                "notification subscription id did not match active subscription",
            ));
        }

        let payload = params
            .get("data")
            .ok_or_else(|| invalid_request_error("notification missing params.data"))?
            .clone();
        serde_json::from_value(payload).map_err(|e| {
            invalid_request_error(format!("failed to decode notification payload: {e}"))
        })
    }

    pub async fn close(mut self) -> ServiceResult<()> {
        let request = json!({
            "jsonrpc": "2.0",
            "method": self.close_method,
            "params": {"id": self.subscription_id},
            "id": self.close_request_id,
        });
        write_frame(&mut self.writer, &request).await?;

        // Notifications may already be in flight when the close request is
        // written; skip them until the close response arrives. They are
        // discarded rather than buffered because `close` consumes the
        // subscription, so no later `recv()` can observe them.
        let frame = loop {
            let frame = self.frame_reader.next_frame().await?;
            if !is_notification(&frame) {
                break frame;
            }
        };

        if frame.get("jsonrpc") != Some(&Value::String("2.0".to_string())) {
            return Err(invalid_request_error("close response must use jsonrpc 2.0"));
        }
        if frame.get("id") != Some(&json!(self.close_request_id)) {
            return Err(invalid_request_error("close response id mismatch"));
        }
        if frame.get("result").is_some() {
            return Ok(());
        }

        if let Some(error) = frame.get("error") {
            let code = error
                .get("code")
                .and_then(Value::as_i64)
                .unwrap_or_default();
            let message = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("unknown error");
            return Err(invalid_request_error(format!(
                "close returned server error: code={code}, message={message}"
            )));
        }

        Err(invalid_request_error(
            "close response missing both result and error fields",
        ))
    }
}

/// Returns `true` when `frame` is a JSON-RPC notification (has `method` but
/// no `id`, or the `id` is `null`).
///
/// JSON-RPC 2.0 notifications omit `id` entirely. Responses always carry a
/// non-null `id`. We use the presence of `method` combined with an absent or
/// null `id` to distinguish notifications from call responses.
fn is_notification(frame: &Value) -> bool {
    let has_method = frame.get("method").is_some();
    let id_is_absent_or_null = frame.get("id").map(|v| v.is_null()).unwrap_or(true);
    has_method && id_is_absent_or_null
}

fn derive_close_method(method: &str) -> ServiceResult<String> {
    if let Some(prefix) = method.strip_suffix(".subscribe") {
        return Ok(format!("{prefix}.unsubscribe"));
    }
    if let Some(prefix) = method.strip_suffix(".open") {
        return Ok(format!("{prefix}.close"));
    }
    Err(invalid_request_error(format!(
        "subscription method '{method}' has no close/unsubscribe mapping"
    )))
}

async fn write_frame<T: Serialize>(
    writer: &mut tokio::net::unix::OwnedWriteHalf,
    value: &T,
) -> ServiceResult<()> {
    let mut bytes = serde_json::to_vec(value)
        .map_err(|e| invalid_request_error(format!("failed to serialize request frame: {e}")))?;
    bytes.push(b'\n');
    writer
        .write_all(&bytes)
        .await
        .map_err(|_| ServiceError::ServiceDown)
}

async fn read_value_frame(
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

fn parse_call_response<R>(frame: Value, expected_id: u64) -> ServiceResult<R>
where
    R: serde::de::DeserializeOwned,
{
    if frame.get("jsonrpc") != Some(&Value::String("2.0".to_string())) {
        return Err(invalid_request_error(
            "server response must use jsonrpc 2.0",
        ));
    }

    if frame.get("id") != Some(&json!(expected_id)) {
        return Err(invalid_request_error("server response id mismatch"));
    }

    if let Some(result) = frame.get("result") {
        return serde_json::from_value(result.clone()).map_err(|e| {
            invalid_request_error(format!("failed to deserialize response result: {e}"))
        });
    }

    if let Some(error) = frame.get("error") {
        let code = error
            .get("code")
            .and_then(Value::as_i64)
            .unwrap_or_default();
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("unknown error");
        return Err(invalid_request_error(format!(
            "server returned error response: code={code}, message={message}"
        )));
    }

    Err(invalid_request_error(
        "server response missing both result and error fields",
    ))
}

fn invalid_request_error(detail: impl Into<String>) -> ServiceError {
    ServiceError::InvalidRequest {
        detail: detail.into(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        path::PathBuf,
        sync::atomic::{AtomicU64, Ordering},
        time::Duration,
    };

    use bob_core::error::ServiceError;
    use serde_json::{json, Value};
    use tokio::{
        io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
        net::UnixListener,
        time::timeout,
    };

    use crate::{client::AdminClient, config::BobConfig};

    static NEXT_SOCKET_ID: AtomicU64 = AtomicU64::new(1);

    fn unique_socket_path(name: &str) -> PathBuf {
        let id = NEXT_SOCKET_ID.fetch_add(1, Ordering::Relaxed);
        let dir = PathBuf::from("/tmp/bob-client-tests");
        std::fs::create_dir_all(&dir).expect("create test-sockets dir");
        let path = dir.join(format!("{name}-{}-{id}.sock", std::process::id()));
        let _ = std::fs::remove_file(&path);
        path
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connect_returns_service_down_when_socket_is_absent() {
        let cfg = BobConfig {
            admin_sock_path: unique_socket_path("missing-admin"),
            ..BobConfig::test_base()
        };

        let result = AdminClient::connect(&cfg).await;

        assert!(
            matches!(result, Err(ServiceError::ServiceDown)),
            "expected ServiceDown, got: {result:?}"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connect_opens_admin_socket_path_from_config() {
        let sock_path = unique_socket_path("connect");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let accept = tokio::spawn(async move {
            let (_stream, _) = listener.accept().await.expect("accept");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };

        let result = AdminClient::connect(&cfg).await;

        assert!(result.is_ok(), "connect should succeed: {result:?}");
        accept.await.expect("accept join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn call_sends_jsonrpc_request_frame_and_returns_deserialized_result() {
        let sock_path = unique_socket_path("call");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read line");

            let frame: Value = serde_json::from_str(line.trim()).expect("json request");
            assert_eq!(frame["jsonrpc"], "2.0");
            assert_eq!(frame["method"], "service.status");
            assert_eq!(frame["params"], json!({"verbose": true}));
            assert_eq!(frame["id"], 1);

            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"ok\":true},\"id\":1}\n")
                .await
                .expect("write response");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };

        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let result: Value = client
            .call("service.status", json!({"verbose": true}))
            .await
            .expect("call succeeds");

        assert_eq!(result["ok"], true);
        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn call_returns_invalid_request_for_malformed_server_output() {
        let sock_path = unique_socket_path("call-malformed");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (_read_half, mut write_half) = tokio::io::split(stream);
            write_half
                .write_all(b"not-json-rpc\n")
                .await
                .expect("write malformed frame");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };

        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let result: Result<Value, ServiceError> = client.call("service.status", json!({})).await;

        assert!(
            matches!(result, Err(ServiceError::InvalidRequest { .. })),
            "expected InvalidRequest, got: {result:?}"
        );
        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn call_returns_invalid_request_for_mismatched_response_id() {
        let sock_path = unique_socket_path("call-id-mismatch");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (_read_half, mut write_half) = tokio::io::split(stream);
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"ok\":true},\"id\":99}\n")
                .await
                .expect("write response");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };

        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let result: Result<Value, ServiceError> = client.call("service.status", json!({})).await;

        assert!(
            matches!(result, Err(ServiceError::InvalidRequest { .. })),
            "expected InvalidRequest, got: {result:?}"
        );
        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn subscribe_returns_subscription_and_recv_deserializes_notification_data() {
        let sock_path = unique_socket_path("subscribe-recv");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            let mut subscribe_line = String::new();
            reader
                .read_line(&mut subscribe_line)
                .await
                .expect("read subscribe");
            let subscribe_frame: Value =
                serde_json::from_str(subscribe_line.trim()).expect("json subscribe");
            assert_eq!(subscribe_frame["method"], "audit.tail.subscribe");
            assert_eq!(subscribe_frame["id"], 1);

            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"id\":\"sub-1\"},\"id\":1}\n")
                .await
                .expect("write subscribe response");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"audit.event\",\"params\":{\"subscription\":\"sub-1\",\"data\":{\"event\":\"test.event\"}}}\n")
                .await
                .expect("write notification");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };
        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let mut sub = client
            .subscribe::<_, Value>("audit.tail.subscribe", json!({}))
            .await
            .expect("subscribe");

        let notif = sub.recv().await.expect("recv");
        assert_eq!(notif["event"], "test.event");

        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    // subscription_id() exposes the id returned by the server on subscribe.
    #[tokio::test(flavor = "current_thread")]
    async fn subscription_id_returns_the_id_from_the_subscribe_response() {
        let sock_path = unique_socket_path("sub-id");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read subscribe");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"id\":\"chat-42\"},\"id\":1}\n")
                .await
                .expect("write subscribe response");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };
        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let sub = client
            .subscribe::<_, Value>("chat.open", json!({}))
            .await
            .expect("subscribe");

        assert_eq!(sub.subscription_id(), "chat-42");

        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    // call() on a Subscription sends a request on the subscription connection and
    // returns the deserialized result.
    #[tokio::test(flavor = "current_thread")]
    async fn subscription_call_sends_request_and_returns_result() {
        let sock_path = unique_socket_path("sub-call");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            // Read the subscribe request.
            let mut subscribe_line = String::new();
            reader
                .read_line(&mut subscribe_line)
                .await
                .expect("read subscribe");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"id\":\"sub-1\"},\"id\":1}\n")
                .await
                .expect("write subscribe response");

            // Read the chat.send request.
            let mut send_line = String::new();
            reader.read_line(&mut send_line).await.expect("read send");
            let send_frame: Value =
                serde_json::from_str(send_line.trim()).expect("json send request");
            assert_eq!(send_frame["jsonrpc"], "2.0");
            assert_eq!(send_frame["method"], "chat.send");
            assert_eq!(send_frame["params"]["id"], "sub-1");
            assert_eq!(send_frame["params"]["text"], "hello");

            write_half
                .write_all(
                    format!(
                        "{{\"jsonrpc\":\"2.0\",\"result\":{{\"ok\":true}},\"id\":{}}}\n",
                        send_frame["id"]
                    )
                    .as_bytes(),
                )
                .await
                .expect("write send response");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };
        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let mut sub = client
            .subscribe::<_, Value>("chat.open", json!({}))
            .await
            .expect("subscribe");

        let result: Value = sub
            .call(
                "chat.send",
                json!({"id": sub.subscription_id().to_owned(), "text": "hello"}),
            )
            .await
            .expect("call succeeds");
        assert_eq!(result["ok"], true);

        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    // call() on a Subscription buffers notifications that arrive before the
    // response and makes them available through recv().
    #[tokio::test(flavor = "current_thread")]
    async fn subscription_call_buffers_interleaved_notifications() {
        let sock_path = unique_socket_path("sub-call-interleave");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            // Read the subscribe request.
            let mut subscribe_line = String::new();
            reader
                .read_line(&mut subscribe_line)
                .await
                .expect("read subscribe");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"id\":\"sub-1\"},\"id\":1}\n")
                .await
                .expect("write subscribe response");

            // Read the chat.send request.
            let mut send_line = String::new();
            reader.read_line(&mut send_line).await.expect("read send");
            let send_frame: Value =
                serde_json::from_str(send_line.trim()).expect("json send request");
            let send_req_id = send_frame["id"].clone();

            // Send a notification first, then the response.
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"chat.notification\",\"params\":{\"subscription\":\"sub-1\",\"data\":{\"text\":\"notif-before-response\"}}}\n")
                .await
                .expect("write notification");
            write_half
                .write_all(
                    format!(
                        "{{\"jsonrpc\":\"2.0\",\"result\":{{\"ok\":true}},\"id\":{send_req_id}}}\n"
                    )
                    .as_bytes(),
                )
                .await
                .expect("write send response");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };
        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let mut sub = client
            .subscribe::<_, Value>("chat.open", json!({}))
            .await
            .expect("subscribe");

        // call() should skip the notification, return the response result, and
        // buffer the notification so recv() can deliver it.
        let result: Value = sub
            .call("chat.send", json!({"id": "sub-1", "text": "hi"}))
            .await
            .expect("call succeeds despite interleaved notification");
        assert_eq!(result["ok"], true);

        // The buffered notification should be returned by the next recv().
        let notif: Value = sub.recv().await.expect("recv buffered notification");
        assert_eq!(notif["text"], "notif-before-response");

        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn subscription_close_sends_unsubscribe_and_checks_response() {
        let sock_path = unique_socket_path("subscribe-close");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            let mut subscribe_line = String::new();
            reader
                .read_line(&mut subscribe_line)
                .await
                .expect("read subscribe");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"id\":\"sub-9\"},\"id\":1}\n")
                .await
                .expect("write subscribe response");

            let mut unsubscribe_line = String::new();
            reader
                .read_line(&mut unsubscribe_line)
                .await
                .expect("read unsubscribe");
            let unsubscribe_frame: Value =
                serde_json::from_str(unsubscribe_line.trim()).expect("json unsubscribe");
            assert_eq!(unsubscribe_frame["method"], "audit.tail.unsubscribe");
            assert_eq!(unsubscribe_frame["id"], 2);
            assert_eq!(unsubscribe_frame["params"], json!({"id": "sub-9"}));

            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"ok\":true},\"id\":2}\n")
                .await
                .expect("write unsubscribe response");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };
        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let sub = client
            .subscribe::<_, Value>("audit.tail.subscribe", json!({}))
            .await
            .expect("subscribe");

        sub.close().await.expect("close succeeds");

        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    #[tokio::test(flavor = "current_thread")]
    async fn subscription_close_skips_interleaved_notifications() {
        let sock_path = unique_socket_path("subscribe-close-interleave");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            let mut subscribe_line = String::new();
            reader
                .read_line(&mut subscribe_line)
                .await
                .expect("read subscribe");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"id\":\"sub-7\"},\"id\":1}\n")
                .await
                .expect("write subscribe response");

            let mut unsubscribe_line = String::new();
            reader
                .read_line(&mut unsubscribe_line)
                .await
                .expect("read unsubscribe");

            // Two notifications race ahead of the close response.
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"audit.notification\",\"params\":{\"subscription\":\"sub-7\",\"data\":{\"n\":1}}}\n")
                .await
                .expect("write first notification");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"method\":\"audit.notification\",\"params\":{\"subscription\":\"sub-7\",\"data\":{\"n\":2}}}\n")
                .await
                .expect("write second notification");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"ok\":true},\"id\":2}\n")
                .await
                .expect("write unsubscribe response");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };
        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let sub = client
            .subscribe::<_, Value>("audit.tail.subscribe", json!({}))
            .await
            .expect("subscribe");

        sub.close()
            .await
            .expect("close succeeds despite interleaved notifications");

        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    // AC-1: recv() must be cancellation-safe.
    // If recv() is cancelled while a notification frame is partially received,
    // the next call to recv() must still deliver the complete frame without error.
    #[tokio::test(flavor = "current_thread")]
    async fn subscription_recv_is_cancellation_safe_when_frame_arrives_in_parts() {
        let sock_path = unique_socket_path("recv-cancel-safe");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            // Read the subscribe request.
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read subscribe");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"id\":\"sub-cs\"},\"id\":1}\n")
                .await
                .expect("write subscribe response");

            // Send the notification frame in two halves to allow the client's
            // first recv() to be cancelled mid-read.
            let full_frame = b"{\"jsonrpc\":\"2.0\",\"method\":\"chat.notification\",\"params\":{\"subscription\":\"sub-cs\",\"data\":{\"msg\":\"complete\"}}}\n";
            let (first_half, second_half) = full_frame.split_at(full_frame.len() / 2);
            write_half
                .write_all(first_half)
                .await
                .expect("write first half");
            // Give the client just enough time to start reading but not finish.
            tokio::time::sleep(Duration::from_millis(20)).await;
            write_half
                .write_all(second_half)
                .await
                .expect("write second half");
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };
        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let mut sub = client
            .subscribe::<_, Value>("chat.open", json!({}))
            .await
            .expect("subscribe");

        // Cancel the first recv() after a very short timeout — it should be in the
        // middle of reading when the timeout fires.
        let first_attempt = tokio::time::timeout(Duration::from_millis(5), sub.recv()).await;
        // Either it finished (if timing worked out) or it timed out — both are acceptable.
        // The important assertion is that the *next* recv() returns the full frame without error.

        let notification: Value = match first_attempt {
            Ok(result) => result.expect("recv should succeed if not cancelled"),
            Err(_timeout) => {
                // First attempt was cancelled; the second must still deliver the complete frame.
                timeout(Duration::from_secs(1), sub.recv())
                    .await
                    .expect("second recv must complete within 1s")
                    .expect("second recv must succeed without malformed-frame error")
            }
        };

        assert_eq!(
            notification["msg"], "complete",
            "notification payload must be intact after cancellation"
        );

        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }

    // AC-2: every notification is delivered exactly once, in arrival order,
    // when notifications and send responses interleave repeatedly.
    #[tokio::test(flavor = "current_thread")]
    async fn subscription_delivers_all_notifications_exactly_once_under_interleaving() {
        let sock_path = unique_socket_path("recv-exact-once");
        let listener = UnixListener::bind(&sock_path).expect("bind listener");

        let server = tokio::spawn(async move {
            let (stream, _) = listener.accept().await.expect("accept");
            let (read_half, mut write_half) = tokio::io::split(stream);
            let mut reader = BufReader::new(read_half);

            // Read subscribe
            let mut line = String::new();
            reader.read_line(&mut line).await.expect("read subscribe");
            write_half
                .write_all(b"{\"jsonrpc\":\"2.0\",\"result\":{\"id\":\"sub-eo\"},\"id\":1}\n")
                .await
                .expect("write subscribe response");

            // For each of 3 send requests, send a notification then the response.
            for i in 0u32..3 {
                let mut req_line = String::new();
                reader.read_line(&mut req_line).await.expect("read send");
                let req: Value = serde_json::from_str(req_line.trim()).expect("parse send");
                let req_id = req["id"].as_u64().expect("id");

                // Notification before the response.
                let notif = format!(
                    "{{\"jsonrpc\":\"2.0\",\"method\":\"chat.notification\",\"params\":{{\"subscription\":\"sub-eo\",\"data\":{{\"n\":{i}}}}}}}\n"
                );
                write_half
                    .write_all(notif.as_bytes())
                    .await
                    .expect("write notification");
                write_half
                    .write_all(
                        format!(
                            "{{\"jsonrpc\":\"2.0\",\"result\":{{\"ok\":true}},\"id\":{req_id}}}\n"
                        )
                        .as_bytes(),
                    )
                    .await
                    .expect("write send response");
            }
        });

        let cfg = BobConfig {
            admin_sock_path: sock_path,
            ..BobConfig::test_base()
        };
        let mut client = AdminClient::connect(&cfg).await.expect("connect");
        let mut sub = client
            .subscribe::<_, Value>("chat.open", json!({}))
            .await
            .expect("subscribe");

        let mut received: Vec<u64> = Vec::new();
        for _ in 0u32..3 {
            // Send a chat message.
            let _: Value = sub
                .call("chat.send", json!({"id": "sub-eo", "text": "hi"}))
                .await
                .expect("call succeeds");
            // Receive the corresponding notification (buffered during call).
            let notif: Value = timeout(Duration::from_secs(1), sub.recv())
                .await
                .expect("recv must complete")
                .expect("recv must succeed");
            received.push(notif["n"].as_u64().expect("n field"));
        }

        assert_eq!(
            received,
            vec![0, 1, 2],
            "notifications must arrive in order, exactly once"
        );

        timeout(Duration::from_secs(1), server)
            .await
            .expect("server completed")
            .expect("server join");
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
    }
}
