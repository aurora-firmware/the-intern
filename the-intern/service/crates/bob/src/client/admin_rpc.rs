use std::marker::PhantomData;

use bob_core::error::{ServiceError, ServiceResult};
use serde::Serialize;
use serde_json::{json, Value};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::UnixStream,
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

        Ok(Subscription {
            reader: self.reader.take().ok_or(ServiceError::ServiceDown)?,
            writer: self.writer.take().ok_or(ServiceError::ServiceDown)?,
            subscription_id,
            close_method,
            close_request_id,
            _marker: PhantomData,
        })
    }

    fn next_request_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }
}

#[derive(Debug)]
pub struct Subscription<N> {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
    subscription_id: String,
    close_method: String,
    close_request_id: u64,
    _marker: PhantomData<N>,
}

impl<N> Subscription<N>
where
    N: serde::de::DeserializeOwned,
{
    pub async fn recv(&mut self) -> ServiceResult<N> {
        let frame = read_value_frame(&mut self.reader).await?;
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
        let frame = read_value_frame(&mut self.reader).await?;

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
}
