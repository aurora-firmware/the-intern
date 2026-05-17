//! JSON-RPC 2.0 method dispatcher for the admin RPC channel.
//!
//! The [`Dispatcher`] holds optional handles to downstream actors. When a
//! handle is `None` the corresponding method returns `NotImplemented`
//! (-32601). This keeps the call site in `bob::serve` backward-compatible
//! with `admin_rpc::Config::default()`.
//!
//! # Day-one method set
//!
//! | Method | Behaviour |
//! |---|---|
//! | `service.status` | Returns `{ ok, version, uptime_seconds }` |
//! | `sessions.list` | Invokes `pi_agent_supervisor::Handle::list_sessions` |
//! | `sessions.kill` | Not yet implemented (NotImplemented) |
//! | `policy.reload` | Not yet implemented (NotImplemented) |
//!
//! Methods `audit.tail.*` and `chat.*` are deferred to T-020 and are
//! returned as `NotImplemented` (-32601) if called.

use std::time::Instant;

use bob_core::error::ServiceError;
use serde_json::{json, Value};

use crate::protocol::{
    ErrorResponse, Request, Response, CODE_INVALID_REQUEST, CODE_METHOD_NOT_FOUND, CODE_TIMEOUT,
};

/// Context provided to the dispatcher at construction time.
///
/// Both handles are optional so the dispatcher degrades gracefully when a
/// subsystem is not started.
#[derive(Clone)]
pub struct Dispatcher {
    supervisor: Option<pi_agent_supervisor::Handle>,
    _policy: Option<policy_control::Handle>,
    started_at: Instant,
    version: &'static str,
}

/// The outcome of dispatching a single JSON-RPC 2.0 request.
pub enum DispatchOutcome {
    /// A JSON-RPC 2.0 success response.
    Ok(Response),
    /// A JSON-RPC 2.0 error response.
    Err(ErrorResponse),
}

impl Dispatcher {
    /// Create a new dispatcher.
    ///
    /// `version` is the service version string embedded in `service.status`
    /// responses.
    pub fn new(
        supervisor: Option<pi_agent_supervisor::Handle>,
        policy: Option<policy_control::Handle>,
        version: &'static str,
    ) -> Self {
        Self {
            supervisor,
            _policy: policy,
            started_at: Instant::now(),
            version,
        }
    }

    /// Dispatch `request` to the appropriate method handler.
    ///
    /// Unknown methods return a JSON-RPC -32601 error. Errors from method
    /// handlers are mapped to JSON-RPC error objects — see [`map_service_error`].
    pub async fn dispatch(&self, request: Request) -> DispatchOutcome {
        let id = request.id.clone();
        match request.method.as_str() {
            "service.status" => self.handle_service_status(id).await,
            "sessions.list" => self.handle_sessions_list(id).await,
            "sessions.kill" => DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "sessions.kill is not yet implemented",
                Some(json!({ "method": "sessions.kill" })),
            )),
            "policy.reload" => DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "policy.reload is not yet implemented",
                Some(json!({ "method": "policy.reload" })),
            )),
            other => DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "Method not found",
                Some(json!({ "method": other })),
            )),
        }
    }

    async fn handle_service_status(&self, id: Value) -> DispatchOutcome {
        let uptime = self.started_at.elapsed().as_secs();
        DispatchOutcome::Ok(Response::ok(
            id,
            json!({
                "ok": true,
                "version": self.version,
                "uptime_seconds": uptime
            }),
        ))
    }

    async fn handle_sessions_list(&self, id: Value) -> DispatchOutcome {
        let Some(ref supervisor) = self.supervisor else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "sessions.list is not available",
                Some(json!({ "method": "sessions.list" })),
            ));
        };
        match supervisor.list_sessions().await {
            Ok(sessions) => {
                let session_values: Vec<Value> =
                    sessions.iter().map(|s| json!(s.to_string())).collect();
                DispatchOutcome::Ok(Response::ok(id, json!(session_values)))
            }
            Err(e) => DispatchOutcome::Err(map_service_error(id, &e)),
        }
    }
}

/// Map a [`ServiceError`] to a JSON-RPC error response.
///
/// The `data` field carries only non-sensitive metadata: operation names,
/// error category labels, or identifiers. No raw user content is included.
pub fn map_service_error(id: Value, error: &ServiceError) -> ErrorResponse {
    match error {
        ServiceError::NotImplemented => ErrorResponse::error(
            id,
            CODE_METHOD_NOT_FOUND,
            "Not implemented",
            Some(json!({ "category": "not_implemented" })),
        ),
        ServiceError::InvalidRequest { .. } => ErrorResponse::error(
            id,
            CODE_INVALID_REQUEST,
            "Invalid request",
            Some(json!({ "category": "invalid_request" })),
        ),
        ServiceError::Timeout { operation } => ErrorResponse::error(
            id,
            CODE_TIMEOUT,
            "Request timed out",
            Some(json!({ "category": "timeout", "operation": operation })),
        ),
        ServiceError::PolicyDenied { .. } => ErrorResponse::error(
            id,
            CODE_INVALID_REQUEST,
            "Policy denied",
            Some(json!({ "category": "policy_denied" })),
        ),
        ServiceError::ServiceDown => ErrorResponse::error(
            id,
            CODE_METHOD_NOT_FOUND,
            "Service unavailable",
            Some(json!({ "category": "service_down" })),
        ),
        ServiceError::Shutdown => ErrorResponse::error(
            id,
            CODE_METHOD_NOT_FOUND,
            "Service is shutting down",
            Some(json!({ "category": "shutdown" })),
        ),
        ServiceError::Persistence { .. } => ErrorResponse::error(
            id,
            CODE_METHOD_NOT_FOUND,
            "Persistence error",
            Some(json!({ "category": "persistence" })),
        ),
        ServiceError::ChildProcess { .. } => ErrorResponse::error(
            id,
            CODE_METHOD_NOT_FOUND,
            "Child process error",
            Some(json!({ "category": "child_process" })),
        ),
        ServiceError::Configuration { .. } => ErrorResponse::error(
            id,
            CODE_METHOD_NOT_FOUND,
            "Configuration error",
            Some(json!({ "category": "configuration" })),
        ),
    }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use bob_core::error::ServiceError;
    use serde_json::json;

    fn make_request(method: &str, id: Value) -> Request {
        Request {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params: None,
            id,
        }
    }

    fn make_dispatcher_no_handles() -> Dispatcher {
        Dispatcher::new(None, None, "0.1.0-test")
    }

    fn make_dispatcher_with_supervisor() -> (Dispatcher, tokio::task::JoinHandle<()>) {
        let (handle, join) = pi_agent_supervisor::start(pi_agent_supervisor::Config::default());
        let dispatcher = Dispatcher::new(Some(handle), None, "0.1.0-test");
        (dispatcher, join)
    }

    // AC-1: service.status responds with a structured status object.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_service_status_returns_ok_with_status_object() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("service.status", json!(1));

        let outcome = dispatcher.dispatch(req).await;

        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(1));
                assert_eq!(resp.jsonrpc, "2.0");
                assert_eq!(resp.result["ok"], json!(true));
                assert_eq!(resp.result["version"], json!("0.1.0-test"));
                assert!(
                    resp.result["uptime_seconds"].is_number(),
                    "uptime_seconds must be a number"
                );
            }
            DispatchOutcome::Err(e) => panic!("expected Ok, got error: {:?}", e.error.message),
        }
    }

    // AC-1: service.status response carries jsonrpc: "2.0".
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_service_status_response_is_jsonrpc_2_0() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("service.status", json!("req-id-42"));

        let outcome = dispatcher.dispatch(req).await;

        match outcome {
            DispatchOutcome::Ok(resp) => assert_eq!(resp.jsonrpc, "2.0"),
            DispatchOutcome::Err(e) => panic!("expected Ok, got error: {}", e.error.message),
        }
    }

    // AC-2: sessions.list with a supervisor handle returns the session list.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_list_returns_empty_list_when_no_sessions() {
        let (dispatcher, task) = make_dispatcher_with_supervisor();
        let req = make_request("sessions.list", json!(2));

        let outcome = dispatcher.dispatch(req).await;

        task.abort();
        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(2));
                assert!(resp.result.is_array(), "result must be an array");
            }
            DispatchOutcome::Err(e) => panic!("expected Ok, got error: {}", e.error.message),
        }
    }

    // AC-2: sessions.list without a handle returns NotImplemented (-32601).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_list_without_handle_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("sessions.list", json!(3));

        let outcome = dispatcher.dispatch(req).await;

        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
            }
            DispatchOutcome::Ok(_) => panic!("expected error, got Ok"),
        }
    }

    // AC-3 / AC-4: unknown method returns -32601.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_unknown_method_returns_method_not_found() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("no.such.method", json!(4));

        let outcome = dispatcher.dispatch(req).await;

        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(4));
                assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
            }
            DispatchOutcome::Ok(_) => panic!("expected error, got Ok"),
        }
    }

    // AC-4: map_service_error maps NotImplemented to -32601.
    #[test]
    fn map_service_error_maps_not_implemented_to_minus_32601() {
        let resp = map_service_error(json!(5), &ServiceError::NotImplemented);
        assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
        assert_eq!(resp.id, json!(5));
    }

    // AC-4: map_service_error maps InvalidRequest to -32602.
    #[test]
    fn map_service_error_maps_invalid_request_to_minus_32602() {
        let resp = map_service_error(
            json!(6),
            &ServiceError::InvalidRequest {
                detail: "bad".to_string(),
            },
        );
        assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
    }

    // AC-4: map_service_error maps Timeout to -32099.
    #[test]
    fn map_service_error_maps_timeout_to_minus_32099() {
        let resp = map_service_error(
            json!(7),
            &ServiceError::Timeout {
                operation: "list_sessions",
            },
        );
        assert_eq!(resp.error.code, CODE_TIMEOUT);
        // data must not contain raw content — only safe metadata like operation name.
        let data = resp.error.data.expect("data must be present");
        assert_eq!(data["operation"], json!("list_sessions"));
    }

    // AC-4: map_service_error data field is not None for all variants.
    #[test]
    fn map_service_error_data_field_is_never_none() {
        let errors: &[ServiceError] = &[
            ServiceError::NotImplemented,
            ServiceError::InvalidRequest {
                detail: "d".to_string(),
            },
            ServiceError::Timeout { operation: "op" },
            ServiceError::PolicyDenied {
                reason: "r".to_string(),
            },
            ServiceError::ServiceDown,
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
        ];
        for e in errors {
            let resp = map_service_error(json!(null), e);
            assert!(resp.error.data.is_some(), "data must be present for {e:?}");
        }
    }

    // AC-5: response id mirrors the request id for string ids.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_response_id_mirrors_request_id_for_string_id() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("service.status", json!("my-request-id"));

        match dispatcher.dispatch(req).await {
            DispatchOutcome::Ok(resp) => assert_eq!(resp.id, json!("my-request-id")),
            DispatchOutcome::Err(e) => panic!("expected Ok, got: {}", e.error.message),
        }
    }

    // AC-5: multiple sequential requests with distinct ids get matching response ids.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_multiple_requests_each_get_matching_id() {
        let dispatcher = make_dispatcher_no_handles();

        for i in 0..5u64 {
            let id = json!(i);
            let req = make_request("service.status", id.clone());
            match dispatcher.dispatch(req).await {
                DispatchOutcome::Ok(resp) => {
                    assert_eq!(resp.id, id, "response id must match request id for i={i}");
                }
                DispatchOutcome::Err(e) => panic!("request {i} failed: {}", e.error.message),
            }
        }
    }

    // sessions.kill returns NotImplemented (-32601).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_kill_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("sessions.kill", json!(8));

        match dispatcher.dispatch(req).await {
            DispatchOutcome::Err(resp) => assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND),
            DispatchOutcome::Ok(_) => panic!("expected error"),
        }
    }

    // policy.reload returns NotImplemented (-32601).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_policy_reload_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("policy.reload", json!(9));

        match dispatcher.dispatch(req).await {
            DispatchOutcome::Err(resp) => assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND),
            DispatchOutcome::Ok(_) => panic!("expected error"),
        }
    }
}
