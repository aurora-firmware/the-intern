use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};
use uuid::Uuid;

/// A unique identifier for a user session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionId(Uuid);

/// A unique identifier for a single request within a session.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct RequestId(Uuid);

/// A unique identifier for an event subscription.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SubscriptionId(Uuid);

/// A unique identifier for a communication channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct ChannelId(Uuid);

/// A unique identifier for a user.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct UserId(Uuid);

macro_rules! impl_id {
    ($t:ty) => {
        impl $t {
            /// Creates a new randomly-generated identifier.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::new_v4())
            }
        }

        impl Default for $t {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $t {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0)
            }
        }

        impl FromStr for $t {
            type Err = uuid::Error;

            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Uuid::from_str(s).map(Self)
            }
        }
    };
}

impl_id!(SessionId);
impl_id!(RequestId);
impl_id!(SubscriptionId);
impl_id!(ChannelId);
impl_id!(UserId);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_id_new_produces_unique_values() {
        let a = SessionId::new();
        let b = SessionId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn request_id_new_produces_unique_values() {
        let a = RequestId::new();
        let b = RequestId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn subscription_id_new_produces_unique_values() {
        let a = SubscriptionId::new();
        let b = SubscriptionId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn channel_id_new_produces_unique_values() {
        let a = ChannelId::new();
        let b = ChannelId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn user_id_new_produces_unique_values() {
        let a = UserId::new();
        let b = UserId::new();
        assert_ne!(a, b);
    }

    #[test]
    fn session_id_display_and_from_str_round_trip() {
        let original = SessionId::new();
        let s = original.to_string();
        let parsed: SessionId = s.parse().expect("valid uuid string should parse");
        assert_eq!(original, parsed);
    }

    #[test]
    fn request_id_display_and_from_str_round_trip() {
        let original = RequestId::new();
        let s = original.to_string();
        let parsed: RequestId = s.parse().expect("valid uuid string should parse");
        assert_eq!(original, parsed);
    }

    #[test]
    fn subscription_id_display_and_from_str_round_trip() {
        let original = SubscriptionId::new();
        let s = original.to_string();
        let parsed: SubscriptionId = s.parse().expect("valid uuid string should parse");
        assert_eq!(original, parsed);
    }

    #[test]
    fn channel_id_display_and_from_str_round_trip() {
        let original = ChannelId::new();
        let s = original.to_string();
        let parsed: ChannelId = s.parse().expect("valid uuid string should parse");
        assert_eq!(original, parsed);
    }

    #[test]
    fn user_id_display_and_from_str_round_trip() {
        let original = UserId::new();
        let s = original.to_string();
        let parsed: UserId = s.parse().expect("valid uuid string should parse");
        assert_eq!(original, parsed);
    }

    #[test]
    fn session_id_serde_json_round_trip() {
        let original = SessionId::new();
        let json = serde_json::to_string(&original).expect("serialization must succeed");
        let restored: SessionId =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(original, restored);
    }

    #[test]
    fn request_id_serde_json_round_trip() {
        let original = RequestId::new();
        let json = serde_json::to_string(&original).expect("serialization must succeed");
        let restored: RequestId =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(original, restored);
    }

    #[test]
    fn subscription_id_serde_json_round_trip() {
        let original = SubscriptionId::new();
        let json = serde_json::to_string(&original).expect("serialization must succeed");
        let restored: SubscriptionId =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(original, restored);
    }

    #[test]
    fn channel_id_serde_json_round_trip() {
        let original = ChannelId::new();
        let json = serde_json::to_string(&original).expect("serialization must succeed");
        let restored: ChannelId =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(original, restored);
    }

    #[test]
    fn user_id_serde_json_round_trip() {
        let original = UserId::new();
        let json = serde_json::to_string(&original).expect("serialization must succeed");
        let restored: UserId = serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(original, restored);
    }

    #[test]
    fn from_str_returns_error_for_invalid_uuid() {
        let result: Result<SessionId, _> = "not-a-uuid".parse();
        assert!(result.is_err());
    }

    #[test]
    fn identifier_types_implement_copy() {
        let id = SessionId::new();
        let _copy = id;
        // original still usable after copy (not moved)
        let _ = id;
    }

    #[test]
    fn identifier_types_implement_hash_and_eq() {
        use std::collections::HashSet;
        let mut set = HashSet::new();
        let id = ChannelId::new();
        set.insert(id);
        assert!(set.contains(&id));
    }
}
