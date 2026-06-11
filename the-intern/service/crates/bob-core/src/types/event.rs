use serde::{Deserialize, Serialize};

use super::{ChannelId, UserId};

/// Delivery semantics of an inbound request.
///
/// - `Sync` — the sender is waiting for a reply (e.g. a chat message).
/// - `Async` — fire-and-forget delivery (e.g. email, webhook).
/// - `Periodic` — a time-triggered event (e.g. a cron schedule).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DeliveryKind {
    Sync,
    Async,
    Periodic,
}

/// Normalized inbound request, ready for internal routing.
///
/// `kind` captures the delivery semantics; `payload` carries the
/// normalized request content produced by the originating adapter.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InternalEvent {
    pub kind: DeliveryKind,
    pub payload: String,
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
    /// Optional reply address: the string form of the originating chat
    /// subscription id.  Present only for events that arrive through
    /// `chat.send`; absent for all other event sources.
    pub reply_address: Option<String>,
}

#[cfg(test)]
mod tests {
    use crate::types::{ChannelId, UserId};

    use super::*;

    // AC-1 / AC-2: InternalEvent is a struct with kind and payload fields.
    // AC-2: DeliveryKind has exactly Sync, Async, Periodic variants.
    #[test]
    fn delivery_kind_has_sync_async_periodic_variants() {
        let sync = DeliveryKind::Sync;
        let async_ = DeliveryKind::Async;
        let periodic = DeliveryKind::Periodic;

        // All three variants are distinct.
        assert_ne!(sync, async_);
        assert_ne!(sync, periodic);
        assert_ne!(async_, periodic);
    }

    // AC-2: DeliveryKind derives Copy, Clone, Debug, PartialEq, Eq.
    #[test]
    fn delivery_kind_derives_copy_clone_debug_partialeq_eq() {
        let k = DeliveryKind::Sync;
        let copied = k; // Copy
        let cloned = Clone::clone(&k); // Clone
        let debug_str = format!("{k:?}"); // Debug
        assert_eq!(k, copied); // PartialEq / Eq
        assert_eq!(k, cloned);
        assert!(debug_str.contains("Sync"));
    }

    // AC-3: InternalEvent with DeliveryKind::Sync survives a JSON round-trip.
    #[test]
    fn internal_event_with_sync_kind_serde_json_round_trip() {
        let original = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "hello world".to_owned(),
        };
        let json = serde_json::to_string(&original).expect("serialization must succeed");
        let restored: InternalEvent =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(original, restored);
    }

    // AC-3: InternalEvent with DeliveryKind::Async survives a JSON round-trip.
    #[test]
    fn internal_event_with_async_kind_serde_json_round_trip() {
        let original = InternalEvent {
            kind: DeliveryKind::Async,
            payload: r#"{"subject":"test","body":"hello"}"#.to_owned(),
        };
        let json = serde_json::to_string(&original).expect("serialization must succeed");
        let restored: InternalEvent =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(original, restored);
    }

    // AC-3: InternalEvent with DeliveryKind::Periodic survives a JSON round-trip.
    #[test]
    fn internal_event_with_periodic_kind_serde_json_round_trip() {
        let original = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "0 9 * * 1".to_owned(),
        };
        let json = serde_json::to_string(&original).expect("serialization must succeed");
        let restored: InternalEvent =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(original, restored);
    }

    #[test]
    fn request_context_with_no_optional_fields_serde_json_round_trip() {
        let ctx = RequestContext {
            sender: UserId::new(),
            source: ChannelId::new(),
            context_id: None,
            reply_address: None,
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
            reply_address: None,
        };
        let json = serde_json::to_string(&ctx).expect("serialization must succeed");
        let restored: RequestContext =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(ctx.sender, restored.sender);
        assert_eq!(ctx.source, restored.source);
        assert_eq!(ctx.context_id, restored.context_id);
    }

    // AC-1: InternalEvent implements Clone and Debug.
    #[test]
    fn internal_event_implements_clone_and_debug() {
        let event = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "hi".to_owned(),
        };
        let cloned = event.clone();
        let debug_str = format!("{cloned:?}");
        assert!(debug_str.contains("InternalEvent"));
    }

    #[test]
    fn request_context_implements_clone_and_debug() {
        let ctx = RequestContext {
            sender: UserId::new(),
            source: ChannelId::new(),
            context_id: None,
            reply_address: None,
        };
        let cloned = ctx.clone();
        let debug_str = format!("{cloned:?}");
        assert!(debug_str.contains("RequestContext"));
    }

    // AC-2 (T-087): reply_address is None when not a chat event.
    #[test]
    fn request_context_reply_address_is_none_by_default_for_non_chat_context() {
        let ctx = RequestContext {
            sender: UserId::new(),
            source: ChannelId::new(),
            context_id: None,
            reply_address: None,
        };
        assert!(
            ctx.reply_address.is_none(),
            "reply_address must be None for non-chat RequestContext"
        );
    }

    // AC-2 (T-087): reply_address is Some when set from a chat subscription.
    #[test]
    fn request_context_reply_address_survives_serde_round_trip_when_set() {
        let ctx = RequestContext {
            sender: UserId::new(),
            source: ChannelId::new(),
            context_id: None,
            reply_address: Some("sub-abc-123".to_owned()),
        };
        let json = serde_json::to_string(&ctx).expect("serialization must succeed");
        let restored: RequestContext =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(ctx.reply_address, restored.reply_address);
    }
}
