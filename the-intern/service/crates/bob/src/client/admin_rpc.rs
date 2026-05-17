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
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
    next_id: u64,
}

impl AdminClient {
    pub async fn connect(cfg: &BobConfig) -> ServiceResult<Self> {
        let stream = UnixStream::connect(&cfg.admin_sock_path)
            .await
            .map_err(|_| ServiceError::ServiceDown)?;
        let (read_half, write_half) = stream.into_split();

        Ok(Self {
            reader: BufReader::new(read_half),
            writer: write_half,
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

        self.write_frame(&request).await?;

        let response = self.read_value_frame().await?;
        parse_call_response(response, id)
    }

    pub async fn subscribe<P, N>(
        &mut self,
        _method: &str,
        _params: P,
    ) -> ServiceResult<Subscription<N>>
    where
        P: Serialize,
        N: serde::de::DeserializeOwned,
    {
        Err(ServiceError::NotImplemented)
    }

    fn next_request_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        id
    }

    async fn write_frame<T: Serialize>(&mut self, value: &T) -> ServiceResult<()> {
        let mut bytes = serde_json::to_vec(value).map_err(|e| {
            invalid_request_error(format!("failed to serialize request frame: {e}"))
        })?;
        bytes.push(b'\n');
        self.writer
            .write_all(&bytes)
            .await
            .map_err(|_| ServiceError::ServiceDown)
    }

    async fn read_value_frame(&mut self) -> ServiceResult<Value> {
        let mut line = String::new();
        let n = self
            .reader
            .read_line(&mut line)
            .await
            .map_err(|_| ServiceError::ServiceDown)?;
        if n == 0 {
            return Err(ServiceError::ServiceDown);
        }

        serde_json::from_str(line.trim())
            .map_err(|e| invalid_request_error(format!("malformed server frame: {e}")))
    }
}

#[derive(Debug)]
pub struct Subscription<N> {
    _marker: PhantomData<N>,
}

impl<N> Subscription<N>
where
    N: serde::de::DeserializeOwned,
{
    pub async fn recv(&mut self) -> ServiceResult<N> {
        Err(ServiceError::NotImplemented)
    }

    pub async fn close(self) -> ServiceResult<()> {
        Err(ServiceError::NotImplemented)
    }
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
        dir.join(format!("{name}-{id}.sock"))
    }

    #[tokio::test(flavor = "current_thread")]
    async fn connect_returns_service_down_when_socket_is_absent() {
        let cfg = BobConfig {
            admin_sock_path: unique_socket_path("missing-admin"),
            ..BobConfig::default()
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
            ..BobConfig::default()
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
            ..BobConfig::default()
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
            ..BobConfig::default()
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
            ..BobConfig::default()
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
}
