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
//! | `report.submit` | admin socket peer gate | Accepts an [`ExternalReportAuditPayload`][bob_core::types::ExternalReportAuditPayload], delegates to Monitoring, returns `{ ok: true }` |

use std::path::PathBuf;
use std::time::Instant;

use bob_core::error::ServiceError;
use bob_core::types::{
    AuditFilterKind, AuditRecord as MonitoringAuditRecord, AuditRecordKind, AuditRecordPayload,
    ExternalReportAuditPayload, ScheduleEntry,
};
use croner::parser::{CronParser, Seconds};
use serde_json::{json, Value};
use std::str::FromStr;
use uuid::Uuid;

use tokio::sync::{mpsc, oneshot};

use crate::{
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
    /// Optional scheduler-adapter reload handle.
    ///
    /// When present, `schedule.*` methods (T-097) push updated job tables to
    /// the scheduler actor.  When absent, `schedule.*` methods return -32601.
    scheduler: Option<scheduler_adapter::ReloadHandle>,
    /// Path to the `bob.toml` config file.
    ///
    /// Required for `schedule.add`, `schedule.remove`, and `schedule.reload`
    /// to persist entries.  When absent those methods return -32601.
    config_path: Option<PathBuf>,
    /// Serializes `schedule.add`/`schedule.remove` so concurrent admin clients
    /// cannot interleave the load→modify→write→reload sequence and silently
    /// drop one another's update. Shared across all per-connection clones of
    /// the dispatcher via the `Arc`.
    schedule_write_lock: std::sync::Arc<tokio::sync::Mutex<()>>,
    /// Configuration for spawning interactive pi sessions (T-105 / ADR-011).
    ///
    /// When `None`, built-in defaults are used: command `"pi"`, empty args,
    /// 10-second deadline, and the current process executable as the extension
    /// path (the latter is overridden in production by the real `bob.ts` path).
    interactive_session: Option<crate::InteractiveSessionConfig>,
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
    /// An interactive pi session is ready to be opened.
    ///
    /// The connection loop must receive three file descriptors (`SCM_RIGHTS`
    /// ancillary data) from the socket, then call
    /// `supervisor.start_interactive_session` with those fds, and finally send a
    /// success (or error) response back to the client.
    ///
    /// No pre-flight admission check is performed (ADR-010): the socket-access
    /// gate (0700 permission) is the only transport gate for interactive sessions.
    InteractiveSessionOpening {
        /// The JSON-RPC request id, to be echoed in the eventual response.
        id: serde_json::Value,
        /// A freshly-allocated session id to use for the spawned pi process.
        session_id: bob_core::types::SessionId,
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
            scheduler: None,
            config_path: None,
            schedule_write_lock: std::sync::Arc::new(tokio::sync::Mutex::new(())),
            interactive_session: None,
            started_at: Instant::now(),
            version,
        }
    }

    /// Attach an interactive-session spawn configuration (T-105 / ADR-011).
    ///
    /// When present, `session.interactive.open` uses these values to spawn the
    /// interactive pi child process.  When absent (the default), the built-in
    /// defaults are used (command `"pi"`, no extra args, 10-second deadline, and
    /// the current process executable as the extension path).
    #[must_use]
    pub fn with_interactive_session_config(
        mut self,
        config: crate::InteractiveSessionConfig,
    ) -> Self {
        self.interactive_session = Some(config);
        self
    }

    /// Return a clone of the interactive-session config, if one is configured.
    ///
    /// Used by the connection loop to pass spawn parameters to
    /// `handle_interactive_session_opening`.
    pub fn interactive_session_config(&self) -> Option<crate::InteractiveSessionConfig> {
        self.interactive_session.clone()
    }

    /// Return a clone of the pi-agent-supervisor handle, if one is configured.
    ///
    /// Used by the connection loop to call `start_interactive_session` and
    /// `kill_session` when handling `InteractiveSessionOpening` outcomes.
    pub fn supervisor_handle(&self) -> Option<pi_agent_supervisor::Handle> {
        self.supervisor.clone()
    }

    /// Attach a scheduler-adapter reload handle.
    ///
    /// When present, `schedule.*` methods can push updated job tables to the
    /// scheduler actor.  When absent (the default), `schedule.*` methods return
    /// `-32601 Method not found`.
    #[must_use]
    pub fn with_scheduler_handle(mut self, handle: scheduler_adapter::ReloadHandle) -> Self {
        self.scheduler = Some(handle);
        self
    }

    /// Set the path to the `bob.toml` config file.
    ///
    /// Required for `schedule.add`, `schedule.remove`, and `schedule.reload`
    /// to persist and read schedule entries.  When absent those methods return
    /// `-32601 Method not found`.
    #[must_use]
    pub fn with_config_path(mut self, path: PathBuf) -> Self {
        self.config_path = Some(path);
        self
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
            "report.submit" => self.handle_report_submit(id, &request.params).await,
            "schedule.add" => self.handle_schedule_add(id, &request.params).await,
            "schedule.remove" => self.handle_schedule_remove(id, &request.params).await,
            "schedule.list" => self.handle_schedule_list(id).await,
            "schedule.reload" => self.handle_schedule_reload(id).await,
            "session.interactive.open" => self.handle_session_interactive_open(id).await,
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

    /// Handle `session.interactive.open`.
    ///
    /// Allocates a fresh `SessionId` and returns [`DispatchOutcome::InteractiveSessionOpening`]
    /// so the connection loop can receive the three terminal file descriptors via
    /// `SCM_RIGHTS` ancillary data and then start the supervised interactive pi
    /// session (T-104).
    ///
    /// **No pre-flight admission check is performed** — interactive chat is exempt from
    /// per-user pre-flight admission (ADR-010). The sole transport gate is the 0700
    /// socket-access permission check performed at connection accept time.
    ///
    /// Returns `-32601 Method not found` when no supervisor handle is configured.
    async fn handle_session_interactive_open(&self, id: Value) -> DispatchOutcome {
        let Some(_) = self.supervisor else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "session.interactive.open is not available: no supervisor handle",
                Some(json!({ "method": "session.interactive.open" })),
            ));
        };
        let session_id = bob_core::types::SessionId::new();
        tracing::debug!(
            session_id = %session_id,
            "session.interactive.open: allocated session id, awaiting fd receive"
        );
        DispatchOutcome::InteractiveSessionOpening { id, session_id }
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

    // ── Schedule method handlers ─────────────────────────────────────────────

    /// Handle `schedule.add { id, cron, prompt }`.
    ///
    /// Validates the entry (non-blank fields, valid 5-field croner expression,
    /// id not already in the live table), then atomically writes the updated
    /// `[[schedule]]` array back to the config file and signals a reload.
    async fn handle_schedule_add(&self, id: Value, params: &Option<Value>) -> DispatchOutcome {
        let (handle, config_path) = match self.schedule_handles() {
            Some(pair) => pair,
            None => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_METHOD_NOT_FOUND,
                    "schedule.add is not available: no scheduler handle or config path",
                    Some(json!({ "method": "schedule.add" })),
                ));
            }
        };

        // Parse params.
        let Some(ref params_value) = params else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "schedule.add requires params",
                Some(json!({ "category": "invalid_request" })),
            ));
        };

        let entry_id = match params_value.get("id").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_owned(),
            Some(_) | None => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_INVALID_REQUEST,
                    "schedule.add requires a non-blank params.id",
                    Some(json!({ "category": "invalid_request" })),
                ));
            }
        };

        let entry_cron = match params_value.get("cron").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_owned(),
            Some(_) | None => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_INVALID_REQUEST,
                    "schedule.add requires a non-blank params.cron",
                    Some(json!({ "category": "invalid_request" })),
                ));
            }
        };

        let entry_prompt = match params_value.get("prompt").and_then(|v| v.as_str()) {
            Some(s) if !s.trim().is_empty() => s.to_owned(),
            Some(_) | None => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_INVALID_REQUEST,
                    "schedule.add requires a non-blank params.prompt",
                    Some(json!({ "category": "invalid_request" })),
                ));
            }
        };

        // Validate the cron expression (must be a valid 5-field expression).
        let parser = CronParser::builder().seconds(Seconds::Disallowed).build();
        if let Err(err) = parser.parse(&entry_cron) {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_INVALID_REQUEST,
                "schedule.add: invalid cron expression",
                Some(json!({
                    "category": "invalid_request",
                    "reason": err.to_string(),
                })),
            ));
        }

        // Serialize against concurrent schedule mutations so the duplicate
        // check and the load→write→reload below cannot interleave with another
        // add/remove and silently lose an update.
        let _write_guard = self.schedule_write_lock.lock().await;

        // Check that the id is not already in the live table.
        {
            let live = handle.subscribe();
            let current = live.borrow();
            if current.iter().any(|e| e.id == entry_id) {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_INVALID_REQUEST,
                    "schedule.add: an entry with this id already exists",
                    Some(json!({
                        "category": "invalid_request",
                        "entry_id": entry_id,
                    })),
                ));
            }
        }

        // Read current entries from config, append the new one, write back.
        let mut entries = match self.load_schedule_entries_from_config(config_path) {
            Ok(e) => e,
            Err(outcome) => return outcome,
        };
        entries.push(ScheduleEntry {
            id: entry_id,
            cron: entry_cron,
            prompt: entry_prompt,
        });

        if let Err(outcome) = self.write_and_reload(config_path, entries, handle) {
            return outcome;
        }

        DispatchOutcome::Ok(Response::ok(id, json!({ "ok": true })))
    }

    /// Handle `schedule.remove { id }`.
    async fn handle_schedule_remove(&self, id: Value, params: &Option<Value>) -> DispatchOutcome {
        let (handle, config_path) = match self.schedule_handles() {
            Some(pair) => pair,
            None => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_METHOD_NOT_FOUND,
                    "schedule.remove is not available: no scheduler handle or config path",
                    Some(json!({ "method": "schedule.remove" })),
                ));
            }
        };

        // Parse params.id.
        let entry_id = match params
            .as_ref()
            .and_then(|p| p.get("id"))
            .and_then(|v| v.as_str())
        {
            Some(s) if !s.trim().is_empty() => s.to_owned(),
            Some(_) | None => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_INVALID_REQUEST,
                    "schedule.remove requires a non-blank params.id",
                    Some(json!({ "category": "invalid_request" })),
                ));
            }
        };

        // Serialize against concurrent schedule mutations so the existence
        // check and the load→write→reload below cannot interleave with another
        // add/remove and silently lose an update.
        let _write_guard = self.schedule_write_lock.lock().await;

        // Verify the id exists in the live table.
        {
            let live = handle.subscribe();
            let current = live.borrow();
            if !current.iter().any(|e| e.id == entry_id) {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_INVALID_REQUEST,
                    "schedule.remove: no entry found with this id",
                    Some(json!({
                        "category": "invalid_request",
                        "entry_id": entry_id,
                    })),
                ));
            }
        }

        // Read config, filter out the entry, write back.
        let entries = match self.load_schedule_entries_from_config(config_path) {
            Ok(e) => e,
            Err(outcome) => return outcome,
        };
        let updated: Vec<ScheduleEntry> =
            entries.into_iter().filter(|e| e.id != entry_id).collect();

        if let Err(outcome) = self.write_and_reload(config_path, updated, handle) {
            return outcome;
        }

        DispatchOutcome::Ok(Response::ok(id, json!({ "ok": true })))
    }

    /// Handle `schedule.list`.
    ///
    /// Returns the current live job table from the scheduler actor's watch
    /// receiver. No disk read.
    async fn handle_schedule_list(&self, id: Value) -> DispatchOutcome {
        let Some(ref handle) = self.scheduler else {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "schedule.list is not available: no scheduler handle",
                Some(json!({ "method": "schedule.list" })),
            ));
        };

        let entries: Vec<Value> = handle
            .subscribe()
            .borrow()
            .iter()
            .map(|e| {
                json!({
                    "id": e.id,
                    "cron": e.cron,
                    "prompt": e.prompt,
                })
            })
            .collect();

        DispatchOutcome::Ok(Response::ok(id, json!(entries)))
    }

    /// Handle `schedule.reload`.
    ///
    /// Reads `[[schedule]]` entries from the config file on disk and sends the
    /// full `Vec<ScheduleEntry>` over the reload handle.  This is the only
    /// `schedule.*` method that re-reads disk; it allows the operator to
    /// reconcile the live table with a hand-edited config file.
    async fn handle_schedule_reload(&self, id: Value) -> DispatchOutcome {
        let (handle, config_path) = match self.schedule_handles() {
            Some(pair) => pair,
            None => {
                return DispatchOutcome::Err(ErrorResponse::error(
                    id,
                    CODE_METHOD_NOT_FOUND,
                    "schedule.reload is not available: no scheduler handle or config path",
                    Some(json!({ "method": "schedule.reload" })),
                ));
            }
        };

        let entries = match self.load_schedule_entries_from_config(config_path) {
            Ok(e) => e,
            Err(outcome) => return outcome,
        };

        if handle.reload(entries).is_err() {
            return DispatchOutcome::Err(ErrorResponse::error(
                id,
                CODE_METHOD_NOT_FOUND,
                "schedule.reload: scheduler actor has stopped",
                Some(json!({ "category": "service_down" })),
            ));
        }

        DispatchOutcome::Ok(Response::ok(id, json!({ "ok": true })))
    }

    // ── Private schedule helpers ─────────────────────────────────────────────

    /// Return `(handle, config_path)` when both are configured, or `None`.
    fn schedule_handles(&self) -> Option<(&scheduler_adapter::ReloadHandle, &std::path::Path)> {
        match (&self.scheduler, &self.config_path) {
            (Some(h), Some(p)) => Some((h, p.as_path())),
            _ => None,
        }
    }

    /// Load `[[schedule]]` entries from the config file at `path`.
    ///
    /// Returns `Err(DispatchOutcome::Err(...))` on read or parse failure.
    fn load_schedule_entries_from_config(
        &self,
        path: &std::path::Path,
    ) -> Result<Vec<ScheduleEntry>, DispatchOutcome> {
        use bob_core::types::ScheduleEntry as SE;

        if !path.exists() {
            // No config file yet — treat as empty schedule.
            return Ok(Vec::new());
        }

        let content = std::fs::read_to_string(path).map_err(|e| {
            DispatchOutcome::Err(ErrorResponse::error(
                Value::Null,
                CODE_METHOD_NOT_FOUND,
                "schedule method: failed to read config file",
                Some(json!({
                    "category": "configuration",
                    "reason": e.to_string(),
                })),
            ))
        })?;

        // Parse only the [[schedule]] array; other keys are irrelevant here.
        #[derive(serde::Deserialize, Default)]
        struct ScheduleSection {
            #[serde(default)]
            schedule: Vec<RawEntry>,
        }

        #[derive(serde::Deserialize)]
        struct RawEntry {
            #[serde(default)]
            id: String,
            #[serde(default)]
            cron: String,
            #[serde(default)]
            prompt: String,
        }

        let parsed: ScheduleSection = toml::from_str(&content).map_err(|e| {
            DispatchOutcome::Err(ErrorResponse::error(
                Value::Null,
                CODE_METHOD_NOT_FOUND,
                "schedule method: failed to parse config file",
                Some(json!({
                    "category": "configuration",
                    "reason": e.to_string(),
                })),
            ))
        })?;

        Ok(parsed
            .schedule
            .into_iter()
            .map(|r| SE {
                id: r.id,
                cron: r.cron,
                prompt: r.prompt,
            })
            .collect())
    }

    /// Write `entries` to `config_path` and signal the scheduler actor to reload.
    ///
    /// Returns `Err(DispatchOutcome::Err(...))` on write or reload failure.
    fn write_and_reload(
        &self,
        config_path: &std::path::Path,
        entries: Vec<ScheduleEntry>,
        handle: &scheduler_adapter::ReloadHandle,
    ) -> Result<(), DispatchOutcome> {
        bob_core::types::schedule::write_schedule_entries(config_path, &entries).map_err(|e| {
            DispatchOutcome::Err(ErrorResponse::error(
                Value::Null,
                CODE_METHOD_NOT_FOUND,
                "schedule method: failed to write config file",
                Some(json!({
                    "category": "persistence",
                    "reason": e.to_string(),
                })),
            ))
        })?;

        if handle.reload(entries).is_err() {
            return Err(DispatchOutcome::Err(ErrorResponse::error(
                Value::Null,
                CODE_METHOD_NOT_FOUND,
                "schedule method: scheduler actor has stopped",
                Some(json!({ "category": "service_down" })),
            )));
        }

        Ok(())
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
        let mut cfg = pi_agent_supervisor::Config::default();
        cfg.extension_path =
            std::env::current_exe().expect("current executable should exist in tests");
        let (handle, join) =
            pi_agent_supervisor::start(cfg).expect("supervisor start must succeed in tests");
        let dispatcher = Dispatcher::new(Some(handle), None, None, "0.1.0-test");
        (dispatcher, join)
    }

    fn make_supervisor_handle() -> (pi_agent_supervisor::Handle, tokio::task::JoinHandle<()>) {
        let mut cfg = pi_agent_supervisor::Config::default();
        cfg.extension_path =
            std::env::current_exe().expect("current executable should exist in tests");
        pi_agent_supervisor::start(cfg).expect("supervisor start must succeed in tests")
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

    // ── Helpers for schedule.* tests ─────────────────────────────────────────

    fn make_scheduler_handle() -> (scheduler_adapter::ReloadHandle, tokio::task::JoinHandle<()>) {
        use bob_core::types::ScheduleEntry;
        use requests_handler::Config as QueueConfig;
        use std::time::Duration;
        use tokio::sync::watch;

        let (_, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 4,
            request_submit_timeout: Duration::from_secs(1),
        };
        let (intake, _intake_task) =
            requests_handler::start_with(cfg, move |_| async {}, cancel_rx);
        let entries: Vec<ScheduleEntry> = vec![];
        scheduler_adapter::start(intake, entries)
    }

    fn write_temp_bob_toml(contents: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("bob.toml");
        std::fs::write(&path, contents).expect("write temp bob.toml");
        (dir, path)
    }

    // AC-1 (T-097): schedule.list with a scheduler handle returns the live job table.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_schedule_list_with_scheduler_handle_returns_live_job_table() {
        use bob_core::types::ScheduleEntry;

        let (reload_handle, scheduler_join) = make_scheduler_handle();

        // Pre-load two entries into the watch channel.
        reload_handle
            .reload(vec![
                ScheduleEntry {
                    id: "job-a".to_owned(),
                    cron: "0 9 * * *".to_owned(),
                    prompt: "Morning report".to_owned(),
                },
                ScheduleEntry {
                    id: "job-b".to_owned(),
                    cron: "0 17 * * *".to_owned(),
                    prompt: "Evening report".to_owned(),
                },
            ])
            .expect("reload must succeed");
        tokio::task::yield_now().await;

        let dispatcher = make_dispatcher_no_handles().with_scheduler_handle(reload_handle);
        let req = make_request("schedule.list", json!(300));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        scheduler_join.abort();
        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(300));
                let arr = resp.result.as_array().expect("result must be an array");
                assert_eq!(arr.len(), 2, "must return two entries");
                assert_eq!(arr[0]["id"], json!("job-a"));
                assert_eq!(arr[0]["cron"], json!("0 9 * * *"));
                assert_eq!(arr[0]["prompt"], json!("Morning report"));
                assert_eq!(arr[1]["id"], json!("job-b"));
            }
            DispatchOutcome::Err(e) => {
                panic!("expected Ok, got error: {}", e.error.message)
            }
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-4 (T-097): schedule.list without a scheduler handle returns -32601.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_schedule_list_without_scheduler_handle_returns_method_not_found() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("schedule.list", json!(301));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(301));
                assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
            }
            DispatchOutcome::Ok(_) => panic!("expected error, got Ok"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-1 (T-097): schedule.add with valid entry writes to config and returns ok.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_schedule_add_with_valid_entry_persists_and_returns_ok() {
        let (_dir, config_path) = write_temp_bob_toml("");
        let (reload_handle, scheduler_join) = make_scheduler_handle();
        let dispatcher = make_dispatcher_no_handles()
            .with_scheduler_handle(reload_handle)
            .with_config_path(config_path.clone());

        let req = make_request_with_params(
            "schedule.add",
            json!(310),
            json!({
                "id": "new-job",
                "cron": "0 9 * * *",
                "prompt": "Morning report"
            }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        scheduler_join.abort();
        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(310));
                assert_eq!(resp.result["ok"], json!(true));
            }
            DispatchOutcome::Err(e) => {
                panic!("expected Ok, got error: {}", e.error.message)
            }
            _ => panic!("unexpected dispatch outcome variant"),
        }

        // Verify the entry was persisted to the config file.
        let content = std::fs::read_to_string(&config_path).expect("read config");
        assert!(content.contains("new-job"), "entry id must be persisted");
    }

    // AC-2 (T-097): schedule.add with duplicate id returns -32602 and leaves file unchanged.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_schedule_add_with_duplicate_id_returns_error_and_leaves_file_unchanged() {
        let initial = "[[schedule]]\nid = \"existing\"\ncron = \"0 9 * * *\"\nprompt = \"p\"\n";
        let (_dir, config_path) = write_temp_bob_toml(initial);
        let (reload_handle, scheduler_join) = make_scheduler_handle();

        // Pre-load the existing entry into the watch channel so schedule.add can
        // detect the duplicate in the live table.
        reload_handle
            .reload(vec![bob_core::types::ScheduleEntry {
                id: "existing".to_owned(),
                cron: "0 9 * * *".to_owned(),
                prompt: "p".to_owned(),
            }])
            .expect("reload");
        tokio::task::yield_now().await;

        let dispatcher = make_dispatcher_no_handles()
            .with_scheduler_handle(reload_handle)
            .with_config_path(config_path.clone());

        let req = make_request_with_params(
            "schedule.add",
            json!(311),
            json!({
                "id": "existing",
                "cron": "0 10 * * *",
                "prompt": "duplicate"
            }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        scheduler_join.abort();
        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(311));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Ok(_) => panic!("expected error for duplicate id"),
            _ => panic!("unexpected dispatch outcome variant"),
        }

        // File must be unchanged — still contains the original entry.
        let content = std::fs::read_to_string(&config_path).expect("read config");
        assert!(content.contains("existing"), "original entry must remain");
    }

    // AC-2 (T-097): schedule.add with invalid cron returns error.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_schedule_add_with_invalid_cron_returns_error() {
        let (_dir, config_path) = write_temp_bob_toml("");
        let (reload_handle, scheduler_join) = make_scheduler_handle();
        let dispatcher = make_dispatcher_no_handles()
            .with_scheduler_handle(reload_handle)
            .with_config_path(config_path.clone());

        let req = make_request_with_params(
            "schedule.add",
            json!(312),
            json!({
                "id": "bad-job",
                "cron": "not-a-cron",
                "prompt": "something"
            }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        scheduler_join.abort();
        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(312));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Ok(_) => panic!("expected error for invalid cron"),
            _ => panic!("unexpected dispatch outcome variant"),
        }

        // File must not have been written with invalid data.
        let content = std::fs::read_to_string(&config_path).expect("read config");
        assert!(
            !content.contains("bad-job"),
            "invalid entry must not be persisted"
        );
    }

    // AC-3 (T-097): schedule.remove with known id removes from config and returns ok.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_schedule_remove_with_known_id_removes_entry_and_returns_ok() {
        let initial =
            "[[schedule]]\nid = \"to-remove\"\ncron = \"0 9 * * *\"\nprompt = \"p\"\n\n[[schedule]]\nid = \"keep\"\ncron = \"0 10 * * *\"\nprompt = \"q\"\n";
        let (_dir, config_path) = write_temp_bob_toml(initial);
        let (reload_handle, scheduler_join) = make_scheduler_handle();

        // Pre-load entries into the live table.
        reload_handle
            .reload(vec![
                bob_core::types::ScheduleEntry {
                    id: "to-remove".to_owned(),
                    cron: "0 9 * * *".to_owned(),
                    prompt: "p".to_owned(),
                },
                bob_core::types::ScheduleEntry {
                    id: "keep".to_owned(),
                    cron: "0 10 * * *".to_owned(),
                    prompt: "q".to_owned(),
                },
            ])
            .expect("reload");
        tokio::task::yield_now().await;

        let dispatcher = make_dispatcher_no_handles()
            .with_scheduler_handle(reload_handle)
            .with_config_path(config_path.clone());

        let req =
            make_request_with_params("schedule.remove", json!(320), json!({ "id": "to-remove" }));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        scheduler_join.abort();
        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(320));
                assert_eq!(resp.result["ok"], json!(true));
            }
            DispatchOutcome::Err(e) => {
                panic!("expected Ok, got error: {}", e.error.message)
            }
            _ => panic!("unexpected dispatch outcome variant"),
        }

        let content = std::fs::read_to_string(&config_path).expect("read config");
        assert!(
            !content.contains("to-remove"),
            "removed entry must not be in file"
        );
        assert!(content.contains("keep"), "other entry must remain");
    }

    // AC-3 (T-097): schedule.remove with unknown id returns error.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_schedule_remove_with_unknown_id_returns_error() {
        let (_dir, config_path) = write_temp_bob_toml("");
        let (reload_handle, scheduler_join) = make_scheduler_handle();
        let dispatcher = make_dispatcher_no_handles()
            .with_scheduler_handle(reload_handle)
            .with_config_path(config_path.clone());

        let req = make_request_with_params(
            "schedule.remove",
            json!(321),
            json!({ "id": "does-not-exist" }),
        );
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        scheduler_join.abort();
        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(321));
                assert_eq!(resp.error.code, CODE_INVALID_REQUEST);
            }
            DispatchOutcome::Ok(_) => panic!("expected error for unknown id"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-1 (T-097): schedule.reload reads from disk and signals the actor.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_schedule_reload_reads_from_disk_and_returns_ok() {
        let (_dir, config_path) = write_temp_bob_toml(
            "[[schedule]]\nid = \"disk-job\"\ncron = \"0 9 * * *\"\nprompt = \"p\"\n",
        );
        let (reload_handle, scheduler_join) = make_scheduler_handle();
        let rx = reload_handle.subscribe();
        let dispatcher = make_dispatcher_no_handles()
            .with_scheduler_handle(reload_handle)
            .with_config_path(config_path.clone());

        let req = make_request("schedule.reload", json!(330));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        scheduler_join.abort();
        match outcome {
            DispatchOutcome::Ok(resp) => {
                assert_eq!(resp.id, json!(330));
                assert_eq!(resp.result["ok"], json!(true));
            }
            DispatchOutcome::Err(e) => {
                panic!("expected Ok, got error: {}", e.error.message)
            }
            _ => panic!("unexpected dispatch outcome variant"),
        }

        // The live table should now reflect the disk entry.
        let current = rx.borrow().clone();
        assert_eq!(
            current.len(),
            1,
            "live table must have one entry after reload"
        );
        assert_eq!(current[0].id, "disk-job");
    }

    // AC-2 (T-096): with_scheduler_handle stores the handle in the dispatcher
    // without panicking.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatcher_with_scheduler_handle_does_not_panic() {
        use bob_core::types::ScheduleEntry;
        use requests_handler::Config as QueueConfig;
        use std::time::Duration;
        use tokio::sync::watch;

        let (_, cancel_rx) = watch::channel(false);
        let cfg = QueueConfig {
            request_queue_capacity: 4,
            request_submit_timeout: Duration::from_secs(1),
        };
        let (intake, _intake_task) =
            requests_handler::start_with(cfg, move |_| async {}, cancel_rx);
        let entries: Vec<ScheduleEntry> = vec![];
        let (reload_handle, scheduler_join) = scheduler_adapter::start(intake, entries);

        // Must not panic.
        let _dispatcher = make_dispatcher_no_handles().with_scheduler_handle(reload_handle);

        scheduler_join.abort();
    }

    // AC-3 (T-096): schedule.add returns -32601 Method not found (placeholder).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_schedule_add_returns_method_not_found() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("schedule.add", json!(200));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(200));
                assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
            }
            DispatchOutcome::Ok(_) => panic!("expected error, got Ok"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // ── session.interactive.open tests (T-105) ───────────────────────────────

    // AC-4 (T-105): session.interactive.open without a supervisor handle returns
    // -32601 Method not found.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_session_interactive_open_without_supervisor_returns_method_not_found() {
        let dispatcher = make_dispatcher_no_handles();
        let req = make_request("session.interactive.open", json!(600));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        match outcome {
            DispatchOutcome::Err(resp) => {
                assert_eq!(resp.id, json!(600));
                assert_eq!(resp.error.code, CODE_METHOD_NOT_FOUND);
            }
            DispatchOutcome::Ok(_) => panic!("expected error without supervisor, got Ok"),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-4 (T-105): session.interactive.open with a supervisor returns
    // InteractiveSessionOpening outcome — no pre-flight admission check is
    // performed (ADR-010).
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_session_interactive_open_with_supervisor_returns_interactive_session_opening()
    {
        let (dispatcher, sup_task) = make_dispatcher_with_supervisor();
        let req = make_request("session.interactive.open", json!(601));
        let mut registry = make_registry();

        let outcome = dispatcher.dispatch(req, &mut registry).await;

        sup_task.abort();
        match outcome {
            DispatchOutcome::InteractiveSessionOpening { id, session_id } => {
                assert_eq!(id, json!(601));
                // session_id must be a freshly-allocated non-nil UUID
                assert_ne!(
                    session_id,
                    bob_core::types::SessionId::default(),
                    "session_id must be freshly allocated"
                );
            }
            DispatchOutcome::Err(e) => panic!(
                "expected InteractiveSessionOpening, got error: {}",
                e.error.message
            ),
            _ => panic!("unexpected dispatch outcome variant"),
        }
    }

    // AC-3 (T-096): schedule.remove, schedule.list, schedule.reload also return -32601.
    #[tokio::test(flavor = "current_thread")]
    async fn dispatch_schedule_namespace_methods_all_return_method_not_found() {
        let dispatcher = make_dispatcher_no_handles();
        let mut registry = make_registry();

        for (method, id) in [
            ("schedule.remove", json!(201)),
            ("schedule.list", json!(202)),
            ("schedule.reload", json!(203)),
        ] {
            let req = make_request(method, id.clone());
            let outcome = dispatcher.dispatch(req, &mut registry).await;
            match outcome {
                DispatchOutcome::Err(resp) => {
                    assert_eq!(resp.id, id, "id must match for method {method}");
                    assert_eq!(
                        resp.error.code, CODE_METHOD_NOT_FOUND,
                        "must return -32601 for {method}"
                    );
                }
                DispatchOutcome::Ok(_) => panic!("expected error for {method}, got Ok"),
                _ => panic!("unexpected dispatch outcome variant for {method}"),
            }
        }
    }
}
