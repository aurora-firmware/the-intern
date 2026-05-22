use bob_core::types::{PolicyVerdict, SessionId};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug)]
pub enum FrameError {
    Json(serde_json::Error),
}

impl std::fmt::Display for FrameError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Json(e) => write!(f, "json frame parse error: {e}"),
        }
    }
}

impl std::error::Error for FrameError {}

impl From<serde_json::Error> for FrameError {
    fn from(value: serde_json::Error) -> Self {
        Self::Json(value)
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum InboundFrame {
    Authz {
        session: SessionId,
        tool: String,
        arguments: Value,
    },
    Event {
        session: SessionId,
        payload: Value,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum OutboundFrame {
    AuthzVerdict {
        session: SessionId,
        verdict: PolicyVerdict,
    },
}

pub fn parse_inbound_frame(line: &str) -> Result<InboundFrame, FrameError> {
    let trimmed = line.trim_end_matches(['\n', '\r']);
    Ok(serde_json::from_str(trimmed)?)
}

pub fn encode_outbound_frame(frame: &OutboundFrame) -> Result<String, FrameError> {
    let mut wire = serde_json::to_string(frame)?;
    wire.push('\n');
    Ok(wire)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_authz_frame_with_session_tag() {
        let session = SessionId::new();
        let raw = format!(
            "{{\"kind\":\"authz\",\"session\":\"{session}\",\"tool\":\"bash\",\"arguments\":{{\"cmd\":\"ls\"}}}}\n"
        );

        let frame = parse_inbound_frame(&raw).expect("frame parses");

        match frame {
            InboundFrame::Authz {
                session: got,
                tool,
                arguments,
            } => {
                assert_eq!(got, session);
                assert_eq!(tool, "bash");
                assert_eq!(arguments["cmd"], "ls");
            }
            other => panic!("unexpected frame: {other:?}"),
        }
    }

    #[test]
    fn parses_authz_frame_without_user_field() {
        let session = SessionId::new();
        let raw = format!(
            "{{\"kind\":\"authz\",\"session\":\"{session}\",\"tool\":\"read\",\"arguments\":{{}}}}\n"
        );

        let frame = parse_inbound_frame(&raw).expect("authz frame without user field must parse");

        assert!(
            matches!(frame, InboundFrame::Authz { .. }),
            "frame must be Authz variant"
        );
    }

    #[test]
    fn missing_session_field_fails_to_parse() {
        let raw = "{\"kind\":\"event\",\"payload\":{\"name\":\"x\"}}\n";

        let err = parse_inbound_frame(raw).expect_err("session is required");

        assert!(err.to_string().contains("session"));
    }

    #[test]
    fn encodes_authz_verdict_with_newline() {
        let session = SessionId::new();
        let frame = OutboundFrame::AuthzVerdict {
            session,
            verdict: PolicyVerdict {
                allow: false,
                reason: Some("policy not implemented".to_owned()),
            },
        };

        let wire = encode_outbound_frame(&frame).expect("encodes");

        assert!(wire.ends_with('\n'));
        let parsed: serde_json::Value =
            serde_json::from_str(wire.trim_end_matches('\n')).expect("json");
        assert_eq!(parsed["kind"], "authz_verdict");
        assert_eq!(parsed["session"], session.to_string());
        assert_eq!(parsed["verdict"]["allow"], false);
        assert_eq!(parsed["verdict"]["reason"], "policy not implemented");
    }
}
