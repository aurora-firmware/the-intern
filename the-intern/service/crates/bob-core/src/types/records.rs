use serde::{Deserialize, Serialize};

/// The result of a policy evaluation for a request or action.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PolicyVerdict {
    /// Whether the action is permitted.
    pub allow: bool,
    /// Human-readable explanation for the verdict.
    pub reason: Option<String>,
}

/// Stable discriminant for audit log entries.
///
/// Variants must never be removed or reordered — existing audit stores
/// depend on stable serialized names.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AuditKind {
    /// An inbound request was received from a channel.
    RequestReceived,
    /// A policy decision was reached for a request or action.
    PolicyDecision,
    /// A tool or external action was invoked.
    ActionInvoked,
    /// An invoked action completed successfully.
    ActionCompleted,
    /// An invoked action failed.
    ActionFailed,
    /// A new user session was established.
    SessionStarted,
    /// A user session ended normally or timed out.
    SessionEnded,
    /// A request was denied by the pre-flight identity and access check.
    PreflightDenied,
}

/// An append-only audit log entry capturing a significant service event.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditRecord {
    /// RFC 3339 UTC timestamp when the event occurred.
    pub timestamp: String,
    /// Category of the event.
    pub kind: AuditKind,
    /// Human-readable description of the event.
    pub description: String,
}

/// A self-report submitted by an external CLI or pi-agent describing an
/// action it performed or attempted.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MonitoringReport {
    /// Name of the action that was performed or attempted.
    pub action: String,
    /// Outcome of the action (e.g. `"success"`, `"denied"`, `"error"`).
    pub outcome: String,
    /// Optional detail string with supporting context for the outcome.
    pub details: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn policy_verdict_allow_serde_json_round_trip() {
        let verdict = PolicyVerdict {
            allow: true,
            reason: Some("user has permission".to_owned()),
        };
        let json = serde_json::to_string(&verdict).expect("serialization must succeed");
        let restored: PolicyVerdict =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(verdict.allow, restored.allow);
        assert_eq!(verdict.reason, restored.reason);
    }

    #[test]
    fn policy_verdict_deny_with_no_reason_serde_json_round_trip() {
        let verdict = PolicyVerdict {
            allow: false,
            reason: None,
        };
        let json = serde_json::to_string(&verdict).expect("serialization must succeed");
        let restored: PolicyVerdict =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert!(!restored.allow);
        assert!(restored.reason.is_none());
    }

    #[test]
    fn audit_record_serde_json_round_trip() {
        let record = AuditRecord {
            timestamp: "2026-05-16T09:00:00Z".to_owned(),
            kind: AuditKind::RequestReceived,
            description: "inbound chat message".to_owned(),
        };
        let json = serde_json::to_string(&record).expect("serialization must succeed");
        let restored: AuditRecord =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(record.timestamp, restored.timestamp);
        assert_eq!(record.description, restored.description);
        assert!(matches!(restored.kind, AuditKind::RequestReceived));
    }

    #[test]
    fn audit_kind_all_variants_serde_json_round_trip() {
        let variants = [
            AuditKind::RequestReceived,
            AuditKind::PolicyDecision,
            AuditKind::ActionInvoked,
            AuditKind::ActionCompleted,
            AuditKind::ActionFailed,
            AuditKind::SessionStarted,
            AuditKind::SessionEnded,
            AuditKind::PreflightDenied,
        ];
        for kind in variants {
            let json = serde_json::to_string(&kind).expect("serialization must succeed");
            let restored: AuditKind =
                serde_json::from_str(&json).expect("deserialization must succeed");
            assert_eq!(
                format!("{kind:?}"),
                format!("{restored:?}"),
                "variant round-trip mismatch"
            );
        }
    }

    #[test]
    fn monitoring_report_serde_json_round_trip() {
        let report = MonitoringReport {
            action: "file_read".to_owned(),
            outcome: "success".to_owned(),
            details: Some("read 1024 bytes".to_owned()),
        };
        let json = serde_json::to_string(&report).expect("serialization must succeed");
        let restored: MonitoringReport =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(report.action, restored.action);
        assert_eq!(report.outcome, restored.outcome);
        assert_eq!(report.details, restored.details);
    }

    #[test]
    fn monitoring_report_with_no_details_serde_json_round_trip() {
        let report = MonitoringReport {
            action: "net_request".to_owned(),
            outcome: "denied".to_owned(),
            details: None,
        };
        let json = serde_json::to_string(&report).expect("serialization must succeed");
        let restored: MonitoringReport =
            serde_json::from_str(&json).expect("deserialization must succeed");
        assert_eq!(report.action, restored.action);
        assert!(restored.details.is_none());
    }

    #[test]
    fn policy_verdict_implements_clone_and_debug() {
        let verdict = PolicyVerdict {
            allow: true,
            reason: None,
        };
        let cloned = verdict.clone();
        let debug_str = format!("{cloned:?}");
        assert!(debug_str.contains("PolicyVerdict"));
    }

    #[test]
    fn audit_record_implements_clone_and_debug() {
        let record = AuditRecord {
            timestamp: "2026-05-16T00:00:00Z".to_owned(),
            kind: AuditKind::PolicyDecision,
            description: "allow".to_owned(),
        };
        let cloned = record.clone();
        let debug_str = format!("{cloned:?}");
        assert!(debug_str.contains("AuditRecord"));
    }

    #[test]
    fn monitoring_report_implements_clone_and_debug() {
        let report = MonitoringReport {
            action: "spawn".to_owned(),
            outcome: "ok".to_owned(),
            details: None,
        };
        let cloned = report.clone();
        let debug_str = format!("{cloned:?}");
        assert!(debug_str.contains("MonitoringReport"));
    }
}
