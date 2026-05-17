//! JSON-RPC 2.0 request, response, and error types plus a newline-delimited
//! UTF-8 frame codec for use over `AsyncRead + AsyncWrite` streams.
//!
//! Frames are separated by a single newline (`\n`) character.  Each frame is a
//! complete JSON-RPC 2.0 object encoded as UTF-8.  A frame that does not parse
//! as a valid JSON-RPC 2.0 request causes the connection to be closed with a
//! parse-error response (`code -32700`).

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::io::{AsyncRead, AsyncWrite};

// ── Types ────────────────────────────────────────────────────────────────────

/// A JSON-RPC 2.0 request received from the client.
#[derive(Debug, Clone, Deserialize)]
pub struct Request {
    pub jsonrpc: String,
    pub method: String,
    #[serde(default)]
    pub params: Option<Value>,
    pub id: Value,
}

/// A JSON-RPC 2.0 success response.
#[derive(Debug, Clone, Serialize)]
pub struct Response {
    pub jsonrpc: String,
    pub result: Value,
    pub id: Value,
}

/// A JSON-RPC 2.0 error object nested inside [`ErrorResponse`].
#[derive(Debug, Clone, Serialize)]
pub struct ErrorObject {
    pub code: i64,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub data: Option<Value>,
}

/// A JSON-RPC 2.0 error response.
#[derive(Debug, Clone, Serialize)]
pub struct ErrorResponse {
    pub jsonrpc: String,
    pub error: ErrorObject,
    pub id: Value,
}

// ── Error code constants ─────────────────────────────────────────────────────

/// Parse error: the frame did not parse as valid JSON or valid JSON-RPC 2.0.
pub const CODE_PARSE_ERROR: i64 = -32700;
/// Method not found or not implemented.
pub const CODE_METHOD_NOT_FOUND: i64 = -32601;
/// Invalid params / invalid request.
pub const CODE_INVALID_REQUEST: i64 = -32602;
/// Timeout.
pub const CODE_TIMEOUT: i64 = -32099;

// ── Constructors ─────────────────────────────────────────────────────────────

impl Response {
    /// Build a JSON-RPC 2.0 success response.
    pub fn ok(id: Value, result: Value) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            result,
            id,
        }
    }
}

impl ErrorObject {
    pub fn new(code: i64, message: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            code,
            message: message.into(),
            data,
        }
    }
}

impl ErrorResponse {
    /// Build a JSON-RPC 2.0 error response.
    pub fn error(id: Value, code: i64, message: impl Into<String>, data: Option<Value>) -> Self {
        Self {
            jsonrpc: "2.0".to_string(),
            error: ErrorObject::new(code, message, data),
            id,
        }
    }

    /// Convenience: parse error (-32700).
    pub fn parse_error(data: Option<Value>) -> Self {
        Self::error(Value::Null, CODE_PARSE_ERROR, "Parse error", data)
    }
}

// ── Frame codec ───────────────────────────────────────────────────────────────

/// Outcome of reading the next frame from the stream.
pub enum FrameRead {
    /// A successfully decoded JSON-RPC 2.0 request.
    Ok(Request),
    /// The frame arrived but did not parse as a valid JSON-RPC 2.0 request.
    ParseError,
    /// The peer closed the connection (EOF).
    Eof,
    /// A low-level I/O error occurred.
    IoError(std::io::Error),
}

/// Read one newline-terminated frame from the reader.
///
/// Returns `FrameRead::Ok` when the frame parses as a JSON-RPC 2.0 request,
/// `FrameRead::ParseError` when the frame arrives but is malformed,
/// `FrameRead::Eof` on clean connection close, and `FrameRead::IoError` on
/// transport failures.
pub async fn read_frame<R: AsyncRead + Unpin>(reader: &mut BufReader<R>) -> FrameRead {
    let mut line = String::new();
    match reader.read_line(&mut line).await {
        Err(e) => FrameRead::IoError(e),
        Ok(0) => FrameRead::Eof,
        Ok(_) => {
            let trimmed = line.trim_end_matches('\n').trim_end_matches('\r');
            match serde_json::from_str::<Request>(trimmed) {
                Ok(req) if req.jsonrpc == "2.0" => FrameRead::Ok(req),
                _ => FrameRead::ParseError,
            }
        }
    }
}

/// Serialize `value` as a newline-terminated JSON frame and write it to
/// `writer`.
///
/// # Errors
///
/// Returns `std::io::Error` when serialization fails (only possible on very
/// unusual data) or when the write fails.
pub async fn write_frame<W: AsyncWrite + Unpin, T: Serialize>(
    writer: &mut W,
    value: &T,
) -> std::io::Result<()> {
    let mut bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
    bytes.push(b'\n');
    writer.write_all(&bytes).await
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use tokio::io::BufReader;

    // Helper: write `input` bytes into one half of a duplex pipe, close the
    // write half, then read a frame from the read half.
    async fn read_frame_from_bytes(input: &[u8]) -> FrameRead {
        use tokio::io::AsyncWriteExt as _;
        let (mut write_half, read_half) = tokio::io::duplex(4096);
        write_half.write_all(input).await.expect("write");
        drop(write_half); // close write side so reader sees EOF after the frame
        let mut reader = BufReader::new(read_half);
        read_frame(&mut reader).await
    }

    // AC-3: a valid JSON-RPC 2.0 frame parses successfully.
    #[tokio::test(flavor = "current_thread")]
    async fn read_frame_returns_ok_for_valid_jsonrpc2_request() {
        let frame = b"{\"jsonrpc\":\"2.0\",\"method\":\"service.status\",\"id\":1}\n";
        match read_frame_from_bytes(frame).await {
            FrameRead::Ok(req) => {
                assert_eq!(req.method, "service.status");
                assert_eq!(req.id, json!(1));
            }
            other => panic!("expected FrameRead::Ok, got: {other:?}"),
        }
    }

    // AC-3: a frame with malformed JSON returns ParseError.
    #[tokio::test(flavor = "current_thread")]
    async fn read_frame_returns_parse_error_for_invalid_json() {
        let frame = b"not json at all\n";
        assert!(
            matches!(read_frame_from_bytes(frame).await, FrameRead::ParseError),
            "expected ParseError for invalid JSON"
        );
    }

    // AC-3: a JSON object that is not JSON-RPC 2.0 (wrong version) returns ParseError.
    #[tokio::test(flavor = "current_thread")]
    async fn read_frame_returns_parse_error_when_jsonrpc_version_is_wrong() {
        let frame = b"{\"jsonrpc\":\"1.0\",\"method\":\"service.status\",\"id\":1}\n";
        assert!(
            matches!(read_frame_from_bytes(frame).await, FrameRead::ParseError),
            "expected ParseError for jsonrpc != 2.0"
        );
    }

    // AC-3: clean EOF returns Eof variant.
    #[tokio::test(flavor = "current_thread")]
    async fn read_frame_returns_eof_when_connection_is_closed() {
        let frame = b"";
        assert!(
            matches!(read_frame_from_bytes(frame).await, FrameRead::Eof),
            "expected Eof for empty input"
        );
    }

    // AC-5: id field round-trips as a string.
    #[tokio::test(flavor = "current_thread")]
    async fn read_frame_preserves_string_id() {
        let frame = b"{\"jsonrpc\":\"2.0\",\"method\":\"service.status\",\"id\":\"abc-123\"}\n";
        match read_frame_from_bytes(frame).await {
            FrameRead::Ok(req) => assert_eq!(req.id, json!("abc-123")),
            other => panic!("expected FrameRead::Ok, got: {other:?}"),
        }
    }

    // AC-5: id field round-trips as null.
    #[tokio::test(flavor = "current_thread")]
    async fn read_frame_preserves_null_id() {
        let frame = b"{\"jsonrpc\":\"2.0\",\"method\":\"service.status\",\"id\":null}\n";
        match read_frame_from_bytes(frame).await {
            FrameRead::Ok(req) => assert_eq!(req.id, Value::Null),
            other => panic!("expected FrameRead::Ok, got: {other:?}"),
        }
    }

    // write_frame: serializes to newline-delimited JSON.
    #[tokio::test(flavor = "current_thread")]
    async fn write_frame_produces_newline_delimited_json() {
        let resp = Response::ok(json!(1), json!({"ok": true}));
        let mut buf = Vec::new();
        write_frame(&mut buf, &resp)
            .await
            .expect("write must succeed");
        assert!(buf.ends_with(b"\n"), "frame must end with newline");
        let parsed: serde_json::Value =
            serde_json::from_slice(&buf[..buf.len() - 1]).expect("valid JSON before newline");
        assert_eq!(parsed["id"], json!(1));
        assert_eq!(parsed["result"]["ok"], json!(true));
    }

    // ErrorResponse::parse_error sets code -32700 and null id.
    #[test]
    fn error_response_parse_error_has_correct_code_and_null_id() {
        let resp = ErrorResponse::parse_error(None);
        assert_eq!(resp.error.code, CODE_PARSE_ERROR);
        assert_eq!(resp.id, Value::Null);
        assert_eq!(resp.jsonrpc, "2.0");
    }

    // ErrorResponse serializes correctly.
    #[test]
    fn error_response_serializes_with_error_field() {
        let resp = ErrorResponse::error(json!(2), -32601, "Method not found", None);
        let v = serde_json::to_value(&resp).expect("serialize");
        assert_eq!(v["jsonrpc"], "2.0");
        assert_eq!(v["error"]["code"], -32601);
        assert_eq!(v["id"], 2);
        assert!(
            v.get("result").is_none(),
            "error response must not have result field"
        );
    }

    impl std::fmt::Debug for FrameRead {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            match self {
                Self::Ok(r) => write!(f, "FrameRead::Ok({:?})", r.method),
                Self::ParseError => write!(f, "FrameRead::ParseError"),
                Self::Eof => write!(f, "FrameRead::Eof"),
                Self::IoError(e) => write!(f, "FrameRead::IoError({e})"),
            }
        }
    }
}
