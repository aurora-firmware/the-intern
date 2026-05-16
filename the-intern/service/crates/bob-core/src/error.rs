use thiserror::Error;

/// Typed error taxonomy for all bob-core service boundaries.
///
/// Each variant describes a category of failure. Fields use safe metadata
/// (high-level cause descriptions, operation names, or `&'static str` keys)
/// — never raw user content, credentials, or tokens.
///
/// # Errors
///
/// Callers inspect the variant to decide how to handle a failure:
/// - `PolicyDenied` — reject the request, log the reason category.
/// - `InvalidRequest` — return a 4xx-equivalent, include `detail` in the
///   response body only if it is safe to expose to the caller.
/// - `ServiceDown` — surface a 503-equivalent; retry may be appropriate.
/// - `Timeout` — the named `operation` exceeded its deadline.
/// - `Shutdown` — the service is draining; callers should stop sending work.
/// - `Persistence` — a storage operation failed; `detail` names the cause
///   class, not the data that was being stored.
/// - `ChildProcess` — pi-agent process management failed.
/// - `Configuration` — a required configuration key is missing or invalid.
/// - `NotImplemented` — placeholder for subsystems not yet implemented.
#[derive(Debug, Error)]
pub enum ServiceError {
    /// A policy rule denied the request.
    #[error("policy denied: {reason}")]
    PolicyDenied { reason: String },

    /// The request was structurally or semantically invalid.
    #[error("invalid request: {detail}")]
    InvalidRequest { detail: String },

    /// A required downstream service is not available.
    #[error("service unavailable")]
    ServiceDown,

    /// An operation did not complete within its deadline.
    ///
    /// `operation` is a `&'static str` so it can only contain compile-time
    /// constants — never runtime user data.
    #[error("operation timed out: {operation}")]
    Timeout { operation: &'static str },

    /// The service is shutting down; new work should not be accepted.
    #[error("service is shutting down")]
    Shutdown,

    /// A persistence (storage) operation failed.
    #[error("persistence error: {detail}")]
    Persistence { detail: String },

    /// A child-process (pi-agent) operation failed.
    #[error("child process error: {detail}")]
    ChildProcess { detail: String },

    /// A configuration key is missing or has an invalid value.
    #[error("configuration error: {detail}")]
    Configuration { detail: String },

    /// This subsystem is not yet implemented.
    #[error("not implemented")]
    NotImplemented,
}

/// Convenience alias used across all bob-core subsystems.
pub type ServiceResult<T> = Result<T, ServiceError>;

#[cfg(test)]
mod tests {
    use std::error::Error;

    use super::{ServiceError, ServiceResult};

    // --- AC-1: every variant constructs without panic ---

    #[test]
    fn policy_denied_variant_constructs() {
        let e = ServiceError::PolicyDenied {
            reason: "insufficient permissions".to_string(),
        };
        assert!(matches!(e, ServiceError::PolicyDenied { .. }));
    }

    #[test]
    fn invalid_request_variant_constructs() {
        let e = ServiceError::InvalidRequest {
            detail: "missing required field".to_string(),
        };
        assert!(matches!(e, ServiceError::InvalidRequest { .. }));
    }

    #[test]
    fn service_down_variant_constructs() {
        let e = ServiceError::ServiceDown;
        assert!(matches!(e, ServiceError::ServiceDown));
    }

    #[test]
    fn timeout_variant_constructs() {
        let e = ServiceError::Timeout {
            operation: "policy_check",
        };
        assert!(matches!(e, ServiceError::Timeout { .. }));
    }

    #[test]
    fn shutdown_variant_constructs() {
        let e = ServiceError::Shutdown;
        assert!(matches!(e, ServiceError::Shutdown));
    }

    #[test]
    fn persistence_variant_constructs() {
        let e = ServiceError::Persistence {
            detail: "write failed".to_string(),
        };
        assert!(matches!(e, ServiceError::Persistence { .. }));
    }

    #[test]
    fn child_process_variant_constructs() {
        let e = ServiceError::ChildProcess {
            detail: "spawn failed".to_string(),
        };
        assert!(matches!(e, ServiceError::ChildProcess { .. }));
    }

    #[test]
    fn configuration_variant_constructs() {
        let e = ServiceError::Configuration {
            detail: "missing socket path".to_string(),
        };
        assert!(matches!(e, ServiceError::Configuration { .. }));
    }

    #[test]
    fn not_implemented_variant_constructs() {
        let e = ServiceError::NotImplemented;
        assert!(matches!(e, ServiceError::NotImplemented));
    }

    // --- AC-2: Display strings for each variant do not panic ---

    #[test]
    fn policy_denied_display_does_not_panic() {
        let e = ServiceError::PolicyDenied {
            reason: "role not allowed".to_string(),
        };
        let msg = e.to_string();
        assert!(!msg.is_empty());
    }

    #[test]
    fn invalid_request_display_does_not_panic() {
        let e = ServiceError::InvalidRequest {
            detail: "bad json".to_string(),
        };
        let msg = e.to_string();
        assert!(!msg.is_empty());
    }

    #[test]
    fn service_down_display_does_not_panic() {
        let msg = ServiceError::ServiceDown.to_string();
        assert!(!msg.is_empty());
    }

    #[test]
    fn timeout_display_contains_operation_name() {
        let e = ServiceError::Timeout {
            operation: "policy_lookup",
        };
        let msg = e.to_string();
        // The operation field is a compile-time &'static str — safe to assert on.
        assert!(msg.contains("policy_lookup"), "display was: {msg}");
    }

    #[test]
    fn shutdown_display_does_not_panic() {
        let msg = ServiceError::Shutdown.to_string();
        assert!(!msg.is_empty());
    }

    #[test]
    fn persistence_display_does_not_panic() {
        let e = ServiceError::Persistence {
            detail: "disk full".to_string(),
        };
        let msg = e.to_string();
        assert!(!msg.is_empty());
    }

    #[test]
    fn child_process_display_does_not_panic() {
        let e = ServiceError::ChildProcess {
            detail: "exit code 1".to_string(),
        };
        let msg = e.to_string();
        assert!(!msg.is_empty());
    }

    #[test]
    fn configuration_display_does_not_panic() {
        let e = ServiceError::Configuration {
            detail: "admin_socket not set".to_string(),
        };
        let msg = e.to_string();
        assert!(!msg.is_empty());
    }

    #[test]
    fn not_implemented_display_does_not_panic() {
        let msg = ServiceError::NotImplemented.to_string();
        assert!(!msg.is_empty());
    }

    // --- AC-4: ServiceResult<T> alias resolves to Result<T, ServiceError> ---

    #[test]
    fn service_result_ok_variant_holds_value() {
        let r: ServiceResult<u32> = Ok(42);
        assert_eq!(r.unwrap(), 42);
    }

    #[test]
    fn service_result_err_variant_holds_service_error() {
        let r: ServiceResult<u32> = Err(ServiceError::NotImplemented);
        assert!(matches!(r, Err(ServiceError::NotImplemented)));
    }

    // --- Error::source returns None for all leaf variants (no wrapped cause) ---

    #[test]
    fn error_source_is_none_for_policy_denied() {
        let e = ServiceError::PolicyDenied {
            reason: "test".to_string(),
        };
        assert!(e.source().is_none());
    }

    #[test]
    fn error_source_is_none_for_timeout() {
        let e = ServiceError::Timeout {
            operation: "test_op",
        };
        assert!(e.source().is_none());
    }

    #[test]
    fn error_source_is_none_for_service_down() {
        assert!(ServiceError::ServiceDown.source().is_none());
    }

    #[test]
    fn error_source_is_none_for_not_implemented() {
        assert!(ServiceError::NotImplemented.source().is_none());
    }

    // --- AC-2: ServiceError is Debug (verify it doesn't panic) ---

    #[test]
    fn debug_format_does_not_panic() {
        let variants: &[ServiceError] = &[
            ServiceError::PolicyDenied {
                reason: "r".to_string(),
            },
            ServiceError::InvalidRequest {
                detail: "d".to_string(),
            },
            ServiceError::ServiceDown,
            ServiceError::Timeout { operation: "op" },
            ServiceError::Shutdown,
            ServiceError::Persistence {
                detail: "d".to_string(),
            },
            ServiceError::ChildProcess {
                detail: "d".to_string(),
            },
            ServiceError::Configuration {
                detail: "d".to_string(),
            },
            ServiceError::NotImplemented,
        ];
        for v in variants {
            let _ = format!("{v:?}");
        }
    }
}
