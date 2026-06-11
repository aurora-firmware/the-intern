//! JSON-RPC 2.0 method dispatcher for the admin RPC channel.
//!
//! The [`Dispatcher`] holds optional handles to downstream actors. When a
//! handle is `None` the corresponding method returns `NotImplemented`
//! (-32601). This keeps the call site in `bob::serve` backward-compatible
//! with `admin_rpc::Config::default()`.
//!
//! # Method set
//!
//! | Method | Auth gate | Behaviour |
//! |---|---|---|
//! | `service.status` | admin socket peer gate | Returns `{ ok, version, uptime_seconds }` |
//! | `sessions.list` | admin socket peer gate | Invokes `pi_agent_supervisor::Handle::list_sessions` |
//! | `sessions.kill` | admin socket peer gate | Not yet implemented (NotImplemented) |
//! | `policy.reload` | admin socket peer gate | Invokes `policy_control::Handle::reload`; returns success on reload or an error with rejection reason |
//! | `audit.tail.subscribe` | admin socket peer gate | Registers a new audit subscription; returns `{ id }` |
//! | `audit.tail.unsubscribe` | admin socket peer gate | Removes an audit subscription; returns `{ ok: true }` |
//! | `chat.open` | admin socket peer gate | Opens a chat subscription; returns `{ id }` |
//! | `chat.close` | admin socket peer gate | Closes a chat subscription; returns `{ ok: true }` |
//! | `chat.send` | admin socket peer gate | Validates and forwards chat user-input frames |
//! | `report.submit` | admin socket peer gate | Accepts an [`ExternalReportAuditPayload`][bob_core::types::ExternalReportAuditPayload], delegates to Monitoring, returns `{ ok: true }` |

use std::time::Instant;

use bob_core::error::ServiceError;
use bob_core::types::{
    AuditFilterKind, AuditRecord as MonitoringAuditRecord, AuditRecordKind, AuditRecordPayload,
    ExternalReportAuditPayload, UserId,
};
use chat_adapter::{ChatFrame, FrameHandle as ChatHandle};
use serde_json::{json, Value};
use std::str::FromStr;
use uuid::Uuid;

use tokio::sync::{mpsc, oneshot};

use crate::{
    chat_router::{ChatReplyReceiver, ChatReplyRouter},
    protocol::{
        ErrorResponse, Request, Response, CODE_INVALID_REQUEST, CODE_METHOD_NOT_FOUND, CODE_TIMEOUT,
    },
    subscriptions::{AdminSubscriptionId, ConnectionRegistry},
};

/// Context provided to the dispatcher at construction time.
///
/// All handles are optional so the dispatcher degrades gracefully when a
/// subsystem is not started.
#[derive(Clone)]
pub struct Dispatcher {
    supervisor: Option<pi_agent_supervisor::Handle>,
    policy: Option<policy_control::Handle>,
    monitoring: Option<monitoring::Handle>,
    chat_adapter: Option<ChatHandle>,
    /// Optional chat reply router.
    ///
    /// When present, `chat.open` registers with the router and returns a
    /// router-backed receiver.  The router is shared across all clones of the
    /// dispatcher via an `Arc`.
    chat_router: Option<std::sync::Arc<ChatReplyRouter>>,
    started_at: Instant,
    version: &'static str,
}

/// The outcome of dispatching a single JSON-RPC 2.0 request.
pub enum DispatchOutcome {
    /// A JSON-RPC 2.0 success response.
    Ok(Response),
    /// A JSON-RPC 2.0 error response.
    Err(ErrorResponse),
    /// A new Monitoring-backed audit subscription was created.
    ///
    /// The caller must spawn a forwarder task that drives `rx` (the monitoring
    /// tail receiver) and `cancel_rx` (signals when the subscription is
    /// cancelled by `audit.tail.unsubscribe` or connection close).
    Subscribed {
        response: Response,
        id: AdminSubscriptionId,
        rx: mpsc::UnboundedReceiver<MonitoringAuditRecord>,
        cancel_rx: oneshot::Receiver<()>,
    },
    /// An audit subscription was removed.
    Unsubscribed {
        response: Response,
        id: AdminSubscriptionId,
    },
    /// A new router-backed chat subscription was created.
    ///
    /// The caller must spawn a forwarder task that drives `rx` (the per-subscription
    /// reply queue receiver) and `cancel_rx` (signals when the subscription is
    /// cancelled by `chat.close` or connection close).
    ChatSubscribed {
        response: Response,
        id: AdminSubscriptionId,
        rx: ChatReplyReceiver,
        cancel_rx: tokio::sync::oneshot::Receiver<()>,
    },
    /// A chat subscription was removed.
    ChatUnsubscribed {
        response: Response,
        id: AdminSubscriptionId,
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
        monitoring: Option<monitoring::Handle>,
        version: &'static str,
    ) -> Self {
        Self {
            supervisor,
            policy,
            monitoring,
            chat_adapter: None,
            chat_router: None,
            started_at: Instant::now(),
            version,
        }
    }

    /// Attach an optional chat-adapter frame-delivery handle.
    ///
    /// When present, `chat.send` forwards frames to the chat adapter.
    /// When absent (the default), `chat.send` returns a JSON-RPC error.
    #[must_use]
    pub fn with_chat_handle(mut self, handle: ChatHandle) -> Self {
        self.chat_adapter = Some(handle);
        self
    }

    /// Attach a chat reply router.
    ///
    /// When present, `chat.open` registers with the router and returns a
    /// [`DispatchOutcome::ChatSubscribed`] carrying the router-backed receiver.
    /// `chat.close` and connection drop deregister the subscription from the
    /// router.
    ///
    /// The router is wrapped in an `Arc` so all clones of the dispatcher share
    /// the same router state.
    #[must_use]
    pub fn with_chat_router(mut self, router: std::sync::Arc<ChatReplyRouter>) -> Self {
        self.chat_router = Some(router);
        self
    }

    /// Return a clone of the chat reply router `Arc`, if one is configured.
    ///
    /// Used by the connection loop to attach the router to the per-connection
    /// registry for teardown on connection drop.
    pub fn chat_router(&self) -> Option<std::sync::Arc<ChatReplyRouter>> {
        self.chat_router.clone()
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
            "policy.reload" => self.handle_policy_reload(id).await,
            "audit.tail.subscribe" => {
                self.handle_audit_tail_subscribe(id, &request.params, registry)
                    .await
            }
            "audit.tail.unsubscribe" => {
                self.handle_audit_tail_unsubscribe(id, &request.params, registry)
                    .await
            }
            "chat.open" => self.handle_chat_open(id, registry).await,
            "chat.close" => self.handle_chat_close(id, &request.params, registry).await,
            "chat.send" => self.handle_chat_send(id, &request.params, registry).await,
            "report.submit" => self.handle_report_submit(id, &request.params).await,
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
        params: &Option<Value>,
        registry: &mut ConnectionRegistry,
    ) -> DispatchOutcome {
        // Require a monitoring handle — audit tails are backed by monitoring.
        let Some(ref monitoring) = self.monitoring else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "audit.tail.subscribe is not available: no monitoring handle",
                Some(json!({ "method": "audit.tail.subscribe" })),
            ));
        };

        // Parse optional filters from params.filters (an array of strings).
        let filters = match parse_audit_filters(params) {
            Ok(f) => f,
            Err(unknown) => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_INVALID_REQUEST,
                    format!(
                        "audit.tail.subscribe: unknown filter \"{unknown}\"; \
                         expected one of: events, reports, verdicts"
                    ),
                    Some(json!({ "category": "invalid_request", "unknown_filter": unknown })),
                ));
            }
        };

        // Subscribe to the monitoring tail — this is a future-only tail,
        // no historical replay.
        let monitoring_rx = match monitoring.subscribe_tail(filters).await {
            Ok(rx) => rx,
            Err(e) => return DispatchOutcome::Err(map_service_error(id, &e)),
        };

        // Register in the per-connection registry and obtain a cancellation
        // receiver for the forwarder task.
        let (sub_id, cancel_rx) = registry.register_audit_subscription();

        tracing::debug!(subscription_id = %sub_id, "audit.tail.subscribe: registered");
        let response = Response::ok(id, json!({ "id": sub_id.to_string() }));
        DispatchOutcome::Subscribed {
            response,
            id: sub_id,
            rx: monitoring_rx,
            cancel_rx,
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

        let Some(sub_id) = AdminSubscriptionId::parse(sub_id_str) else {
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
        let (sub_id, cancel_rx) = registry.open_chat();
        tracing::debug!(subscription_id = %sub_id, "chat.open: registered");
        let response = Response::ok(id, json!({ "id": sub_id.to_string() }));

        if let Some(ref router) = self.chat_router {
            // Register the subscription id with the chat reply router and obtain
            // the per-subscription reply queue receiver.
            let rx = router.register(sub_id);
            DispatchOutcome::ChatSubscribed {
                response,
                id: sub_id,
                rx,
                cancel_rx,
            }
        } else {
            // No router configured — fall back to a plain Ok response.
            // The cancel_rx is dropped here, which is fine; no forwarder will be
            // spawned so the subscription drains nothing.
            let _ = cancel_rx;
            DispatchOutcome::Ok(response)
        }
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

        let Some(sub_id) = AdminSubscriptionId::parse(sub_id_str) else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "params.id is not a valid subscription id",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        if registry.close_chat(sub_id) {
            tracing::debug!(subscription_id = %sub_id, "chat.close: removed");
            // Deregister from the reply router so subsequent injected replies are
            // dropped.  This must happen before the cancel sender is dropped
            // (done inside registry.close_chat) so the forwarder cannot race a
            // delivery after the channel closes.
            if let Some(ref router) = self.chat_router {
                router.deregister(sub_id);
            }
            let response = Response::ok(id, json!({ "ok": true }));
            DispatchOutcome::ChatUnsubscribed {
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

    /// Handle `chat.send`.
    ///
    /// Validates:
    /// - A chat-adapter handle is present (AC-3: returns error when absent).
    /// - `params.id` identifies an open chat subscription on this connection
    ///   (AC-4: returns error when absent or the wrong kind).
    /// - `params.text` is present (AC-2: the message text).
    /// - `params.application_identity` is present and parses as a `UserId`.
    ///
    /// Builds a [`ChatFrame`] with the message text, application identity, and
    /// optional `params.context_id`, then delivers it to the chat adapter.
    async fn handle_chat_send(
        &self,
        id: Value,
        params: &Option<Value>,
        registry: &ConnectionRegistry,
    ) -> DispatchOutcome {
        // AC-3: return an error when no chat-adapter handle is configured.
        let Some(ref adapter) = self.chat_adapter else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "chat.send is not available: chat channel is not configured",
                Some(json!({ "method": "chat.send" })),
            ));
        };

        // Require params.
        let Some(ref params_value) = params else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "chat.send requires params",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        // Parse and validate params.id (the chat subscription id).
        let sub_id_str = params_value.get("id").and_then(|v| v.as_str());
        let Some(sub_id_str) = sub_id_str else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "chat.send requires params.id",
                Some(json!({ "category": "invalid_request" })),
            ));
        };
        let Some(sub_id) = AdminSubscriptionId::parse(sub_id_str) else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "params.id is not a valid subscription id",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        // AC-4: the subscription id must be an open chat subscription on this connection.
        if !registry.is_open_chat_subscription(sub_id) {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "params.id does not reference an open chat subscription on this connection",
                Some(json!({ "category": "invalid_request" })),
            ));
        }

        // Parse params.text (the message body).
        let text = params_value.get("text").and_then(|v| v.as_str());
        let Some(text) = text else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "chat.send requires params.text",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        let application_identity = params_value
            .get("application_identity")
            .and_then(|v| v.as_str());
        let Some(application_identity) = application_identity else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "chat.send requires params.application_identity",
                Some(json!({ "category": "invalid_request" })),
            ));
        };
        if application_identity.trim().is_empty() {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "params.application_identity must not be empty",
                Some(json!({ "category": "invalid_request" })),
            ));
        }
        let application_identity = match application_identity.parse::<UserId>() {
            Ok(user_id) => user_id,
            Err(_) => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_INVALID_REQUEST,
                    "params.application_identity is not a valid user id",
                    Some(json!({ "category": "invalid_request" })),
                ));
            }
        };

        // Parse optional params.context_id.
        let context_id = params_value
            .get("context_id")
            .and_then(|v| v.as_str())
            .map(str::to_owned);

        let frame = ChatFrame {
            message: text.to_owned(),
            peer_id: application_identity,
            context_id,
            subscription_id: sub_id.to_string(),
        };

        match adapter.deliver(frame).await {
            Ok(()) => {
                tracing::debug!(subscription_id = %sub_id, "chat.send: frame forwarded to adapter");
                DispatchOutcome::Ok(Response::ok(id, json!({ "ok": true })))
            }
            Err(_) => DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "chat.send failed: chat adapter is unavailable",
                Some(json!({ "category": "service_down" })),
            )),
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

    /// Handle `report.submit`.
    ///
    /// Accepts only the [`ExternalReportAuditPayload`] shape (deny_unknown_fields).
    /// Builds an [`AuditRecord`] of kind `report`, delegates it to the Monitoring
    /// handle, and returns `{ ok: true }` on success.
    ///
    /// Returns `CODE_METHOD_NOT_FOUND` (-32601) when no Monitoring handle is
    /// configured and `CODE_INVALID_REQUEST` (-32602) when params are absent,
    /// malformed, or contain unknown fields.
    async fn handle_report_submit(&self, id: Value, params: &Option<Value>) -> DispatchOutcome {
        let Some(ref monitoring) = self.monitoring else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "report.submit is not available",
                Some(json!({ "method": "report.submit" })),
            ));
        };

        let Some(ref params_value) = params else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "report.submit requires params",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        // Deserialize with deny_unknown_fields so unexpected keys are rejected.
        let payload: ExternalReportAuditPayload = match serde_json::from_value(params_value.clone())
        {
            Ok(p) => p,
            Err(e) => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_INVALID_REQUEST,
                    "report.submit params are invalid",
                    Some(json!({
                        "category": "invalid_request",
                        "reason": e.to_string(),
                    })),
                ));
            }
        };

        // Build the audit envelope; id and timestamp are assigned here by the
        // facade, not by the caller.
        let record = MonitoringAuditRecord {
            id: Uuid::new_v4().to_string(),
            timestamp: chrono_timestamp(),
            kind: AuditRecordKind::Report,
            session_id: payload.session_id,
            payload: AuditRecordPayload::Report(ExternalReportAuditPayload {
                action: payload.action,
                outcome: payload.outcome,
                session_id: None,
                summary: payload.summary,
            }),
        };

        match monitoring.append_record(record).await {
            Ok(()) => DispatchOutcome::Ok(Response::ok(id, json!({ "ok": true }))),
            Err(e) => DispatchOutcome::Err(map_service_error(id, &e)),
        }
    }

    async fn handle_policy_reload(&self, id: Value) -> DispatchOutcome {
        let Some(ref policy) = self.policy else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "policy.reload is not yet implemented",
                Some(json!({ "method": "policy.reload" })),
            ));
        };

        match policy.reload().await {
            Ok(()) => {
                DispatchOutcome::Ok(Response::ok(id, json!({ "ok": true, "reloaded": true })))
            }
            Err(error) => DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "Policy reload rejected",
                Some(json!({
                    "category": "invalid_request",
                    "reason": error.to_string(),
                })),
            )),
        }
    }
}

/// Parse an optional `filters` array from JSON-RPC params.
///
/// Returns `Ok(Vec<AuditFilterKind>)` — empty when no `filters` key is present
/// (which means subscribe to all default-visible kinds).
///
/// Returns `Err(unknown_value)` when any element in the array is not a
/// recognised filter kind.
fn parse_audit_filters(params: &Option<Value>) -> Result<Vec<AuditFilterKind>, String> {
    let Some(params) = params else {
        return Ok(Vec::new());
    };

    let Some(filters_value) = params.get("filters") else {
        return Ok(Vec::new());
    };

    let Some(arr) = filters_value.as_array() else {
        return Err(filters_value.to_string());
    };

    let mut filters = Vec::with_capacity(arr.len());
    for item in arr {
        let Some(s) = item.as_str() else {
            return Err(item.to_string());
        };
        match AuditFilterKind::from_str(s) {
            Ok(f) => filters.push(f),
            Err(_) => return Err(s.to_owned()),
        }
    }

    Ok(filters)
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

/// Returns the current UTC time as an RFC 3339 string.
fn chrono_timestamp() -> String {
    chrono::Utc::now().to_rfc3339()
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

    fn make_request_with_params(method: &str, id: Value, params: Value) -> Request {
        Request {
            jsonrpc: "2.0".to_string(),
            method: method.to_string(),
            params: Some(params),
            id,
        }
    }

    fn make_dispatcher_no_handles() -> Dispatcher {
        Dispatcher::new(None, None, None, "0.1.0-test")
    }

    fn make_dispatcher_with_supervisor() -> (Dispatcher, tokio::task::JoinHandle<()>) {
        let (handle, join) = pi_agent_supervisor::start(pi_agent_supervisor::Config::default())
            .expect("supervisor start must succeed in tests");
        let dispatcher = Dispatcher::new(Some(handle), None, None, "0.1.0-test");
        (dispatcher, join)
    }

    fn make_supervisor_handle() -> (pi_agent_supervisor::Handle, tokio::task::JoinHandle<()>) {
        pi_agent_supervisor::start(pi_agent_supervisor::Config::default())
            .expect("supervisor start must succeed in tests")
    }

    fn make_registry() -> ConnectionRegistry {
        ConnectionRegistry::new()
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

    // AC-1 (T-063): audit.tail.subscribe with no filters and a monitoring handle
    // returns a Subscribed outcome backed by monitoring.
    #[tokio::test(flavor = "current_thread")]
    async fn audit_tail_subscribe_with_no_filters_returns_monitoring_backed_subscription() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        let req = make_request("audit.tail.subscribe", json!(10));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        task.abort();
        match outcome {
            DispatchOutcome::Subscribed { response, id, .. } => {
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

    // AC-2 (T-063): audit.tail.subscribe with valid filters subscribes only those kinds.
    #[tokio::test(flavor = "current_thread")]
    async fn audit_tail_subscribe_with_valid_filters_returns_monitoring_backed_subscription() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        let req = make_request_with_params(
            "audit.tail.subscribe",
            json!(11),
            json!({ "filters": ["events"] }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        task.abort();
        match outcome {
            DispatchOutcome::Subscribed { response, .. } => {
                assert_eq!(response.id, json!(11));
                assert!(response.result["id"].is_string());
            }
            DispatchOutcome::Err(e) => {
                panic!("expected Subscribed, got error: {}", e.error.message)
            }
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-3 (T-063): audit.tail.subscribe with an unknown filter returns invalid-request error.
    #[tokio::test(flavor = "current_thread")]
    async fn audit_tail_subscribe_with_unknown_filter_returns_invalid_request() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        let req = make_request_with_params(
            "audit.tail.subscribe",
            json!(12),
            json!({ "filters": ["unknown_kind"] }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        task.abort();
        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(12));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Subscribed { .. } => {
                panic!("expected error for unknown filter, got Subscribed")
            }
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-3 (T-063): audit.tail.subscribe with an unknown filter creates no subscription.
    #[tokio::test(flavor = "current_thread")]
    async fn audit_tail_subscribe_with_unknown_filter_creates_no_subscription() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        let req = make_request_with_params(
            "audit.tail.subscribe",
            json!(13),
            json!({ "filters": ["invalid"] }),
        );
        let mut registry = make_registry();

        let _ = dispatcher.dispatch(req, &mut registry).await;

        task.abort();
        assert_eq!(
            registry.len(),
            0,
            "no subscription should be registered when filter is unknown"
        );
    }

    // AC-1 (T-063): audit.tail.subscribe without a monitoring handle returns NotImplemented.
    #[tokio::test(flavor = "current_thread")]
    async fn audit_tail_subscribe_without_monitoring_handle_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("audit.tail.subscribe", json!(14));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(14));
                assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
            }
            DispatchOutcome::Subscribed { .. } => {
                panic!("expected error without monitoring, got Subscribed")
            }
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // Two subscribes on the same connection yield distinct subscription ids.
    #[tokio::test(flavor = "current_thread")]
    async fn audit_tail_subscribe_twice_yields_distinct_ids() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        let mut registry = make_registry();

        let outcome1 = dispatcher
            .dispatch(
                make_request("audit.tail.subscribe", json!(20)),
                &mut registry,
            )
            .await;
        let outcome2 = dispatcher
            .dispatch(
                make_request("audit.tail.subscribe", json!(21)),
                &mut registry,
            )
            .await;

        task.abort();
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

    // AC-5 (T-063): audit.tail.unsubscribe with a valid id removes the subscription.
    #[tokio::test(flavor = "current_thread")]
    async fn audit_tail_unsubscribe_valid_id_returns_ok() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        let mut registry = make_registry();

        let sub_outcome = dispatcher
            .dispatch(
                make_request("audit.tail.subscribe", json!(30)),
                &mut registry,
            )
            .await;
        let sub_id_str = match sub_outcome {
            DispatchOutcome::Subscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected Subscribed"),
        };

        let unsub_req = make_request_with_params(
            "audit.tail.unsubscribe",
            json!(31),
            json!({ "id": sub_id_str }),
        );
        let unsub_outcome = dispatcher.dispatch(unsub_req, &mut registry).await;

        task.abort();
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

    // Legacy: audit.tail.subscribe returns a fresh subscription id.
    // Kept to document that a monitoring handle is now required.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_audit_tail_subscribe_returns_subscription_id() {
        // With monitoring handle — previously this worked without any handle.
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        let req = make_request("audit.tail.subscribe", json!(10));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        task.abort();
        match outcome {
            DispatchOutcome::Subscribed { response, id, .. } => {
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

    // Legacy: two subscribes register two distinct ids.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_audit_tail_subscribe_twice_yields_distinct_ids() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
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

        task.abort();
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

    // AC-3 (legacy): audit.tail.unsubscribe with a valid id removes the subscription.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_audit_tail_unsubscribe_valid_id_returns_ok() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
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

        task.abort();
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

    // AC-1 (T-086): chat.open returns ChatSubscribed with a router-backed receiver.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_open_returns_chat_subscribed_with_receiver() {
        let (dispatcher, _router) = make_dispatcher_with_chat_router();
        let mut registry = make_registry();

        let outcome = dispatcher
            .dispatch(make_request("chat.open", json!(17)), &mut registry)
            .await;

        match outcome {
            DispatchOutcome::ChatSubscribed { response, id, .. } => {
                assert_eq!(response.id, json!(17));
                assert!(
                    response.result["id"].is_string(),
                    "result.id must be a string"
                );
                let sub_id_str = response.result["id"].as_str().unwrap();
                assert_eq!(
                    id.to_string(),
                    sub_id_str,
                    "DispatchOutcome id must match result.id"
                );
            }
            _ => panic!("expected ChatSubscribed for chat.open"),
        }
    }

    // AC-2 (T-086): chat.close with a valid id deregisters from the router and
    // returns ChatUnsubscribed.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_close_valid_id_returns_chat_unsubscribed() {
        let (dispatcher, _router) = make_dispatcher_with_chat_router();
        let mut registry = make_registry();

        let open_outcome = dispatcher
            .dispatch(make_request("chat.open", json!(18)), &mut registry)
            .await;
        let chat_id = match open_outcome {
            DispatchOutcome::ChatSubscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected ChatSubscribed for chat.open"),
        };

        let close_req = make_request_with_params("chat.close", json!(19), json!({ "id": chat_id }));
        let close_outcome = dispatcher.dispatch(close_req, &mut registry).await;

        match close_outcome {
            DispatchOutcome::ChatUnsubscribed { response, .. } => {
                assert_eq!(response.result["ok"], json!(true))
            }
            _ => panic!("expected ChatUnsubscribed for chat.close"),
        }
    }

    fn make_dispatcher_with_chat_router() -> (
        Dispatcher,
        std::sync::Arc<crate::chat_router::ChatReplyRouter>,
    ) {
        let router = std::sync::Arc::new(crate::chat_router::ChatReplyRouter::new());
        let dispatcher = Dispatcher::new(None, None, None, "0.1.0-test")
            .with_chat_router(std::sync::Arc::clone(&router));
        (dispatcher, router)
    }

    fn make_monitoring_handle() -> (monitoring::Handle, tokio::task::JoinHandle<()>) {
        let tmp = tempfile::NamedTempFile::new().expect("temp file");
        monitoring::start(monitoring::Config {
            command_buffer: 4,
            audit_log_path: tmp.path().to_path_buf(),
        })
    }

    fn make_dispatcher_with_monitoring() -> (Dispatcher, tokio::task::JoinHandle<()>) {
        let (handle, join) = make_monitoring_handle();
        let dispatcher = Dispatcher::new(None, None, Some(handle), "0.1.0-test");
        (dispatcher, join)
    }

    // AC-1 (T-062): report.submit with a valid report and a Monitoring handle returns success.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_report_submit_with_monitoring_handle_returns_ok() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        let req = make_request_with_params(
            "report.submit",
            json!(51),
            json!({
                "action": "tool.fs.read",
                "outcome": "success",
                "session_id": null,
                "summary": "read complete"
            }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        task.abort();
        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(51));
                assert_eq!(resp.result["ok"], json!(true));
            }
            DispatchOutcome::Err(e) => panic!("expected Ok, got error: {}", e.error.message),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-2 (T-062): report.submit with an unknown field returns invalid-request error.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_report_submit_with_unknown_field_returns_invalid_request() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        let req = make_request_with_params(
            "report.submit",
            json!(52),
            json!({
                "action": "tool.fs.read",
                "outcome": "success",
                "session_id": null,
                "summary": "ok",
                "metadata": { "unreviewed": true }
            }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        task.abort();
        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(52));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Ok(_) => panic!("expected error for unknown field, got Ok"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-2 (T-062): report.submit with missing required fields returns invalid-request error.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_report_submit_with_missing_required_field_returns_invalid_request() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        // Missing "outcome" field.
        let req = make_request_with_params(
            "report.submit",
            json!(53),
            json!({
                "action": "tool.fs.read"
            }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        task.abort();
        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(53));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Ok(_) => panic!("expected error for missing field, got Ok"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-2 (T-062): report.submit with no params returns invalid-request error.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_report_submit_with_no_params_returns_invalid_request() {
        let (dispatcher, task) = make_dispatcher_with_monitoring();
        let req = make_request("report.submit", json!(54));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        task.abort();
        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(54));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Ok(_) => panic!("expected error for missing params, got Ok"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-3 (T-062): report.submit without a Monitoring handle returns NotImplemented (-32601).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_report_submit_without_monitoring_handle_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request_with_params(
            "report.submit",
            json!(50),
            json!({
                "action": "tool.fs.read",
                "outcome": "success",
                "session_id": null,
                "summary": "read complete"
            }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(50));
                assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
            }
            DispatchOutcome::Ok(_) => panic!("expected error, got Ok"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-3 (T-071): chat.send without a chat-adapter handle returns an error
    // explaining chat is not available.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_send_without_handle_returns_method_not_found() {
        let dispatcher = make_dispatcher_no_handles();
        let mut registry = make_registry();

        let outcome = dispatcher
            .dispatch(make_request("chat.send", json!(20)), &mut registry)
            .await;

        match outcome {
            DispatchOutcome::Err(e) => assert_eq!(e.error.code, CODE_METHOD_NOT_FOUND),
            _ => panic!("expected error for chat.send without handle"),
        }
    }

    // AC-2 (T-071): chat.send with an open chat subscription and a chat-adapter
    // handle forwards a frame and returns success.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_send_with_open_subscription_and_handle_returns_ok() {
        use bob_core::types::{ChannelId, InternalEvent, RequestContext, UserId};
        use requests_handler::Config as QueueConfig;
        use std::sync::{Arc, Mutex};
        use std::time::Duration;
        use tokio::sync::watch;

        let received: Arc<Mutex<Vec<(InternalEvent, RequestContext)>>> =
            Arc::new(Mutex::new(vec![]));
        let received_clone = received.clone();

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 64,
            request_submit_timeout: Duration::from_secs(5),
        };
        let (intake, intake_task) = requests_handler::start_with(
            cfg,
            move |(ev, ctx)| {
                let r = received_clone.clone();
                async move {
                    r.lock().unwrap().push((ev, ctx));
                }
            },
            cancel_rx,
        );

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = chat_adapter::start(intake, channel_id, 16);
        let router = std::sync::Arc::new(crate::chat_router::ChatReplyRouter::new());
        let dispatcher = Dispatcher::new(None, None, None, "0.1.0-test")
            .with_chat_handle(frame_handle)
            .with_chat_router(std::sync::Arc::clone(&router));
        let expected_sender = UserId::new();
        let mut registry = make_registry();

        // Open a chat subscription.
        let open_outcome = dispatcher
            .dispatch(make_request("chat.open", json!(70)), &mut registry)
            .await;
        let sub_id = match open_outcome {
            DispatchOutcome::ChatSubscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected ChatSubscribed for chat.open"),
        };

        // Send a message.
        let send_outcome = dispatcher
            .dispatch(
                make_request_with_params(
                    "chat.send",
                    json!(71),
                    json!({
                        "id": sub_id,
                        "text": "hello chat",
                        "application_identity": expected_sender.to_string()
                    }),
                ),
                &mut registry,
            )
            .await;

        // Give the actor time to process the frame.
        tokio::task::yield_now().await;

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        match send_outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(71));
                assert_eq!(resp.result["ok"], json!(true));
            }
            DispatchOutcome::Err(e) => {
                panic!("expected Ok for chat.send, got: {}", e.error.message)
            }
            _ => panic!("unexpected dispatch outcome variant"),
        }

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 1, "exactly one event must be forwarded");
        assert_eq!(got[0].0.payload, "hello chat");
        assert_eq!(got[0].1.sender, expected_sender);
    }

    // AC-1 (T-087): chat.send attaches the validated subscription id to the chat
    // frame, which the adapter preserves as reply_address on RequestContext.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_send_attaches_subscription_id_as_reply_address_on_request_context() {
        use bob_core::types::{ChannelId, InternalEvent, RequestContext, UserId};
        use requests_handler::Config as QueueConfig;
        use std::sync::{Arc, Mutex};
        use std::time::Duration;
        use tokio::sync::watch;

        let received: Arc<Mutex<Vec<(InternalEvent, RequestContext)>>> =
            Arc::new(Mutex::new(vec![]));
        let received_clone = received.clone();

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 64,
            request_submit_timeout: Duration::from_secs(5),
        };
        let (intake, intake_task) = requests_handler::start_with(
            cfg,
            move |(ev, ctx)| {
                let r = received_clone.clone();
                async move {
                    r.lock().unwrap().push((ev, ctx));
                }
            },
            cancel_rx,
        );

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = chat_adapter::start(intake, channel_id, 16);
        let router = std::sync::Arc::new(crate::chat_router::ChatReplyRouter::new());
        let dispatcher = Dispatcher::new(None, None, None, "0.1.0-test")
            .with_chat_handle(frame_handle)
            .with_chat_router(std::sync::Arc::clone(&router));
        let expected_sender = UserId::new();
        let mut registry = make_registry();

        // Open a chat subscription and capture the subscription id.
        let open_outcome = dispatcher
            .dispatch(make_request("chat.open", json!(100)), &mut registry)
            .await;
        let sub_id = match open_outcome {
            DispatchOutcome::ChatSubscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected ChatSubscribed for chat.open"),
        };

        // Send a message.
        dispatcher
            .dispatch(
                make_request_with_params(
                    "chat.send",
                    json!(101),
                    json!({
                        "id": sub_id,
                        "text": "hello subscription id",
                        "application_identity": expected_sender.to_string()
                    }),
                ),
                &mut registry,
            )
            .await;

        tokio::task::yield_now().await;

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 1, "exactly one event must be forwarded");
        let (_, ctx) = &got[0];
        assert_eq!(
            ctx.reply_address,
            Some(sub_id),
            "reply_address must equal the subscription id from params.id"
        );
    }

    // AC-2 (T-071): chat.send forwards the optional context_id from params.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_send_forwards_context_id_to_chat_adapter() {
        use bob_core::types::{ChannelId, InternalEvent, RequestContext, UserId};
        use requests_handler::Config as QueueConfig;
        use std::sync::{Arc, Mutex};
        use std::time::Duration;
        use tokio::sync::watch;

        let received: Arc<Mutex<Vec<(InternalEvent, RequestContext)>>> =
            Arc::new(Mutex::new(vec![]));
        let received_clone = received.clone();

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 64,
            request_submit_timeout: Duration::from_secs(5),
        };
        let (intake, intake_task) = requests_handler::start_with(
            cfg,
            move |(ev, ctx)| {
                let r = received_clone.clone();
                async move {
                    r.lock().unwrap().push((ev, ctx));
                }
            },
            cancel_rx,
        );

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = chat_adapter::start(intake, channel_id, 16);
        let router = std::sync::Arc::new(crate::chat_router::ChatReplyRouter::new());
        let dispatcher = Dispatcher::new(None, None, None, "0.1.0-test")
            .with_chat_handle(frame_handle)
            .with_chat_router(std::sync::Arc::clone(&router));
        let expected_sender = UserId::new();
        let mut registry = make_registry();

        let open_outcome = dispatcher
            .dispatch(make_request("chat.open", json!(72)), &mut registry)
            .await;
        let sub_id = match open_outcome {
            DispatchOutcome::ChatSubscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected ChatSubscribed for chat.open"),
        };

        dispatcher
            .dispatch(
                make_request_with_params(
                    "chat.send",
                    json!(73),
                    json!({
                        "id": sub_id,
                        "text": "ctx msg",
                        "context_id": "conv-42",
                        "application_identity": expected_sender.to_string()
                    }),
                ),
                &mut registry,
            )
            .await;

        tokio::task::yield_now().await;

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 1);
        assert_eq!(
            got[0].1.context_id,
            Some("conv-42".to_owned()),
            "context_id must be forwarded from params"
        );
        assert_eq!(
            got[0].1.sender, expected_sender,
            "sender must come from params.application_identity"
        );
    }

    // AC-4 (T-071): chat.send with an unknown subscription id returns an error
    // and forwards nothing.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_send_with_unknown_subscription_id_returns_error_and_forwards_nothing() {
        use bob_core::types::{ChannelId, InternalEvent, RequestContext, UserId};
        use requests_handler::Config as QueueConfig;
        use std::sync::{Arc, Mutex};
        use std::time::Duration;
        use tokio::sync::watch;

        let received: Arc<Mutex<Vec<(InternalEvent, RequestContext)>>> =
            Arc::new(Mutex::new(vec![]));
        let received_clone = received.clone();

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 64,
            request_submit_timeout: Duration::from_secs(5),
        };
        let (intake, intake_task) = requests_handler::start_with(
            cfg,
            move |(ev, ctx)| {
                let r = received_clone.clone();
                async move {
                    r.lock().unwrap().push((ev, ctx));
                }
            },
            cancel_rx,
        );

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = chat_adapter::start(intake, channel_id, 16);
        let dispatcher = make_dispatcher_with_chat_handle(frame_handle);
        let mut registry = make_registry();

        // Use a subscription id that was never opened on this connection.
        let outcome = dispatcher
            .dispatch(
                make_request_with_params(
                    "chat.send",
                    json!(74),
                    json!({
                        "id": "9999",
                        "text": "should not arrive",
                        "application_identity": UserId::new().to_string()
                    }),
                ),
                &mut registry,
            )
            .await;

        tokio::task::yield_now().await;

        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        match outcome {
            DispatchOutcome::Err(e) => {
                assert_eq!(e.id, json!(74));
                assert_eq!(e.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Ok(_) => panic!("expected error for unknown subscription id"),
            _ => panic!("unexpected dispatch outcome variant"),
        }

        let got = received.lock().unwrap();
        assert_eq!(
            got.len(),
            0,
            "no frame must be forwarded when subscription id is unknown"
        );
    }

    // AC-4 (T-071): chat.send with an audit subscription id (not a chat id)
    // returns an error.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_send_with_audit_subscription_id_returns_error() {
        use bob_core::types::ChannelId;
        use requests_handler::Config as QueueConfig;
        use std::time::Duration;
        use tokio::sync::watch;

        let (_, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 8,
            request_submit_timeout: Duration::from_secs(1),
        };
        let (intake, _intake_task) =
            requests_handler::start_with(cfg, move |(_, _): (_, _)| async {}, cancel_rx);
        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = chat_adapter::start(intake, channel_id, 8);

        // Build a dispatcher with both monitoring (for audit.tail.subscribe) and
        // a chat handle.
        let tmp = tempfile::NamedTempFile::new().expect("temp file");
        let (mon_handle, _mon_task) = monitoring::start(monitoring::Config {
            command_buffer: 4,
            audit_log_path: tmp.path().to_path_buf(),
        });
        let dispatcher = Dispatcher::new(None, None, Some(mon_handle), "0.1.0-test")
            .with_chat_handle(frame_handle);

        let mut registry = make_registry();

        // Open an audit subscription — this is NOT a chat subscription.
        let sub_outcome = dispatcher
            .dispatch(
                make_request("audit.tail.subscribe", json!(80)),
                &mut registry,
            )
            .await;
        let audit_sub_id = match sub_outcome {
            DispatchOutcome::Subscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected Subscribed"),
        };

        // Attempt to chat.send with the audit subscription id.
        let outcome = dispatcher
            .dispatch(
                make_request_with_params(
                    "chat.send",
                    json!(81),
                    json!({
                        "id": audit_sub_id,
                        "text": "wrong kind",
                        "application_identity": bob_core::types::UserId::new().to_string()
                    }),
                ),
                &mut registry,
            )
            .await;

        match outcome {
            DispatchOutcome::Err(e) => {
                assert_eq!(e.id, json!(81));
                assert_eq!(e.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Ok(_) => panic!("expected error for audit sub id used in chat.send"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_send_without_application_identity_returns_error_and_forwards_nothing() {
        use bob_core::types::{ChannelId, InternalEvent, RequestContext};
        use requests_handler::Config as QueueConfig;
        use std::sync::{Arc, Mutex};
        use std::time::Duration;
        use tokio::sync::watch;

        let received: Arc<Mutex<Vec<(InternalEvent, RequestContext)>>> =
            Arc::new(Mutex::new(vec![]));
        let received_clone = received.clone();

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 64,
            request_submit_timeout: Duration::from_secs(5),
        };
        let (intake, intake_task) = requests_handler::start_with(
            cfg,
            move |(ev, ctx)| {
                let r = received_clone.clone();
                async move {
                    r.lock().unwrap().push((ev, ctx));
                }
            },
            cancel_rx,
        );

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = chat_adapter::start(intake, channel_id, 16);
        let router = std::sync::Arc::new(crate::chat_router::ChatReplyRouter::new());
        let dispatcher = Dispatcher::new(None, None, None, "0.1.0-test")
            .with_chat_handle(frame_handle)
            .with_chat_router(std::sync::Arc::clone(&router));
        let mut registry = make_registry();

        let open_outcome = dispatcher
            .dispatch(make_request("chat.open", json!(90)), &mut registry)
            .await;
        let sub_id = match open_outcome {
            DispatchOutcome::ChatSubscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected ChatSubscribed for chat.open"),
        };

        let outcome = dispatcher
            .dispatch(
                make_request_with_params(
                    "chat.send",
                    json!(91),
                    json!({ "id": sub_id, "text": "missing identity" }),
                ),
                &mut registry,
            )
            .await;

        tokio::task::yield_now().await;
        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(91));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
            }
            _ => panic!("expected error for missing application_identity"),
        }

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 0, "no frame should be forwarded");
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_chat_send_with_malformed_application_identity_returns_invalid_request() {
        use bob_core::types::{ChannelId, InternalEvent, RequestContext, UserId};
        use requests_handler::Config as QueueConfig;
        use std::sync::{Arc, Mutex};
        use std::time::Duration;
        use tokio::sync::watch;

        let received: Arc<Mutex<Vec<(InternalEvent, RequestContext)>>> =
            Arc::new(Mutex::new(vec![]));
        let received_clone = received.clone();

        let (cancel_tx, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 64,
            request_submit_timeout: Duration::from_secs(5),
        };
        let (intake, intake_task) = requests_handler::start_with(
            cfg,
            move |(ev, ctx)| {
                let r = received_clone.clone();
                async move {
                    r.lock().unwrap().push((ev, ctx));
                }
            },
            cancel_rx,
        );

        let channel_id = ChannelId::new();
        let (frame_handle, _actor_task) = chat_adapter::start(intake, channel_id, 16);
        let router = std::sync::Arc::new(crate::chat_router::ChatReplyRouter::new());
        let dispatcher = Dispatcher::new(None, None, None, "0.1.0-test")
            .with_chat_handle(frame_handle)
            .with_chat_router(std::sync::Arc::clone(&router));
        let mut registry = make_registry();

        let open_outcome = dispatcher
            .dispatch(make_request("chat.open", json!(92)), &mut registry)
            .await;
        let sub_id = match open_outcome {
            DispatchOutcome::ChatSubscribed { response, .. } => {
                response.result["id"].as_str().unwrap().to_string()
            }
            _ => panic!("expected ChatSubscribed for chat.open"),
        };

        for (id, application_identity) in [(93, ""), (94, "not-a-uuid")] {
            let outcome = dispatcher
                .dispatch(
                    make_request_with_params(
                        "chat.send",
                        json!(id),
                        json!({
                            "id": sub_id,
                            "text": "bad identity",
                            "application_identity": application_identity
                        }),
                    ),
                    &mut registry,
                )
                .await;

            match outcome {
                DispatchOutcome::Err(resp) => {
                    assert_eq!(resp.id, json!(id));
                    assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
                }
                _ => panic!("expected invalid-request for malformed application_identity"),
            }
        }

        let valid_outcome = dispatcher
            .dispatch(
                make_request_with_params(
                    "chat.send",
                    json!(95),
                    json!({
                        "id": sub_id,
                        "text": "ok identity",
                        "application_identity": UserId::new().to_string()
                    }),
                ),
                &mut registry,
            )
            .await;
        match valid_outcome {
            DispatchOutcome::Ok(_) => {}
            _ => panic!("expected valid application_identity to pass"),
        }

        tokio::task::yield_now().await;
        cancel_tx.send(true).unwrap();
        tokio::time::timeout(Duration::from_secs(2), intake_task)
            .await
            .expect("intake task must finish")
            .expect("intake task must not panic");

        let got = received.lock().unwrap();
        assert_eq!(got.len(), 1, "only valid identity should be forwarded");
    }

    fn make_dispatcher_with_chat_handle(frame_handle: chat_adapter::FrameHandle) -> Dispatcher {
        Dispatcher::new(None, None, None, "0.1.0-test").with_chat_handle(frame_handle)
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
        let session_id = sup_handle
            .acquire_session()
            .await
            .expect("acquire session must succeed");

        let dispatcher = Dispatcher::new(Some(sup_handle), None, None, "0.1.0-test");
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
        let session_id = sup_handle
            .acquire_session()
            .await
            .expect("acquire session must succeed");

        let dispatcher = Dispatcher::new(Some(sup_handle), None, None, "0.1.0-test");
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
    async fn dispatch_policy_reload_without_handle_returns_not_implemented() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("policy.reload", json!(9));
        let mut registry = make_registry();

        match dispatcher.dispatch(req, &mut registry).await {
            DispatchOutcome::Err(resp) => assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND),
            DispatchOutcome::Ok(_) => panic!("expected error"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_policy_reload_with_handle_returns_ok_when_reload_succeeds() {
        let tmp = tempfile::NamedTempFile::new().expect("temp file");
        std::fs::write(
            tmp.path(),
            "[policy]\nadmitted_users = [\"00000000-0000-0000-0000-0000000000aa\"]\n",
        )
        .expect("write config");

        let cfg = policy_control::Config {
            config_path: tmp.path().to_path_buf(),
            ..policy_control::Config::default()
        };
        let (policy_handle, policy_task, _snapshot) = policy_control::start(cfg);
        let dispatcher = Dispatcher::new(None, Some(policy_handle), None, "0.1.0-test");
        let req = make_request("policy.reload", json!(35));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        policy_task.abort();
        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(35));
                assert_eq!(resp.result["ok"], json!(true));
                assert_eq!(resp.result["reloaded"], json!(true));
            }
            DispatchOutcome::Err(e) => panic!("expected Ok, got error: {}", e.error.message),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_policy_reload_with_handle_returns_error_with_reason_when_reload_fails() {
        let tmp = tempfile::NamedTempFile::new().expect("temp file");
        std::fs::write(tmp.path(), "[policy]\nnot valid = { toml\n").expect("write config");

        let cfg = policy_control::Config {
            config_path: tmp.path().to_path_buf(),
            ..policy_control::Config::default()
        };
        let (policy_handle, policy_task, _snapshot) = policy_control::start(cfg);
        let dispatcher = Dispatcher::new(None, Some(policy_handle), None, "0.1.0-test");
        let req = make_request("policy.reload", json!(36));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        policy_task.abort();
        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(36));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
                let data = resp.error.data.expect("error data must be present");
                assert!(
                    data["reason"].is_string(),
                    "reason must be present in error data"
                );
                assert!(
                    !data["reason"]
                        .as_str()
                        .expect("reason must be string")
                        .is_empty(),
                    "reason must be non-empty"
                );
            }
            DispatchOutcome::Ok(_) => panic!("expected error"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }
}
