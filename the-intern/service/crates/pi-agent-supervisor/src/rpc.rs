use bob_core::error::{ServiceError, ServiceResult};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_PROMPT_ID: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptCommand {
    pub id: String,
    pub message: String,
}

impl PromptCommand {
    pub fn new(message: impl Into<String>) -> Self {
        let next = NEXT_PROMPT_ID.fetch_add(1, Ordering::Relaxed);
        Self {
            id: format!("prompt-{next}"),
            message: message.into(),
        }
    }

    pub fn to_json(&self) -> Value {
        json!({
            "id": self.id,
            "type": "prompt",
            "message": self.message
        })
    }
}

pub fn parse_prompt_response(record: &Value, request_id: &str) -> ServiceResult<Option<bool>> {
    let Some(record_type) = record.get("type").and_then(Value::as_str) else {
        return Ok(None);
    };
    if record_type != "response" {
        return Ok(None);
    }

    let Some(id) = record.get("id").and_then(Value::as_str) else {
        return Err(ServiceError::ChildProcess {
            detail: "invalid RPC response record: missing string id".to_string(),
        });
    };
    if id != request_id {
        return Ok(None);
    }

    let Some(success) = record.get("success").and_then(Value::as_bool) else {
        return Err(ServiceError::ChildProcess {
            detail: "invalid RPC response record: missing boolean success".to_string(),
        });
    };

    Ok(Some(success))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn prompt_command_to_json_contains_prompt_type_and_message() {
        let command = PromptCommand::new("hello");
        let value = command.to_json();

        assert_eq!(value["type"], json!("prompt"));
        assert_eq!(value["message"], json!("hello"));
        assert_eq!(value["id"], json!(command.id));
    }

    #[test]
    fn parse_prompt_response_ignores_non_matching_or_non_response_records() {
        let request_id = "prompt-42";

        assert_eq!(
            parse_prompt_response(&json!({"type": "event"}), request_id)
                .expect("event record should not fail"),
            None
        );
        assert_eq!(
            parse_prompt_response(
                &json!({"id": "other", "type": "response", "success": true}),
                request_id
            )
            .expect("non-matching response should not fail"),
            None
        );
    }

    #[test]
    fn parse_prompt_response_returns_success_for_matching_response() {
        let parsed = parse_prompt_response(
            &json!({"id": "prompt-1", "type": "response", "success": true}),
            "prompt-1",
        )
        .expect("matching response should parse");

        assert_eq!(parsed, Some(true));
    }

    #[test]
    fn parse_prompt_response_returns_child_process_error_for_invalid_response_shape() {
        let error = parse_prompt_response(
            &json!({"id": "prompt-9", "type": "response", "success": "yes"}),
            "prompt-9",
        )
        .expect_err("invalid response should fail");

        assert!(matches!(error, ServiceError::ChildProcess { .. }));
    }
}
