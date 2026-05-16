use serde::{Deserialize, Serialize};

use super::{ChannelId, UserId};

/// Normalized event from any inbound channel, ready for internal routing.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum InternalEvent {
    /// A chat message received from a messaging channel.
    ChatMessage { content: String },
    /// An email received by a monitored mailbox.
    EmailReceived { subject: String, body: String },
    /// An HTTP webhook payload from an external system.
    Webhook { source: String, payload: String },
    /// A time-triggered event defined by a cron expression.
    Scheduled { cron: String },
}

/// The context attached to every inbound request: who sent it and from where.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestContext {
    /// The user who originated the request.
    pub sender: UserId,
    /// The channel through which the request arrived.
    pub source: ChannelId,
    /// Optional conversational or transactional context identifier.
    pub context_id: Option<String>,
}

#[cfg(test)]
mod tests {
    use crate::types::{ChannelId, UserId};

    use super::*;

    #[test]
    fn internal_event_chat_message_serde_json_round_trip() {
        let event = InternalEvent::ChatMessage {
            content: "hello world".to_owned(),
        };
        let json = serde_json::to_string(&event).expect("serialization must succeed");
        let restored: InternalEvent =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert!(matches!(restored, InternalEvent::ChatMessage { .. }));
    }

    #[test]
    fn internal_event_email_received_serde_json_round_trip() {
        let event = InternalEvent::EmailReceived {
            subject: "test subject".to_owned(),
            body: "test body".to_owned(),
        };
        let json = serde_json::to_string(&event).expect("serialization must succeed");
        let restored: InternalEvent =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert!(matches!(restored, InternalEvent::EmailReceived { .. }));
    }

    #[test]
    fn internal_event_webhook_serde_json_round_trip() {
        let event = InternalEvent::Webhook {
            source: "github".to_owned(),
            payload: r#"{"action":"push"}"#.to_owned(),
        };
        let json = serde_json::to_string(&event).expect("serialization must succeed");
        let restored: InternalEvent =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert!(matches!(restored, InternalEvent::Webhook { .. }));
    }

    #[test]
    fn internal_event_scheduled_serde_json_round_trip() {
        let event = InternalEvent::Scheduled {
            cron: "0 9 * * 1".to_owned(),
        };
        let json = serde_json::to_string(&event).expect("serialization must succeed");
        let restored: InternalEvent =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert!(matches!(restored, InternalEvent::Scheduled { .. }));
    }

    #[test]
    fn request_context_with_no_optional_fields_serde_json_round_trip() {
        let ctx = RequestContext {
            sender: UserId::new(),
            source: ChannelId::new(),
            context_id: None,
        };
        let json = serde_json::to_string(&ctx).expect("serialization must succeed");
        let restored: RequestContext =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(ctx.sender, restored.sender);
        assert_eq!(ctx.source, restored.source);
        assert!(restored.context_id.is_none());
    }

    #[test]
    fn request_context_with_context_id_serde_json_round_trip() {
        let ctx = RequestContext {
            sender: UserId::new(),
            source: ChannelId::new(),
            context_id: Some("conv-abc-123".to_owned()),
        };
        let json = serde_json::to_string(&ctx).expect("serialization must succeed");
        let restored: RequestContext =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(ctx.sender, restored.sender);
        assert_eq!(ctx.source, restored.source);
        assert_eq!(ctx.context_id, restored.context_id);
    }

    #[test]
    fn internal_event_implements_clone_and_debug() {
        let event = InternalEvent::ChatMessage {
            content: "hi".to_owned(),
        };
        let cloned = event.clone();
        let debug_str = format!("{cloned:?}");
        assert!(debug_str.contains("ChatMessage"));
    }

    #[test]
    fn request_context_implements_clone_and_debug() {
        let ctx = RequestContext {
            sender: UserId::new(),
            source: ChannelId::new(),
            context_id: None,
        };
        let cloned = ctx.clone();
        let debug_str = format!("{cloned:?}");
        assert!(debug_str.contains("RequestContext"));
    }
}
