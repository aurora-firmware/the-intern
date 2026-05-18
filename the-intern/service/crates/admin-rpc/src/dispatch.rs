//! JSON-RPC 2.0 method dispatcher for the admin RPC channel.
//!
//! The [`Dispatcher`] holds optional handles to downstream actors. When a
//! handle is `None` the corresponding method returns `NotImplemented`
//! (-32601). This keeps the call site in `bob::serve` backward-compatible
//! with `admin_rpc::Config::default()`.
//!
//! # Method set
//!
//! | Method | Behaviour |
//! |---|---|
//! | `service.status` | Returns `{ ok, version, uptime_seconds }` |
//! | `sessions.list` | Invokes `pi_agent_supervisor::Handle::list_sessions` |
//! | `sessions.kill` | Not yet implemented (NotImplemented) |
//! | `policy.reload` | Not yet implemented (NotImplemented) |
//! | `audit.tail.subscribe` | Registers a new audit subscription; returns `{ id }` |
//! | `audit.tail.unsubscribe` | Removes an audit subscription; returns `{ ok: true }` |
//! | `chat.open` | Opens a chat subscription; returns `{ id }` |
//! | `chat.close` | Closes a chat subscription; returns `{ ok: true }` |
//! | `chat.send` | Placeholder — not yet implemented |

use std::time::Instant;

use bob_core::error::ServiceError;
use serde_json::{json, Value};

use tokio::sync::mpsc;

use crate::{
    protocol::{
        ErrorResponse, Request, Response, CODE_INVALID_REQUEST, CODE_METHOD_NOT_FOUND, CODE_TIMEOUT,
    },
    subscriptions::{AuditRecord, ConnectionRegistry, SubscriptionId},
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
    /// A new audit subscription was created.
    ///
    /// The caller must forward the receiver to the write task so it can fan
    /// audit records out as JSON-RPC notifications.
    Subscribed {
        response: Response,
        id: SubscriptionId,
        rx: mpsc::Receiver<AuditRecord>,
    },
    /// An audit subscription was removed.
    Unsubscribed {
        response: Response,
        id: SubscriptionId,
    },
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
    /// `registry` is the per-connection subscription registry. Subscription
    /// methods register or unregister ids on it. For non-subscription methods
    /// the registry is not accessed.
    ///
    /// Unknown methods return a JSON-RPC -32601 error. Errors from method
    /// handlers are mapped to JSON-RPC error objects — see [`map_service_error`].
    pub async fn dispatch(
        &self,
        request: Request,
        registry: &mut ConnectionRegistry,
    ) -> DispatchOutcome {
        let id = request.id.clone();
        match request.method.as_str() {
            "service.status" => self.handle_service_status(id).await,
            "sessions.list" => self.handle_sessions_list(id).await,
            "sessions.kill" => self.handle_sessions_kill(id, &request.params).await,
            "policy.reload" => DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "policy.reload is not yet implemented",
                Some(json!({ "method": "policy.reload" })),
            )),
            "audit.tail.subscribe" => self.handle_audit_tail_subscribe(id, registry).await,
            "audit.tail.unsubscribe" => {
                self.handle_audit_tail_unsubscribe(id, &request.params, registry)
                    .await
            }
            "chat.open" => self.handle_chat_open(id, registry).await,
            "chat.close" => self.handle_chat_close(id, &request.params, registry).await,
            "chat.send" => DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "chat.send is not yet implemented",
                Some(json!({ "method": "chat.send" })),
            )),
            other => DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "Method not found",
                Some(json!({ "method": other })),
            )),
        }
    }

    // ── Subscription handlers ────────────────────────────────────────────────

    async fn handle_audit_tail_subscribe(
        &self,
        id: Value,
        registry: &mut ConnectionRegistry,
    ) -> DispatchOutcome {
        let (sub_id, rx) = registry.subscribe_audit();
        tracing::debug!(subscription_id = %sub_id, "audit.tail.subscribe: registered");
        let response = Response::ok(id, json!({ "id": sub_id.to_string() }));
        DispatchOutcome::Subscribed {
            response,
            id: sub_id,
            rx,
        }
    }

    async fn handle_audit_tail_unsubscribe(
        &self,
        id: Value,
        params: &Option<Value>,
        registry: &mut ConnectionRegistry,
    ) -> DispatchOutcome {
        let sub_id_str = params
            .as_ref()
            .and_then(|p| p.get("id"))
            .and_then(|v| v.as_str());

        let Some(sub_id_str) = sub_id_str else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "audit.tail.unsubscribe requires params.id",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        let Some(sub_id) = SubscriptionId::parse(sub_id_str) else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "params.id is not a valid subscription id",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        if registry.unsubscribe(sub_id) {
            tracing::debug!(subscription_id = %sub_id, "audit.tail.unsubscribe: removed");
            let response = Response::ok(id, json!({ "ok": true }));
            DispatchOutcome::Unsubscribed {
                response,
                id: sub_id,
            }
        } else {
            DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "subscription id not found",
                Some(json!({ "category": "invalid_request" })),
            ))
        }
    }

    async fn handle_chat_open(
        &self,
        id: Value,
        registry: &mut ConnectionRegistry,
    ) -> DispatchOutcome {
        let sub_id = registry.open_chat();
        tracing::debug!(subscription_id = %sub_id, "chat.open: registered");
        DispatchOutcome::Ok(Response::ok(id, json!({ "id": sub_id.to_string() })))
    }

    async fn handle_chat_close(
        &self,
        id: Value,
        params: &Option<Value>,
        registry: &mut ConnectionRegistry,
    ) -> DispatchOutcome {
        let sub_id_str = params
            .as_ref()
            .and_then(|p| p.get("id"))
            .and_then(|v| v.as_str());

        let Some(sub_id_str) = sub_id_str else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "chat.close requires params.id",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        let Some(sub_id) = SubscriptionId::parse(sub_id_str) else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "params.id is not a valid subscription id",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        if registry.close_chat(sub_id) {
            tracing::debug!(subscription_id = %sub_id, "chat.close: removed");
            DispatchOutcome::Ok(Response::ok(id, json!({ "ok": true })))
        } else {
            DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "subscription id not found",
                Some(json!({ "category": "invalid_request" })),
            ))
        }
    }

    // ── Core handlers ────────────────────────────────────────────────────────

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

    async fn handle_sessions_kill(&self, id: Value, params: &Option<Value>) -> DispatchOutcome {
        let Some(ref supervisor) = self.supervisor else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "sessions.kill is not available",
                Some(json!({ "method": "sessions.kill" })),
            ));
        };

        // Parse the session id from params.id.
        let session_id_str = params
            .as_ref()
            .and_then(|p| p.get("id"))
            .and_then(|v| v.as_str());

        let Some(session_id_str) = session_id_str else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "sessions.kill requires params.id",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        let session_id = match session_id_str.parse::<bob_core::types::SessionId>() {
            Ok(sid) => sid,
            Err(_) => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_INVALID_REQUEST,
                    "params.id is not a valid session id",
                    Some(json!({ "category": "invalid_request" })),
                ));
            }
        };

        match supervisor.kill_session(session_id).await {
            Ok(()) => DispatchOutcome::Ok(Response::ok(id, json!({ "ok": true }))),
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
    use std::time::Duration;

    use crate::subscriptions::SubscriptionBus;

    fn make_request(method: &str, id: Value) -> Request {
        Request {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params: None,
            id,
        }
    }

    fn make_request_with_params(method: &str, id: Value, params: Value) -> Request {
        Request {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params: Some(params),
            id,
        }
    }

    fn make_dispatcher_no_handles() -> Dispatcher {
        Dispatcher::new(None, None, "0.1.0-test")
    }

    fn make_dispatcher_with_supervisor() -> (Dispatcher, tokio::task::JoinHandle<()>) {
        let (handle, join) = pi_agent_supervisor::start(pi_agent_supervisor::Config::default())
            .expect("supervisor start must succeed in tests");
        let dispatcher = Dispatcher::new(Some(handle), None, "0.1.0-test");
        (dispatcher, join)
    }

    fn make_supervisor_handle() -> (pi_agent_supervisor::Handle, tokio::task::JoinHandle<()>) {
        pi_agent_supervisor::start(pi_agent_supervisor::Config::default())
            .expect("supervisor start must succeed in tests")
    }

    fn make_registry() -> ConnectionRegistry {
        let bus = SubscriptionBus::new(Duration::from_millis(100));
        ConnectionRegistry::new(bus)
    }

    // AC-1: service.status responds with a structured status object.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_service_status_returns_ok_with_status_object() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("service.status", json!(1));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

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
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-1: service.status response carries jsonrpc: "2.0".
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_service_status_response_is_jsonrpc_2_0() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("service.status", json!("req-id-42"));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        match outcome {
            DispatchOutcome::Ok(resp) => assert_eq!(resp.jsonrpc, "2.0"),
            DispatchOutcome::Err(e) => panic!("expected Ok, got error: {}", e.error.message),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-2: sessions.list with a supervisor handle returns the session list.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_list_returns_empty_list_when_no_sessions() {
        let (dispatcher, task) = make_dispatcher_with_supervisor();
        let req = make_request("sessions.list", json!(2));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        task.abort();
        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(2));
                assert!(resp.result.is_array(), "result must be an array");
            }
            DispatchOutcome::Err(e) => panic!("expected Ok, got error: {}", e.error.message),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-2: sessions.list without a handle returns NotImplemented (-32601).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_list_without_handle_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("sessions.list", json!(3));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
            }
            DispatchOutcome::Ok(_) => panic!("expected error, got Ok"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // Unknown method returns -32601.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_unknown_method_returns_method_not_found() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("no.such.method", json!(4));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(4));
                assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
            }
            DispatchOutcome::Ok(_) => panic!("expected error, got Ok"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-1 (subscription): audit.tail.subscribe returns a fresh subscription id.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_audit_tail_subscribe_returns_subscription_id() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("audit.tail.subscribe", json!(10));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        match outcome {
            DispatchOutcome::Subscribed {
                response,
                id,
                rx: _,
            } => {
                assert_eq!(response.jsonrpc, "2.0");
                assert_eq!(response.id, json!(10));
                assert!(
                    response.result["id"].is_string(),
                    "result.id must be a string subscription id"
                );
                let sub_id_str = response.result["id"].as_str().unwrap();
                assert_eq!(
                    id.to_string(),
                    sub_id_str,
                    "DispatchOutcome id must match result.id"
                );
            }
            DispatchOutcome::Err(e) => {
                panic!("expected Subscribed, got error: {}", e.error.message)
            }
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-1 (subscription): two subscribes register two distinct ids.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_audit_tail_subscribe_twice_yields_distinct_ids() {
        let dispatcher = make_dispatcher_no_handles();
        let mut registry = make_registry();

        let outcome1 = dispatcher
            .dispatch(
                make_request("audit.tail.subscribe", json!(11)),
                &mut registry,
            )
            .await;
        let outcome2 = dispatcher
            .dispatch(
                make_request("audit.tail.subscribe", json!(12)),
                &mut registry,
            )
            .await;

        let id1 = match outcome1 {
            DispatchOutcome::Subscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected Subscribed"),
        };
        let id2 = match outcome2 {
            DispatchOutcome::Subscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected Subscribed"),
        };
        assert_ne!(id1, id2, "each subscribe must return a distinct id");
    }

    // AC-3: audit.tail.unsubscribe with a valid id removes the subscription.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_audit_tail_unsubscribe_valid_id_returns_ok() {
        let dispatcher = make_dispatcher_no_handles();
        let mut registry = make_registry();

        // Subscribe first.
        let sub_outcome = dispatcher
            .dispatch(
                make_request("audit.tail.subscribe", json!(13)),
                &mut registry,
            )
            .await;
        let sub_id_str = match sub_outcome {
            DispatchOutcome::Subscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected Subscribed"),
        };

        // Unsubscribe.
        let unsub_req = make_request_with_params(
            "audit.tail.unsubscribe",
            json!(14),
            json!({ "id": sub_id_str }),
        );
        let unsub_outcome = dispatcher.dispatch(unsub_req, &mut registry).await;

        match unsub_outcome {
            DispatchOutcome::Unsubscribed { response, .. } => {
                assert_eq!(response.result["ok"], json!(true));
            }
            DispatchOutcome::Err(e) => {
                panic!("expected Unsubscribed, got error: {}", e.error.message)
            }
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-3: audit.tail.unsubscribe with an unknown id returns an error.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_audit_tail_unsubscribe_unknown_id_returns_error() {
        let dispatcher = make_dispatcher_no_handles();
        let mut registry = make_registry();

        let unsub_req =
            make_request_with_params("audit.tail.unsubscribe", json!(15), json!({ "id": "9999" }));
        let outcome = dispatcher.dispatch(unsub_req, &mut registry).await;

        match outcome {
            DispatchOutcome::Err(e) => assert_eq!(e.error.code, CODE_INVALID_REQUEST),
            _ => panic!("expected error for unknown subscription id"),
        }
    }

    // AC-3: audit.tail.unsubscribe without params returns an error.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_audit_tail_unsubscribe_missing_params_returns_error() {
        let dispatcher = make_dispatcher_no_handles();
        let mut registry = make_registry();

        let outcome = dispatcher
            .dispatch(
                make_request("audit.tail.unsubscribe", json!(16)),
                &mut registry,
            )
            .await;

        match outcome {
            DispatchOutcome::Err(e) => assert_eq!(e.error.code, CODE_INVALID_REQUEST),
            _ => panic!("expected error for missing params"),
        }
    }

    // chat.open returns a subscription id.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_open_returns_subscription_id() {
        let dispatcher = make_dispatcher_no_handles();
        let mut registry = make_registry();

        let outcome = dispatcher
            .dispatch(make_request("chat.open", json!(17)), &mut registry)
            .await;

        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(17));
                assert!(resp.result["id"].is_string(), "result.id must be a string");
            }
            _ => panic!("expected Ok for chat.open"),
        }
    }

    // chat.close with a valid id returns ok.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_close_valid_id_returns_ok() {
        let dispatcher = make_dispatcher_no_handles();
        let mut registry = make_registry();

        let open_outcome = dispatcher
            .dispatch(make_request("chat.open", json!(18)), &mut registry)
            .await;
        let chat_id = match open_outcome {
            DispatchOutcome::Ok(resp) => resp.result["id"].as_str().unwrap().to_string(),
            _ => panic!("expected Ok for chat.open"),
        };

        let close_req = make_request_with_params("chat.close", json!(19), json!({ "id": chat_id }));
        let close_outcome = dispatcher.dispatch(close_req, &mut registry).await;

        match close_outcome {
            DispatchOutcome::Ok(resp) => assert_eq!(resp.result["ok"], json!(true)),
            _ => panic!("expected Ok for chat.close"),
        }
    }

    // chat.send returns NotImplemented (-32601).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_send_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let mut registry = make_registry();

        let outcome = dispatcher
            .dispatch(make_request("chat.send", json!(20)), &mut registry)
            .await;

        match outcome {
            DispatchOutcome::Err(e) => assert_eq!(e.error.code, CODE_METHOD_NOT_FOUND),
            _ => panic!("expected NotImplemented for chat.send"),
        }
    }

    // map_service_error maps NotImplemented to -32601.
    #[test]
    fn map_service_error_maps_not_implemented_to_minus_32601() {
        let resp = map_service_error(json!(5), &ServiceError::NotImplemented);
        assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
        assert_eq!(resp.id, json!(5));
    }

    // map_service_error maps InvalidRequest to -32602.
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

    // map_service_error maps Timeout to -32099.
    #[test]
    fn map_service_error_maps_timeout_to_minus_32099() {
        let resp = map_service_error(
            json!(7),
            &ServiceError::Timeout {
                operation: "list_sessions",
            },
        );
        assert_eq!(resp.error.code, CODE_TIMEOUT);
        let data = resp.error.data.expect("data must be present");
        assert_eq!(data["operation"], json!("list_sessions"));
    }

    // map_service_error data field is not None for all variants.
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

    // Response id mirrors the request id for string ids.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_response_id_mirrors_request_id_for_string_id() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("service.status", json!("my-request-id"));
        let mut registry = make_registry();

        match dispatcher.dispatch(req, &mut registry).await {
            DispatchOutcome::Ok(resp) => assert_eq!(resp.id, json!("my-request-id")),
            DispatchOutcome::Err(e) => panic!("expected Ok, got: {}", e.error.message),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // Multiple sequential requests each get a response with the matching id.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_multiple_requests_each_get_matching_id() {
        let dispatcher = make_dispatcher_no_handles();
        let mut registry = make_registry();

        for i in 0..5u64 {
            let id = json!(i);
            let req = make_request("service.status", id.clone());
            match dispatcher.dispatch(req, &mut registry).await {
                DispatchOutcome::Ok(resp) => {
                    assert_eq!(resp.id, id, "response id must match request id for i={i}");
                }
                DispatchOutcome::Err(e) => panic!("request {i} failed: {}", e.error.message),
                _ => panic!("unexpected dispatch outcome variant"),
            }
        }
    }

    // AC-1 (T-036): sessions.list returns the session ids reported by the supervisor.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_list_with_active_session_returns_that_session_id() {
        let (sup_handle, sup_task) = make_supervisor_handle();
        let session_id = bob_core::types::SessionId::new();
        sup_handle
            .acquire_session(session_id)
            .await
            .expect("acquire session must succeed");

        let dispatcher = Dispatcher::new(Some(sup_handle), None, "0.1.0-test");
        let req = make_request("sessions.list", json!(30));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        sup_task.abort();
        match outcome {
            DispatchOutcome::Ok(resp) => {
                let ids: Vec<String> = resp
                    .result
                    .as_array()
                    .expect("result must be an array")
                    .iter()
                    .map(|v| v.as_str().expect("each id must be a string").to_string())
                    .collect();
                assert_eq!(ids.len(), 1, "one active session must be returned");
                assert_eq!(ids[0], session_id.to_string());
            }
            DispatchOutcome::Err(e) => panic!("expected Ok, got error: {}", e.error.message),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-2 (T-036): sessions.kill with a valid active session id returns success.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_kill_with_valid_session_id_returns_ok() {
        let (sup_handle, sup_task) = make_supervisor_handle();
        let session_id = bob_core::types::SessionId::new();
        sup_handle
            .acquire_session(session_id)
            .await
            .expect("acquire session must succeed");

        let dispatcher = Dispatcher::new(Some(sup_handle), None, "0.1.0-test");
        let req = make_request_with_params(
            "sessions.kill",
            json!(31),
            json!({ "id": session_id.to_string() }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        sup_task.abort();
        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(31));
                assert_eq!(resp.result["ok"], json!(true));
            }
            DispatchOutcome::Err(e) => panic!("expected Ok, got error: {}", e.error.message),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-3 (T-036): sessions.kill with an unknown session id returns InvalidRequest (-32602).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_kill_with_unknown_session_id_returns_invalid_request() {
        let (dispatcher, sup_task) = make_dispatcher_with_supervisor();
        let unknown_id = bob_core::types::SessionId::new();
        let req = make_request_with_params(
            "sessions.kill",
            json!(32),
            json!({ "id": unknown_id.to_string() }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        sup_task.abort();
        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(32));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Ok(_) => panic!("expected error for unknown session id"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-3 (T-036): sessions.kill without params returns InvalidRequest (-32602).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_kill_without_params_returns_invalid_request() {
        let (dispatcher, sup_task) = make_dispatcher_with_supervisor();
        let req = make_request("sessions.kill", json!(33));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        sup_task.abort();
        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(33));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Ok(_) => panic!("expected error for missing params"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-2 (T-036): sessions.kill without a supervisor handle returns NotImplemented (-32601).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_kill_without_handle_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request_with_params(
            "sessions.kill",
            json!(34),
            json!({ "id": bob_core::types::SessionId::new().to_string() }),
        );
        let mut registry = make_registry();

        match dispatcher.dispatch(req, &mut registry).await {
            DispatchOutcome::Err(resp) => assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND),
            DispatchOutcome::Ok(_) => panic!("expected error"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // (legacy) sessions.kill without params and no handle returns NotImplemented (-32601).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_sessions_kill_no_handle_no_params_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("sessions.kill", json!(8));
        let mut registry = make_registry();

        match dispatcher.dispatch(req, &mut registry).await {
            DispatchOutcome::Err(resp) => assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND),
            DispatchOutcome::Ok(_) => panic!("expected error"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // policy.reload returns NotImplemented (-32601).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_policy_reload_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("policy.reload", json!(9));
        let mut registry = make_registry();

        match dispatcher.dispatch(req, &mut registry).await {
            DispatchOutcome::Err(resp) => assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND),
            DispatchOutcome::Ok(_) => panic!("expected error"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }
}
