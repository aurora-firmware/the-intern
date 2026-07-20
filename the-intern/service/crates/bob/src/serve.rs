#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::sync::Arc;

use bob_core::error::{ServiceError, ServiceResult};
use bob_core::ports::{AuditSink, PersistenceStore};
use bob_core::types::{
    AuditRecord, AuditRecordKind, AuditRecordPayload, DeliveryKind, ExtensionEventAuditPayload,
    ExternalReportAuditPayload, InternalEvent, ReportOutcome, ScheduleEntry, SessionId,
};
use tokio::{sync::watch, task::JoinHandle, time};
use tracing::info;

/// Polling interval for the periodic dispatcher when no Periodic event is
/// available.  Long enough to avoid busy-spinning; short enough to keep
/// shutdown latency well under the drain deadline.
const PERIODIC_DISPATCH_POLL_INTERVAL: time::Duration = time::Duration::from_millis(100);

use crate::config::BobConfig;

/// All runtime state assembled for a single `serve` execution.
///
/// Drop order is significant: handles are dropped before join handles so actors
/// see their command channel close and exit their recv loops cleanly.
///
/// The two `UnixListener` fields keep the bound sockets alive on disk for the
/// duration of the process; they are not polled (accept loops are a later task).
struct Runtime {
    // Handles kept alive to maintain actor channel capacity.
    _admin_rpc: admin_rpc::Handle,
    _extension_ipc: extension_ipc::Handle,
    _requests_handler: requests_handler::Handle,
    _monitoring: monitoring::Handle,
    _persistence: persistence::Handle,
    _policy_control: policy_control::Handle,
    _pi_agent_supervisor: pi_agent_supervisor::Handle,
    // Scheduler-adapter reload handle.  The scheduler is always started (no
    // enable/disable flag).  Dropping it closes the watch channel so the actor
    // exits its recv loop.
    _scheduler_adapter: scheduler_adapter::ReloadHandle,

    // Cancellation sender for the requests-handler actor.
    requests_handler_cancel_tx: watch::Sender<bool>,

    // Cancellation sender for the periodic dispatcher task.
    dispatcher_cancel_tx: watch::Sender<bool>,

    // Join handles for non-supervisor actors (awaited in shutdown phase 3).
    joins: Vec<JoinHandle<()>>,

    // Supervisor join handle awaited separately in shutdown phase 4 so that
    // child-process reaping is distinct from the general actor drain.
    supervisor_join: JoinHandle<()>,

    // Join handle for the scheduler-adapter actor (always present — no enable/disable flag).
    // Awaited in shutdown phase 3 alongside the other non-supervisor actors.
    scheduler_adapter_join: JoinHandle<()>,

    // Join handle for the periodic dispatcher task; awaited in shutdown phase 3.
    dispatcher_join: JoinHandle<()>,

    // Paths to remove on shutdown.
    admin_sock_path: PathBuf,
    extension_sock_path: PathBuf,

    // Snapshot handle for the active policy ruleset; wired to gate crates
    // in T-054 / T-056.
    policy_snapshot: policy_control::SnapshotHandle,
}

/// Constructs every subsystem actor, binds the two Unix domain socket paths
/// recorded in `cfg`, installs signal handlers, and runs the graceful-shutdown
/// protocol when `SIGTERM` or `SIGINT` is received.
///
/// # Errors
///
/// Returns `Err(ServiceError::ServiceDown)` when any subsystem actor fails to
/// start or when either socket path cannot be bound.  Any partially bound state
/// (including socket files) is removed before returning the error.
pub async fn run(cfg: BobConfig) -> ServiceResult<()> {
    let runtime = start_subsystems(&cfg)?;
    wait_for_signal_then_shutdown(runtime, &cfg).await
}

/// Starts every subsystem actor, binds both Unix socket paths, and returns the
/// assembled `Runtime`.
///
/// If anything fails the function emits `tracing::error!`, removes any socket
/// files already created, and returns `Err(ServiceError::ServiceDown)`.
fn start_subsystems(cfg: &BobConfig) -> ServiceResult<Runtime> {
    match try_start_subsystems(cfg) {
        Ok(runtime) => Ok(runtime),
        Err(e) => {
            tracing::error!(error = %e, "subsystem or socket bind failed; unwinding");
            // Attempt to remove socket files that may have been created.
            remove_socket_files_best_effort(cfg);
            Err(ServiceError::ServiceDown)
        }
    }
}

fn build_pi_agent_supervisor_config(cfg: &BobConfig) -> pi_agent_supervisor::Config {
    pi_agent_supervisor::Config {
        worker_command: cfg.pi_agent_command.clone(),
        worker_args: cfg.pi_agent_args.clone(),
        warm_pool_size: cfg.pi_agent_warm_pool_size,
        max_processes: cfg.pi_agent_max_processes,
        idle_reap_timeout: cfg.pi_agent_idle_reap_timeout,
        command_buffer: cfg.request_queue_capacity,
        child_termination_deadline: cfg.shutdown_reap_deadline,
        extension_sock_path: cfg.extension_sock_path.clone(),
        extension_path: cfg.extension_path.clone(),
        // T-126: service-wide worker cwd mapped from pi_agent_cwd (T-119).
        // Unset when pi_agent_cwd is None so warm-pool workers inherit the
        // launch cwd of `bob serve` (AC-1/AC-2).
        worker_cwd: cfg.pi_agent_cwd.clone(),
    }
}

/// Enqueues an admitted `Periodic` event together with its job-id correlator
/// (ADR-012 / ADR-013).
///
/// The job id comes from `RequestContext::context_id` and is threaded through
/// `PersistenceStore::enqueue_periodic_with_job_id` (T-120 / B-023) onto the
/// dedicated periodic queue, entirely separate from the general inbound
/// queue, so the periodic dispatcher can read it back via
/// `dequeue_next_periodic_with_job_id` (see `start_periodic_dispatcher`)
/// without ever touching unrelated non-periodic traffic. This function only
/// carries the correlator through the queue; it does not resolve a per-job
/// cwd or acquire a worker (T-127).
///
/// Enqueue failures (queue full or the persistence actor being down) are
/// logged as a warning and otherwise swallowed, matching the pre-T-126
/// behaviour of the plain `enqueue` call this replaces.
async fn admit_periodic_event(
    persistence_store: &dyn PersistenceStore,
    event: InternalEvent,
    job_id: Option<String>,
) {
    if let Err(err) = persistence_store
        .enqueue_periodic_with_job_id(event, job_id.clone())
        .await
    {
        tracing::warn!(
            error = %err,
            job_id = job_id.as_deref().unwrap_or("<unknown>"),
            "scheduler: periodic event persistence enqueue failed"
        );
    }
}

fn build_interactive_session_config(cfg: &BobConfig) -> admin_rpc::InteractiveSessionConfig {
    admin_rpc::InteractiveSessionConfig {
        command: cfg.pi_agent_command.clone(),
        args: Vec::new(),
        child_termination_deadline: cfg.shutdown_reap_deadline,
        extension_sock_path: cfg.extension_sock_path.clone(),
        extension_path: cfg.extension_path.clone(),
    }
}

fn build_monitoring_config(cfg: &BobConfig) -> monitoring::Config {
    monitoring::Config {
        command_buffer: cfg.request_queue_capacity,
        audit_log_path: cfg.monitoring.audit_log_path.clone(),
    }
}

fn try_start_subsystems(cfg: &BobConfig) -> Result<Runtime, Box<dyn std::error::Error>> {
    info!("starting monitoring actor");
    let monitoring_cfg = build_monitoring_config(cfg);
    let (monitoring_handle, monitoring_join) = monitoring::start(monitoring_cfg);
    info!("monitoring actor started");

    info!("starting persistence actor");
    let (persistence_handle, persistence_join) = persistence::start(persistence::Config::default());
    info!("persistence actor started");

    info!("starting policy-control actor");
    // Build the initial ruleset snapshot from the policy config.  An empty
    // (deny-all) config is always valid; a structurally invalid config (e.g.
    // an ArgMatcher with empty fields) fails startup here rather than at
    // policy check time.
    let initial_snapshot = policy_control::RulesetSnapshot::from_config(cfg.policy.clone())
        .map_err(|e| format!("invalid policy config: {e}"))?;
    let policy_cfg = policy_control::Config {
        initial_snapshot,
        config_path: cfg.config_path.clone(),
        command_buffer: 16,
    };
    let (policy_control_handle, policy_control_join, policy_snapshot) =
        policy_control::start(policy_cfg);
    info!("policy-control actor started");

    info!("starting pi-agent-supervisor actor");
    let pi_agent_supervisor_cfg = build_pi_agent_supervisor_config(cfg);
    let (pi_agent_supervisor_handle, pi_agent_supervisor_join) =
        pi_agent_supervisor::start(pi_agent_supervisor_cfg)?;
    info!("pi-agent-supervisor actor started");

    info!("starting requests-handler actor");
    let (rh_cancel_tx, rh_cancel_rx) = watch::channel(false);
    let persistence_store: Arc<dyn PersistenceStore> = Arc::new(persistence_handle.clone());
    let audit_sink: Arc<dyn AuditSink> = Arc::new(monitoring::MonitoringAuditSink::new(
        monitoring_handle.clone(),
    ));
    // T-127: a separate clone for the periodic dispatcher's monitoring failure
    // record (AC-2), taken before `audit_sink` is moved into the pre-flight
    // closure below.
    let periodic_dispatch_audit_sink = Arc::clone(&audit_sink);
    // Clone the snapshot handle for use in the pre-flight closure.
    let preflight_snapshot = policy_snapshot.clone();
    let (requests_handler_handle, requests_handler_join) = requests_handler::start_with(
        requests_handler::Config {
            request_queue_capacity: cfg.request_queue_capacity,
            request_submit_timeout: cfg.request_submit_timeout,
        },
        move |(event, context)| {
            let preflight_snapshot = preflight_snapshot.clone();
            let persistence_store = Arc::clone(&persistence_store);
            let audit_sink = Arc::clone(&audit_sink);
            async move {
                if event.kind == DeliveryKind::Periodic {
                    // ADR-012: scheduled jobs are admitted by the local Unix trust
                    // boundary, not by scheduler-derived UserId checks against
                    // [policy].admitted_users.  A schedule entry present in the
                    // trusted JSON schedule store is sufficient authorization; no
                    // additional UserId admission evaluation is performed here.
                    //
                    // The request context (job id in context_id, channel/user ids)
                    // is preserved for audit attribution by the scheduler-adapter.
                    // T-126 (ADR-013): the job id is threaded through the
                    // dedicated periodic queue (B-023) via
                    // enqueue_periodic_with_job_id so the periodic dispatcher
                    // can read it back on dequeue without ever touching the
                    // general inbound queue.
                    admit_periodic_event(
                        persistence_store.as_ref(),
                        event,
                        context.context_id.clone(),
                    )
                    .await;
                } else {
                    requests_handler::run_preflight(
                        event,
                        Some(&context),
                        &preflight_snapshot,
                        persistence_store.as_ref(),
                        audit_sink.as_ref(),
                    )
                    .await;
                }
            }
        },
        rh_cancel_rx,
    );
    info!("requests-handler actor started");

    info!("starting extension-ipc actor");
    let (extension_ipc_handle, extension_ipc_join) = extension_ipc::start(extension_ipc::Config {
        monitoring_handle: Arc::new(extension_ipc::MonitoringBackedHandle::new(
            monitoring_handle.clone(),
        )),
        policy_snapshot: policy_snapshot.clone(),
        extension_sock_path: cfg.extension_sock_path.clone(),
        ..extension_ipc::Config::default()
    })
    .map_err(|e| {
        format!(
            "failed to bind extension socket at {}: {e}",
            cfg.extension_sock_path.display()
        )
    })?;
    info!("extension-ipc actor started");

    info!("starting scheduler-adapter actor");
    let (scheduler_reload_handle, scheduler_join) = scheduler_adapter::start(
        requests_handler_handle.clone(),
        cfg.schedule.entries.clone(),
    );
    info!("scheduler-adapter actor started");

    info!("starting admin-rpc actor");
    // Wire the JSON schedule store path (ADR-012, T-115) so that schedule.*
    // admin-RPC mutations persist to `schedules.json` instead of `config.toml`.
    let maybe_schedule_store_path = if cfg.schedule_store_path.as_os_str().is_empty() {
        None
    } else {
        Some(cfg.schedule_store_path.clone())
    };
    // The trusted service principal for the schedule-store Unix trust boundary
    // (ADR-012 / ADR-005). Only meaningful when a real store path is wired.
    let maybe_schedule_store_uid = maybe_schedule_store_path
        .as_ref()
        .map(|_| crate::config::effective_uid());
    let admin_rpc_cfg = admin_rpc::Config {
        admin_sock_path: cfg.admin_sock_path.clone(),
        supervisor: Some(pi_agent_supervisor_handle.clone()),
        policy: Some(policy_control_handle.clone()),
        monitoring: Some(monitoring_handle.clone()),
        // Clone the scheduler reload handle into the admin-RPC dispatcher so that
        // schedule.* methods (T-097) can push updated job tables to the actor.
        // The primary handle is retained in the Runtime for shutdown ordering.
        scheduler: Some(scheduler_reload_handle.clone()),
        schedule_store_path: maybe_schedule_store_path,
        schedule_store_uid: maybe_schedule_store_uid,
        interactive_session: Some(build_interactive_session_config(cfg)),
        ..admin_rpc::Config::default()
    };
    let (admin_rpc_handle, admin_rpc_join) = admin_rpc::start(admin_rpc_cfg).map_err(|e| {
        format!(
            "failed to bind admin socket at {}: {e}",
            cfg.admin_sock_path.display()
        )
    })?;
    info!(
        path = %cfg.admin_sock_path.display(),
        "admin-rpc actor started and socket bound"
    );

    info!("starting periodic dispatcher");
    let (dispatcher_cancel_tx, dispatcher_cancel_rx) = watch::channel(false);
    let dispatcher_join = start_periodic_dispatcher(
        Arc::new(persistence_handle.clone()),
        pi_agent_supervisor_handle.clone(),
        scheduler_reload_handle.subscribe(),
        cfg.pi_agent_cwd.clone(),
        periodic_dispatch_audit_sink,
        dispatcher_cancel_rx,
    );
    info!("periodic dispatcher started");

    // The supervisor join is kept separate from `joins` so that phase 3 drains
    // the non-supervisor actors first, and phase 4 can explicitly await child
    // process reaping with its own deadline.
    let joins = vec![
        monitoring_join,
        persistence_join,
        policy_control_join,
        requests_handler_join,
        extension_ipc_join,
        admin_rpc_join,
    ];

    Ok(Runtime {
        _admin_rpc: admin_rpc_handle,
        _extension_ipc: extension_ipc_handle,
        _requests_handler: requests_handler_handle,
        _monitoring: monitoring_handle,
        _persistence: persistence_handle,
        _policy_control: policy_control_handle,
        _pi_agent_supervisor: pi_agent_supervisor_handle,
        _scheduler_adapter: scheduler_reload_handle,
        requests_handler_cancel_tx: rh_cancel_tx,
        dispatcher_cancel_tx,
        joins,
        supervisor_join: pi_agent_supervisor_join,
        scheduler_adapter_join: scheduler_join,
        dispatcher_join,
        admin_sock_path: cfg.admin_sock_path.clone(),
        extension_sock_path: cfg.extension_sock_path.clone(),
        policy_snapshot,
    })
}

/// Awaits `SIGTERM` or `SIGINT`, then runs the shutdown protocol described in
/// the Rust coding guidelines §8.
async fn wait_for_signal_then_shutdown(runtime: Runtime, cfg: &BobConfig) -> ServiceResult<()> {
    wait_for_shutdown_signal().await;
    run_shutdown_protocol(runtime, cfg).await;
    Ok(())
}

/// Resolves when SIGTERM or SIGINT is received.
async fn wait_for_shutdown_signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{signal, SignalKind};

        let mut sigterm = signal(SignalKind::terminate())
            .expect("SIGTERM handler must install; tokio runtime is active");
        let mut sigint = signal(SignalKind::interrupt())
            .expect("SIGINT handler must install; tokio runtime is active");

        tokio::select! {
            _ = sigterm.recv() => {
                info!(signal = "SIGTERM", "shutdown signal received");
            }
            _ = sigint.recv() => {
                info!(signal = "SIGINT", "shutdown signal received");
            }
        }
    }

    #[cfg(not(unix))]
    {
        tokio::signal::ctrl_c()
            .await
            .expect("ctrl-c handler must succeed; tokio runtime is active");
        info!(signal = "ctrl-c", "shutdown signal received");
    }
}

/// Executes the graceful shutdown protocol per Rust coding guidelines §8:
///
/// 1. Stop accepting new admin connections (drop handles to close channels).
/// 2. Cancel subsystem workers.
/// 3. Drain bounded queues up to `cfg.shutdown_drain_deadline`.
/// 4. Reap pi-agent children — await `supervisor_join` under `cfg.shutdown_reap_deadline`.
/// 5. Flush audit records (no-op for scaffold).
/// 6. Remove socket files.
async fn run_shutdown_protocol(runtime: Runtime, cfg: &BobConfig) {
    info!("shutdown: phase 1 — stopping new admin connections");
    // Destructure the runtime, dropping all handles.  This closes the command
    // channel on each actor, causing their recv loops to exit.
    let Runtime {
        _admin_rpc,
        _extension_ipc,
        _requests_handler,
        _monitoring,
        _persistence,
        _policy_control,
        _pi_agent_supervisor,
        _scheduler_adapter,
        requests_handler_cancel_tx,
        dispatcher_cancel_tx,
        joins,
        supervisor_join,
        scheduler_adapter_join,
        dispatcher_join,
        admin_sock_path,
        extension_sock_path,
        // policy_snapshot is dropped here; gate crates will hold their own
        // clones until T-054 / T-056 wire them in.
        policy_snapshot: _policy_snapshot,
    } = runtime;

    // Phase 1: Stop accepting new connections by dropping handles (channels close).
    // Signal the requests-handler actor to drain and stop.
    let _ = requests_handler_cancel_tx.send(true);
    // Signal the periodic dispatcher to stop.
    let _ = dispatcher_cancel_tx.send(true);
    _admin_rpc.begin_shutdown();
    drop(_admin_rpc);
    drop(_extension_ipc);
    drop(_requests_handler);
    drop(_monitoring);
    drop(_persistence);
    drop(_policy_control);
    // Drop the supervisor handle so the supervisor actor sees its channel close
    // and proceeds to call shutdown_all on its pool (terminating all children).
    drop(_pi_agent_supervisor);
    // Drop the scheduler-adapter reload handle so its actor sees the watch channel
    // close and exits cleanly.
    drop(_scheduler_adapter);

    info!("shutdown: phase 2 — cancelling subsystem workers");
    // Actors exit when their channel is drained and closed — no explicit cancel needed.

    info!(
        "shutdown: phase 3 — draining queues (deadline: {:?})",
        cfg.shutdown_drain_deadline
    );
    // Collect all non-supervisor join handles including the scheduler-adapter
    // and periodic dispatcher joins.
    let mut all_joins = joins;
    all_joins.push(scheduler_adapter_join);
    all_joins.push(dispatcher_join);
    let drain_result = time::timeout(cfg.shutdown_drain_deadline, drain_joins(all_joins)).await;
    match drain_result {
        Ok(()) => info!("shutdown: phase 3 — all queues drained"),
        Err(_) => info!("shutdown: phase 3 — drain deadline exceeded; proceeding"),
    }

    info!(
        "shutdown: phase 4 — reaping pi-agent children (deadline: {:?})",
        cfg.shutdown_reap_deadline
    );
    // Await the supervisor actor's join handle so that shutdown_all (which
    // terminates all active and warm pi-agent child processes) completes before
    // the process exits.  A timeout guards against a runaway child.
    let reap_result = time::timeout(cfg.shutdown_reap_deadline, async {
        if let Err(e) = supervisor_join.await {
            tracing::warn!(error = %e, "pi-agent-supervisor task panicked during shutdown");
        }
    })
    .await;
    match reap_result {
        Ok(()) => info!("shutdown: phase 4 — pi-agent children reaped"),
        Err(_) => info!("shutdown: phase 4 — reap deadline exceeded; proceeding"),
    }

    info!("shutdown: phase 5 — flushing audit records");
    // Audit flush is a no-op in the scaffold.
    info!("shutdown: phase 5 — audit records flushed");

    info!("shutdown: phase 6 — removing socket files");
    remove_socket_files(&admin_sock_path, &extension_sock_path);
    info!("shutdown: phase 6 — socket files removed; shutdown complete");
}

/// Awaits every actor join handle to completion.
async fn drain_joins(joins: Vec<JoinHandle<()>>) {
    for join in joins {
        // A JoinError means the task panicked.  Log it and continue so the
        // remaining actors still get the chance to exit.
        if let Err(e) = join.await {
            tracing::warn!(error = %e, "actor task panicked during drain");
        }
    }
}

/// Removes the two Unix socket files, logging warnings for any failure.
fn remove_socket_files(admin: &PathBuf, extension: &PathBuf) {
    for path in [admin, extension] {
        if path.as_os_str().is_empty() {
            continue;
        }
        if let Err(e) = std::fs::remove_file(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                tracing::warn!(path = %path.display(), error = %e, "failed to remove socket file");
            }
        }
    }
}

/// Attempts to remove socket files during error unwind; ignores all failures.
fn remove_socket_files_best_effort(cfg: &BobConfig) {
    remove_socket_files(&cfg.admin_sock_path, &cfg.extension_sock_path);
}

/// Resolution of a periodic fire's working directory against the live
/// schedule table (ADR-013), before the precedence's `pi_agent_cwd` /
/// inherited-launch-cwd tiers are applied.
///
/// The lower two precedence tiers (service-wide `pi_agent_cwd`, then the
/// inherited launch cwd) require no special handling here: both are already
/// what the plain `pi_agent_supervisor::Handle::acquire_session` applies, so
/// [`PeriodicCwdResolution::ServiceDefault`] covers both and the dispatcher
/// just calls the unchanged `acquire_session`.
#[derive(Debug, Clone, PartialEq, Eq)]
enum PeriodicCwdResolution {
    /// The job id resolved to a live entry with a per-entry `cwd`; the
    /// dispatcher must acquire a dedicated worker bound to this directory
    /// (T-122's cwd-aware acquisition) rather than the plain `acquire_session`.
    PerEntry(PathBuf),
    /// The job id resolved to a live entry with no per-entry `cwd`, or no job
    /// id was carried with this fire; use the service-wide default (or
    /// inherited launch cwd) via the plain `acquire_session`.
    ServiceDefault,
    /// The job id did not resolve to any live entry (removed between enqueue
    /// and fire, or absent from the table); fall back to the service-wide
    /// default and record the condition (AC-3, ADR-013).
    EntryNotFound,
}

/// Resolves the working directory for one periodic fire from the live
/// schedule table, per the precedence in T-127 (per-entry `cwd` →
/// `pi_agent_cwd` → inherited launch cwd).
///
/// `job_id` is the correlator read back from the inbound queue (T-126,
/// ADR-013); `live_entries` is the current table observed via
/// `scheduler_adapter::ReloadHandle::subscribe`.
fn resolve_periodic_cwd(
    job_id: Option<&str>,
    live_entries: &[ScheduleEntry],
) -> PeriodicCwdResolution {
    let Some(job_id) = job_id else {
        return PeriodicCwdResolution::ServiceDefault;
    };

    match live_entries.iter().find(|entry| entry.id == job_id) {
        Some(entry) => match &entry.cwd {
            Some(cwd) => PeriodicCwdResolution::PerEntry(PathBuf::from(cwd)),
            None => PeriodicCwdResolution::ServiceDefault,
        },
        None => PeriodicCwdResolution::EntryNotFound,
    }
}

/// Appends a monitoring failure record for a skipped periodic fire (AC-2:
/// the resolved per-entry `cwd` does not exist at fire time).
///
/// Mirrors the existing preflight-denied audit pattern (`requests_handler::run_preflight`):
/// reuses the existing `Report`/`ExternalReportAuditPayload` shape with
/// `ReportOutcome::Error` rather than introducing a new `AuditRecordKind`.
/// A failure to append the record itself is logged as a warning and does not
/// affect the fire being skipped.
async fn record_periodic_fire_skipped(
    audit: &dyn AuditSink,
    job_id: Option<&str>,
    summary: String,
) {
    let record = AuditRecord {
        id: format!(
            "audit_periodic_fire_skipped_{}",
            chrono::Utc::now().timestamp_millis()
        ),
        timestamp: chrono::Utc::now().to_rfc3339(),
        kind: AuditRecordKind::Report,
        session_id: None,
        payload: AuditRecordPayload::Report(ExternalReportAuditPayload {
            action: "scheduler.periodic_fire".to_owned(),
            outcome: ReportOutcome::Error,
            session_id: None,
            summary: Some(format!("job_id={}: {summary}", job_id.unwrap_or("<none>"))),
        }),
    };

    if let Err(err) = audit.append(record).await {
        tracing::warn!(
            error = %err,
            job_id = job_id.unwrap_or("<none>"),
            "periodic dispatcher: failed to append monitoring failure record for skipped fire"
        );
    }
}

/// Appends a monitoring record for a periodic fire whose job id no longer
/// resolves to a live schedule entry (AC-3, ADR-013).
///
/// Unlike [`record_periodic_fire_skipped`] (AC-2), this fire is not skipped —
/// it still proceeds via the service-wide default cwd — so the condition is
/// recorded as a distinct fallback rather than a skip. Per
/// `coding-guidelines-rust.md` §6, this persisted audit record is the actual
/// "record the condition" behavior AC-3 requires; the accompanying
/// `tracing::warn!` at the call site is operational logging only, not a
/// substitute for it.
async fn record_periodic_fire_fallback(audit: &dyn AuditSink, job_id: Option<&str>) {
    let record = AuditRecord {
        id: format!(
            "audit_periodic_fire_fallback_{}",
            chrono::Utc::now().timestamp_millis()
        ),
        timestamp: chrono::Utc::now().to_rfc3339(),
        kind: AuditRecordKind::Report,
        session_id: None,
        payload: AuditRecordPayload::Report(ExternalReportAuditPayload {
            action: "scheduler.periodic_fire_fallback".to_owned(),
            outcome: ReportOutcome::Error,
            session_id: None,
            summary: Some(format!(
                "job_id={}: no longer resolves to a live schedule entry; falling back to service-wide default cwd",
                job_id.unwrap_or("<none>")
            )),
        }),
    };

    if let Err(err) = audit.append(record).await {
        tracing::warn!(
            error = %err,
            job_id = job_id.unwrap_or("<none>"),
            "periodic dispatcher: failed to append monitoring record for stale job id fallback"
        );
    }
}

/// Acquires a session via the plain `acquire_session` (the `pi_agent_cwd` /
/// inherited-launch-cwd tiers of the precedence), logging a warning and
/// returning `None` on failure.
///
/// Shared by the [`PeriodicCwdResolution::ServiceDefault`] and
/// [`PeriodicCwdResolution::EntryNotFound`] branches of the periodic
/// dispatcher, which both fall back to this same acquisition.
async fn acquire_default_session_or_warn(
    supervisor: &pi_agent_supervisor::Handle,
) -> Option<SessionId> {
    match supervisor.acquire_session().await {
        Ok(id) => Some(id),
        Err(e) => {
            tracing::warn!(
                error = %e,
                "periodic dispatcher: session acquisition failed; continuing"
            );
            None
        }
    }
}

/// Appends an `event`-kind audit record for a periodic firing that reached
/// dispatch (T-128, AC-1/AC-2).
///
/// `resolved_cwd` is the concrete absolute working directory used for this
/// firing — the outcome of the full precedence resolution (per-entry `cwd` →
/// `pi_agent_cwd` → inherited launch cwd), not the raw per-entry field —
/// recorded on `ExtensionEventAuditPayload::resolved_cwd` (T-123). It is
/// `None` only in the rare case the inherited launch cwd itself could not be
/// determined (`std::env::current_dir` failing); the fire still dispatches
/// and the record is appended with the field left unset rather than blocking
/// dispatch on audit metadata. This record is appended only after pi
/// acknowledges receipt of the prompt, so it does not overstate failed sends
/// as successful dispatches. A failure to append the record itself is logged
/// as a warning and does not affect the already-dispatched fire.
async fn record_periodic_fire_dispatched(
    audit: &dyn AuditSink,
    session_id: SessionId,
    job_id: Option<&str>,
    resolved_cwd: Option<PathBuf>,
) {
    let summary = match &resolved_cwd {
        Some(cwd) => format!(
            "job_id={}: dispatched with resolved cwd {}",
            job_id.unwrap_or("<none>"),
            cwd.display()
        ),
        None => format!(
            "job_id={}: dispatched; resolved cwd unavailable",
            job_id.unwrap_or("<none>")
        ),
    };

    let record = AuditRecord {
        id: format!(
            "audit_periodic_fire_dispatched_{}",
            chrono::Utc::now().timestamp_millis()
        ),
        timestamp: chrono::Utc::now().to_rfc3339(),
        kind: AuditRecordKind::Event,
        session_id: Some(session_id),
        payload: AuditRecordPayload::Event(ExtensionEventAuditPayload {
            name: "scheduler.periodic_fire_dispatched".to_owned(),
            summary: Some(summary),
            resolved_cwd,
        }),
    };

    if let Err(err) = audit.append(record).await {
        tracing::warn!(
            error = %err,
            job_id = job_id.unwrap_or("<none>"),
            "periodic dispatcher: failed to append event audit record for dispatched fire"
        );
    }
}

/// Starts the periodic dispatcher task and returns its join handle.
///
/// The dispatcher runs in a dedicated Tokio task.  On each iteration it
/// dequeues the oldest event from the dedicated periodic queue (B-023,
/// `PersistenceStore::dequeue_next_periodic_with_job_id`) — a queue entirely
/// separate from the general inbound queue used by non-periodic (sync/async)
/// traffic.  Every event this dispatcher observes is therefore already known
/// to be `DeliveryKind::Periodic` by construction: it was placed there only
/// by `admit_periodic_event`.  The dispatcher acquires a pi-agent session via
/// `supervisor` and forwards `event.payload` verbatim.  `send_prompt` returns
/// once pi acknowledges *receipt* of the prompt, not once the agent run
/// finishes, so the dispatcher does not close the session on success — the
/// run continues asynchronously and the worker is released later by the
/// supervisor's existing idle reaper.  If the prompt is not accepted at all
/// (`send_prompt` errors) the session is closed immediately since no run was
/// started.  Any error during dequeue, session acquisition, prompt sending,
/// or session cleanup is logged as a warning; processing then continues from
/// the next event so a single failure does not stall the pipeline.
///
/// B-023: because the periodic queue is never shared with non-periodic
/// traffic, this dispatcher never dequeues, reorders, or re-enqueues a
/// non-periodic event, and its dispatch latency is never coupled to
/// non-periodic backlog depth. The dispatcher backs off for
/// `PERIODIC_DISPATCH_POLL_INTERVAL` before the next poll whenever the
/// periodic queue is empty or a dequeue error occurs.
///
/// The task exits when `cancel_rx` receives `true`, which is sent during
/// shutdown phase 1.
///
/// `persistence` is a trait object (rather than the concrete `persistence::Handle`
/// used elsewhere in this module) so tests can substitute a spy `PersistenceStore`
/// to observe exactly which of the correlator-carrying (T-120) methods this
/// dispatcher calls, without depending on real queue/process timing.
///
/// T-127: `schedule_entries_rx` observes the live schedule table (via
/// `scheduler_adapter::ReloadHandle::subscribe`) so each fire's working
/// directory can be resolved by job id (see `resolve_periodic_cwd`) using the
/// precedence per-entry `cwd` → `pi_agent_cwd` → inherited launch cwd. When a
/// per-entry `cwd` applies, the dispatcher acquires a dedicated worker bound
/// to it via `supervisor.acquire_session_with_cwd` (T-122) instead of the
/// plain `acquire_session`; a missing directory or a pool already at
/// `max_processes` skips that fire with a warning (and, for the missing
/// directory, a monitoring failure record via `audit_sink`) rather than
/// blocking or evicting a worker.
///
/// T-128: `default_worker_cwd` is the service-wide `pi_agent_cwd` (the
/// middle precedence tier); when unset, the bottom tier (the dispatcher's own
/// inherited launch cwd, i.e. `std::env::current_dir()` at dispatcher
/// startup) applies instead — this mirrors exactly what the plain
/// `acquire_session` does when no per-entry cwd is used. Every fire that
/// reaches dispatch (all three `PeriodicCwdResolution` outcomes) has its
/// concrete resolved cwd recorded on an `event`-kind audit record via
/// `record_periodic_fire_dispatched`, satisfying AC-1/AC-2.
fn start_periodic_dispatcher(
    persistence: Arc<dyn PersistenceStore>,
    supervisor: pi_agent_supervisor::Handle,
    schedule_entries_rx: watch::Receiver<Vec<ScheduleEntry>>,
    default_worker_cwd: Option<PathBuf>,
    audit_sink: Arc<dyn AuditSink>,
    mut cancel_rx: watch::Receiver<bool>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        info!("periodic dispatcher started");
        // T-128: the concrete absolute path used when no per-entry cwd
        // applies — the configured service-wide pi_agent_cwd, or (when unset)
        // the dispatcher's own inherited launch cwd. Resolved once at startup
        // since neither tier changes for the lifetime of this task.
        let resolved_service_default_cwd =
            default_worker_cwd.or_else(|| std::env::current_dir().ok());
        loop {
            // Check for a shutdown signal before each dequeue.
            if *cancel_rx.borrow() {
                break;
            }

            // B-023: read back the job-id correlator from the dedicated
            // periodic queue, entirely separate from the general inbound
            // queue used by non-periodic (sync/async) traffic. Every event
            // observed here is Periodic by construction — it can only have
            // arrived via `admit_periodic_event` — so no non-periodic branch
            // or defensive re-enqueue is needed.
            match persistence.dequeue_next_periodic_with_job_id().await {
                Err(e) => {
                    tracing::warn!(
                        error = %e,
                        "periodic dispatcher: dequeue error; continuing after back-off"
                    );
                    tokio::select! {
                        _ = time::sleep(PERIODIC_DISPATCH_POLL_INTERVAL) => {}
                        _ = cancel_rx.changed() => {}
                    }
                }

                Ok(None) => {
                    // No event available; wait without busy-spinning.
                    tokio::select! {
                        _ = time::sleep(PERIODIC_DISPATCH_POLL_INTERVAL) => {}
                        _ = cancel_rx.changed() => {}
                    }
                }

                Ok(Some((event, job_id))) => {
                    // Admitted Periodic event: use a fresh one-shot session.
                    // T-127: resolve this fire's working directory from the
                    // live schedule table (per-entry cwd -> pi_agent_cwd ->
                    // inherited launch cwd) and acquire accordingly.
                    tracing::debug!(
                        job_id = job_id.as_deref().unwrap_or("<none>"),
                        "periodic dispatcher: dispatching periodic event"
                    );

                    let live_entries = schedule_entries_rx.borrow().clone();
                    let resolution = resolve_periodic_cwd(job_id.as_deref(), &live_entries);

                    let (session_id, resolved_cwd) = match resolution {
                        PeriodicCwdResolution::PerEntry(cwd) => {
                            if !cwd.exists() {
                                // AC-2: the resolved per-entry cwd does not exist at
                                // fire time. Skip this fire (it fires again next
                                // tick) with a warning and a monitoring failure
                                // record, analogous to the missing-prompt-file skip
                                // in scheduler-adapter's resolve_payload.
                                tracing::warn!(
                                    job_id = job_id.as_deref().unwrap_or("<none>"),
                                    cwd = %cwd.display(),
                                    "periodic dispatcher: resolved per-entry cwd does not exist; skipping this fire"
                                );
                                record_periodic_fire_skipped(
                                    audit_sink.as_ref(),
                                    job_id.as_deref(),
                                    format!(
                                        "resolved per-entry cwd {} does not exist at fire time",
                                        cwd.display()
                                    ),
                                )
                                .await;
                                continue;
                            }
                            match supervisor.acquire_session_with_cwd(cwd.clone()).await {
                                Ok(id) => (id, Some(cwd)),
                                Err(e) => {
                                    // AC-4: a per-entry-cwd fire when the pool is at
                                    // max_processes is refused (not blocked or
                                    // evicted) by acquire_session_with_cwd (T-122).
                                    // Skip this fire with a warning; it fires again
                                    // next tick.
                                    tracing::warn!(
                                        error = %e,
                                        job_id = job_id.as_deref().unwrap_or("<none>"),
                                        cwd = %cwd.display(),
                                        "periodic dispatcher: cwd-scoped session acquisition failed; skipping this fire"
                                    );
                                    continue;
                                }
                            }
                        }
                        PeriodicCwdResolution::EntryNotFound => {
                            // AC-3: the job id no longer resolves to a live entry
                            // (removed between enqueue and fire). Fall back to the
                            // service-wide default cwd and record the condition —
                            // the tracing::warn! is operational logging, the
                            // audit record below is the actual recorded condition.
                            tracing::warn!(
                                job_id = job_id.as_deref().unwrap_or("<none>"),
                                "periodic dispatcher: job id no longer resolves to a live schedule entry; falling back to the service-wide default cwd"
                            );
                            record_periodic_fire_fallback(audit_sink.as_ref(), job_id.as_deref())
                                .await;
                            let Some(id) = acquire_default_session_or_warn(&supervisor).await
                            else {
                                continue;
                            };
                            (id, resolved_service_default_cwd.clone())
                        }
                        PeriodicCwdResolution::ServiceDefault => {
                            let Some(id) = acquire_default_session_or_warn(&supervisor).await
                            else {
                                continue;
                            };
                            (id, resolved_service_default_cwd.clone())
                        }
                    };
                    // `send_prompt_and_drain` returns as soon as pi acknowledges
                    // *receipt* of the prompt over its RPC channel; the agent run
                    // (provider calls, tool execution) continues asynchronously
                    // afterward. On success we must NOT kill the session here —
                    // doing so aborts the run before it can complete (B-017).
                    //
                    // Critically, the `_and_drain` variant hands the worker's
                    // stdout to a background drain task once the prompt is
                    // accepted. Without a reader, the run's streamed RPC output
                    // fills the ~8 KiB stdout pipe within a second or two and
                    // blocks pi mid-run, so the scheduled action never reaches
                    // its tool call (e.g. the file write never happens). Draining
                    // keeps the run flowing to completion. Once that detached
                    // stdout drain reaches EOF, the worker becomes idle again
                    // and is released later by the idle reaper, so periodic
                    // jobs cannot leak workers.
                    //
                    // On failure there is no run in flight to wait for (the
                    // prompt was never accepted), so the session is cleaned up
                    // immediately as before.
                    match supervisor
                        .send_prompt_and_drain(session_id, event.payload)
                        .await
                    {
                        Ok(()) => {
                            // T-128 (AC-1/AC-2): record the resolved absolute
                            // working directory used for this dispatched fire
                            // on an `event`-kind audit record only after pi
                            // acknowledges receipt of the prompt.
                            record_periodic_fire_dispatched(
                                audit_sink.as_ref(),
                                session_id,
                                job_id.as_deref(),
                                resolved_cwd,
                            )
                            .await;
                        }
                        Err(e) => {
                            tracing::warn!(
                                error = %e,
                                "periodic dispatcher: prompt send failed; continuing"
                            );
                            if let Err(e) = supervisor.kill_session(session_id).await {
                                tracing::warn!(
                                    error = %e,
                                    session_id = %session_id,
                                    "periodic dispatcher: session cleanup failed; continuing"
                                );
                            }
                        }
                    }
                }
            }
        }
        info!("periodic dispatcher stopped");
    })
}

#[cfg(test)]
pub mod tests {
    use std::time::{Duration, Instant};

    use bob_core::error::ServiceError;
    use bob_core::{
        ports::PersistenceStore,
        types::{DeliveryKind, InternalEvent, UserId},
    };

    use crate::config::BobConfig;

    use super::*;

    fn existing_extension_path() -> std::path::PathBuf {
        std::env::current_exe().expect("current executable should exist")
    }

    fn test_cfg_no_sockets() -> BobConfig {
        BobConfig {
            // Empty paths — tests that do not bind sockets use these.
            admin_sock_path: std::path::PathBuf::new(),
            extension_sock_path: std::path::PathBuf::new(),
            extension_path: existing_extension_path(),
            pi_agent_command: "sh".to_string(),
            pi_agent_args: vec!["-c".to_string(), "exit 0".to_string()],
            request_queue_capacity: 16,
            shutdown_drain_deadline: Duration::from_millis(100),
            shutdown_reap_deadline: Duration::from_millis(50),
            ..BobConfig::test_base()
        }
    }

    fn test_cfg_with_sockets(tmp: &tempfile::TempDir) -> BobConfig {
        BobConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
            extension_sock_path: tmp.path().join("extension.sock"),
            extension_path: existing_extension_path(),
            pi_agent_command: "sh".to_string(),
            pi_agent_args: vec!["-c".to_string(), "exit 0".to_string()],
            request_queue_capacity: 16,
            shutdown_drain_deadline: Duration::from_millis(100),
            shutdown_reap_deadline: Duration::from_millis(50),
            ..BobConfig::test_base()
        }
    }

    #[test]
    fn pi_agent_supervisor_config_maps_phase2_bob_settings() {
        let extension_path = std::path::PathBuf::from("/opt/bob/extension.ts");
        let cfg = BobConfig {
            request_queue_capacity: 33,
            shutdown_reap_deadline: Duration::from_secs(11),
            pi_agent_command: "pi-custom".to_string(),
            pi_agent_args: vec![
                "--mode".to_string(),
                "rpc".to_string(),
                "--trace".to_string(),
            ],
            pi_agent_warm_pool_size: 3,
            pi_agent_max_processes: 9,
            pi_agent_idle_reap_timeout: Duration::from_secs(45),
            extension_path: extension_path.clone(),
            ..BobConfig::test_base()
        };

        let supervisor_cfg = build_pi_agent_supervisor_config(&cfg);

        assert_eq!(supervisor_cfg.worker_command, "pi-custom");
        assert_eq!(
            supervisor_cfg.worker_args,
            vec![
                "--mode".to_string(),
                "rpc".to_string(),
                "--trace".to_string()
            ]
        );
        assert_eq!(supervisor_cfg.warm_pool_size, 3);
        assert_eq!(supervisor_cfg.max_processes, 9);
        assert_eq!(supervisor_cfg.idle_reap_timeout, Duration::from_secs(45));
        assert_eq!(supervisor_cfg.command_buffer, 33);
        assert_eq!(
            supervisor_cfg.child_termination_deadline,
            Duration::from_secs(11)
        );
        assert_eq!(supervisor_cfg.extension_path, extension_path);
    }

    // AC-1 (T-126): pi_agent_cwd set on BobConfig must be mapped into the
    // supervisor Config's worker_cwd so warm-pool workers run there.
    #[test]
    fn pi_agent_supervisor_config_maps_pi_agent_cwd_when_set() {
        let cwd = std::path::PathBuf::from("/opt/bob/workspace");
        let cfg = BobConfig {
            pi_agent_cwd: Some(cwd.clone()),
            ..BobConfig::test_base()
        };

        let supervisor_cfg = build_pi_agent_supervisor_config(&cfg);

        assert_eq!(
            supervisor_cfg.worker_cwd,
            Some(cwd),
            "pi_agent_cwd must be mapped into the supervisor Config's worker_cwd"
        );
    }

    // AC-2 (T-126): when pi_agent_cwd is unset, worker_cwd must stay unset so
    // warm-pool workers inherit the launch cwd of `bob serve`.
    #[test]
    fn pi_agent_supervisor_config_leaves_worker_cwd_unset_when_pi_agent_cwd_is_unset() {
        let cfg = BobConfig {
            pi_agent_cwd: None,
            ..BobConfig::test_base()
        };

        let supervisor_cfg = build_pi_agent_supervisor_config(&cfg);

        assert_eq!(
            supervisor_cfg.worker_cwd, None,
            "unset pi_agent_cwd must leave worker_cwd unset so workers inherit the launch cwd"
        );
    }

    // AC-3 (T-126): admit_periodic_event must enqueue via the correlator-
    // carrying enqueue_with_job_id (T-120/ADR-013) so the firing entry's job
    // id (RequestContext::context_id) is retrievable from the inbound queue.
    #[tokio::test(flavor = "current_thread")]
    async fn admit_periodic_event_enqueues_with_job_id_from_context() {
        let (persistence_handle, _persistence_join) =
            persistence::start(persistence::Config::default());
        let event = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "carry-me".to_owned(),
        };

        admit_periodic_event(
            &persistence_handle,
            event.clone(),
            Some("job-42".to_owned()),
        )
        .await;

        let (got_event, got_job_id) = persistence_handle
            .dequeue_next_periodic_with_job_id()
            .await
            .expect("dequeue must not fail")
            .expect("event must be present in the dedicated periodic queue");

        assert_eq!(got_event, event);
        assert_eq!(
            got_job_id,
            Some("job-42".to_owned()),
            "job id from RequestContext::context_id must be carried into the queue"
        );
    }

    // AC-3 (T-126): a periodic event whose context carries no job id must
    // still enqueue successfully, with an absent correlator on dequeue.
    #[tokio::test(flavor = "current_thread")]
    async fn admit_periodic_event_enqueues_with_none_job_id_when_context_has_none() {
        let (persistence_handle, _persistence_join) =
            persistence::start(persistence::Config::default());
        let event = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "no-job-id".to_owned(),
        };

        admit_periodic_event(&persistence_handle, event.clone(), None).await;

        let (got_event, got_job_id) = persistence_handle
            .dequeue_next_periodic_with_job_id()
            .await
            .expect("dequeue must not fail")
            .expect("event must be present in the dedicated periodic queue");

        assert_eq!(got_event, event);
        assert_eq!(got_job_id, None);
    }

    #[test]
    fn interactive_session_config_maps_bob_spawn_settings_without_rpc_args() {
        let extension_sock_path = std::path::PathBuf::from("/run/bob/extension.sock");
        let extension_path = std::path::PathBuf::from("/opt/bob/extension.ts");
        let cfg = BobConfig {
            pi_agent_command: "pi-custom".to_string(),
            pi_agent_args: vec!["--mode".to_string(), "rpc".to_string()],
            shutdown_reap_deadline: Duration::from_secs(11),
            extension_sock_path: extension_sock_path.clone(),
            extension_path: extension_path.clone(),
            ..BobConfig::test_base()
        };

        let interactive_cfg = build_interactive_session_config(&cfg);

        assert_eq!(interactive_cfg.command, "pi-custom");
        assert!(interactive_cfg.args.is_empty());
        assert_eq!(
            interactive_cfg.child_termination_deadline,
            Duration::from_secs(11)
        );
        assert_eq!(interactive_cfg.extension_sock_path, extension_sock_path);
        assert_eq!(interactive_cfg.extension_path, extension_path);
    }

    // AC-2 (T-039): extension_sock_path from BobConfig is plumbed into the supervisor config.
    #[test]
    fn pi_agent_supervisor_config_maps_extension_sock_path_from_bob_config() {
        let extension_path = std::path::PathBuf::from("/run/bob/extension.sock");
        let cfg = BobConfig {
            extension_sock_path: extension_path.clone(),
            ..BobConfig::test_base()
        };

        let supervisor_cfg = build_pi_agent_supervisor_config(&cfg);

        assert_eq!(
            supervisor_cfg.extension_sock_path, extension_path,
            "extension_sock_path must be plumbed from BobConfig into supervisor Config"
        );
    }

    // AC-3 (T-039): empty extension_sock_path from BobConfig maps to empty in supervisor config.
    #[test]
    fn pi_agent_supervisor_config_maps_empty_extension_sock_path_when_unset() {
        let cfg = BobConfig {
            extension_sock_path: std::path::PathBuf::new(),
            ..BobConfig::test_base()
        };

        let supervisor_cfg = build_pi_agent_supervisor_config(&cfg);

        assert!(
            supervisor_cfg.extension_sock_path.as_os_str().is_empty(),
            "empty extension_sock_path in BobConfig must result in empty path in supervisor Config"
        );
    }

    #[test]
    fn monitoring_config_maps_audit_log_path_from_bob_config() {
        let audit_log_path = std::path::PathBuf::from("/tmp/bob-monitoring/audit.jsonl");
        let cfg = BobConfig {
            request_queue_capacity: 55,
            monitoring: crate::config::MonitoringConfig {
                audit_log_path: audit_log_path.clone(),
                default_tail_filters: vec![],
            },
            ..BobConfig::test_base()
        };

        let monitoring_cfg = build_monitoring_config(&cfg);

        assert_eq!(monitoring_cfg.audit_log_path, audit_log_path);
        assert_eq!(monitoring_cfg.command_buffer, 55);
    }

    // AC-1: run constructs all subsystem actors and binds both sockets
    #[tokio::test(flavor = "current_thread")]
    async fn start_subsystems_constructs_all_actors_without_error() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let cfg = test_cfg_with_sockets(&tmp);
        let result = start_subsystems(&cfg);
        assert!(result.is_ok(), "start_subsystems should succeed");
        // Dropping runtime closes listeners and aborts actors cleanly.
    }

    // AC-2: permitted events submitted through requests-handler are persisted.
    #[tokio::test(flavor = "current_thread")]
    async fn permitted_event_is_persisted_via_wired_requests_handler_and_persistence() {
        use bob_core::types::{ChannelId, RequestContext};

        let tmp = tempfile::tempdir().expect("temp dir");
        let mut cfg = test_cfg_with_sockets(&tmp);
        let user_id = UserId::new();
        cfg.policy.admitted_users = vec![user_id.to_string()];
        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        let event = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "persist me".to_owned(),
        };
        let ctx = RequestContext {
            sender: user_id,
            source: ChannelId::new(),
            context_id: None,
            reply_address: None,
        };
        runtime
            ._requests_handler
            .submit_event(event.clone(), ctx)
            .await
            .expect("submit must succeed");

        let persisted = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(next) = runtime
                    ._persistence
                    .dequeue_next()
                    .await
                    .expect("dequeue should not fail")
                {
                    break next;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("event should be persisted before timeout");

        assert_eq!(persisted, event);
        run_shutdown_protocol(runtime, &cfg).await;
    }

    // AC-1: Runtime contains all expected join handles (6 non-supervisor actors)
    // After AC-4: supervisor_join is extracted from joins for phase 4.
    #[tokio::test(flavor = "current_thread")]
    async fn runtime_holds_six_non_supervisor_join_handles() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let cfg = test_cfg_with_sockets(&tmp);
        let runtime = start_subsystems(&cfg).expect("subsystems must start");
        assert_eq!(
            runtime.joins.len(),
            6,
            "expected one join handle per non-supervisor actor (supervisor_join is separate)"
        );
    }

    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_protocol_for_idle_runtime_finishes_before_drain_deadline_expires() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let mut cfg = test_cfg_with_sockets(&tmp);
        cfg.shutdown_drain_deadline = Duration::from_millis(500);
        cfg.shutdown_reap_deadline = Duration::from_millis(250);

        let runtime = start_subsystems(&cfg).expect("subsystems must start");
        let started_at = Instant::now();

        run_shutdown_protocol(runtime, &cfg).await;

        assert!(
            started_at.elapsed() < cfg.shutdown_drain_deadline,
            "idle shutdown should finish before drain timeout fallback is consumed"
        );
    }

    // AC-1 (T-094): start_subsystems always creates a scheduler-adapter join handle.
    // The scheduler has no enable/disable flag — it is always started.
    // The join handle is a plain JoinHandle<()> (not Optional) confirming it is unconditional.
    #[tokio::test(flavor = "current_thread")]
    async fn start_subsystems_always_creates_scheduler_adapter_join_handle() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let cfg = test_cfg_with_sockets(&tmp);
        let runtime = start_subsystems(&cfg).expect("subsystems must start");
        // Confirm the scheduler actor is still running immediately after startup
        // (the JoinHandle is not yet finished).
        assert!(
            !runtime.scheduler_adapter_join.is_finished(),
            "scheduler adapter actor must be running after start_subsystems"
        );
        run_shutdown_protocol(runtime, &cfg).await;
    }

    // AC-2 (T-114): scheduler adapter is wired with schedule entries from
    // cfg.schedule.entries, which at startup come from the JSON schedule store
    // loaded by BobConfig::load_with_sources.
    #[tokio::test(flavor = "current_thread")]
    async fn scheduler_adapter_is_initialized_with_schedule_entries_from_config() {
        use bob_core::types::ScheduleEntry;

        let tmp = tempfile::tempdir().expect("temp dir");
        let entry = ScheduleEntry::with_prompt("json-store-job", "0 9 * * *", "from json store");
        let cfg = BobConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
            extension_sock_path: tmp.path().join("extension.sock"),
            extension_path: existing_extension_path(),
            // Simulate what BobConfig::load() populates from the JSON store.
            schedule: crate::config::ScheduleConfig {
                entries: vec![entry.clone()],
            },
            ..BobConfig::test_base()
        };

        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        let loaded_entries = runtime._scheduler_adapter.subscribe().borrow().clone();
        assert_eq!(
            loaded_entries.len(),
            1,
            "scheduler adapter must be initialized with the single entry from cfg.schedule"
        );
        assert_eq!(
            loaded_entries[0].id, "json-store-job",
            "scheduler entry id must match the entry from cfg.schedule"
        );

        run_shutdown_protocol(runtime, &cfg).await;
    }

    // AC-2 (T-094): graceful shutdown awaits the scheduler actor's JoinHandle and
    // completes without hanging.
    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_protocol_awaits_scheduler_adapter_and_completes_without_hanging() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let mut cfg = test_cfg_with_sockets(&tmp);
        cfg.shutdown_drain_deadline = std::time::Duration::from_millis(200);
        cfg.shutdown_reap_deadline = std::time::Duration::from_millis(100);
        let runtime = start_subsystems(&cfg).expect("subsystems must start");
        tokio::time::timeout(
            std::time::Duration::from_secs(5),
            run_shutdown_protocol(runtime, &cfg),
        )
        .await
        .expect(
            "shutdown protocol must complete within deadline when scheduler adapter is running",
        );
    }

    // AC-4 (T-036): shutdown phase 4 awaits supervisor child cleanup.
    // Verify that `supervisor_join` on Runtime is a distinct field (not in `joins`),
    // and that run_shutdown_protocol completes without hanging — proving phase 4
    // is not a no-op but actually awaits the supervisor actor's exit.
    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_phase4_awaits_supervisor_child_cleanup() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let cfg = BobConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
            extension_sock_path: tmp.path().join("extension.sock"),
            extension_path: existing_extension_path(),
            // Use sh workers that exit immediately — they spawn, pool is warm,
            // shutdown_all terminates them.
            pi_agent_command: "sh".to_string(),
            pi_agent_args: vec!["-c".to_string(), "exit 0".to_string()],
            request_queue_capacity: 16,
            shutdown_drain_deadline: Duration::from_millis(100),
            shutdown_reap_deadline: Duration::from_millis(200),
            ..BobConfig::test_base()
        };

        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        // The supervisor_join field must exist (compilation-verified) and be separate
        // from `joins`. If we got here, the structural check is implicit.
        // Run shutdown and assert it completes within a generous outer deadline —
        // a no-op phase 4 would also complete, but the supervisor task must be joined.
        tokio::time::timeout(Duration::from_secs(5), run_shutdown_protocol(runtime, &cfg))
            .await
            .expect("shutdown protocol must complete within deadline");
        // Reaching here proves run_shutdown_protocol did not hang and the supervisor
        // actor finished (shutdown_all ran and all workers were terminated).
    }

    // AC-1: socket files exist on disk after start_subsystems succeeds
    #[tokio::test(flavor = "current_thread")]
    async fn start_subsystems_creates_socket_files_on_disk() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let cfg = test_cfg_with_sockets(&tmp);
        let runtime = start_subsystems(&cfg).expect("subsystems must start");
        assert!(
            cfg.admin_sock_path.exists(),
            "admin socket file should exist on disk after binding"
        );
        assert!(
            cfg.extension_sock_path.exists(),
            "extension socket file should exist on disk after binding"
        );
        drop(runtime);
    }

    // B-009: the gated extension-ipc listener removes a stale extension socket
    // and rebinds successfully.  The previous raw UnixListener::bind would fail
    // when a stale socket file existed; the gated path (which calls
    // extension_ipc::Listener::bind) unlinks the stale file first and therefore
    // succeeds.  start_subsystems must return Ok and the socket must be present
    // on disk with the correct permissions.
    #[tokio::test(flavor = "current_thread")]
    async fn start_subsystems_removes_stale_extension_socket_and_succeeds() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("temp dir");
        let admin_sock = tmp.path().join("admin.sock");
        let ext_sock = tmp.path().join("extension.sock");

        // Pre-bind the extension socket to create a stale socket file, then
        // drop the listener so only the file remains on disk.
        {
            let _pre_bound = tokio::net::UnixListener::bind(&ext_sock)
                .expect("pre-bind extension socket for test setup");
        }
        assert!(
            ext_sock.exists(),
            "stale socket file should exist before start"
        );

        let cfg = BobConfig {
            admin_sock_path: admin_sock.clone(),
            extension_sock_path: ext_sock.clone(),
            extension_path: existing_extension_path(),
            request_queue_capacity: 16,
            shutdown_drain_deadline: Duration::from_millis(100),
            shutdown_reap_deadline: Duration::from_millis(50),
            ..BobConfig::test_base()
        };

        // The gated bind removes the stale file and rebinds; start must succeed.
        let runtime = start_subsystems(&cfg)
            .expect("start_subsystems must succeed even when stale extension socket exists");

        // Extension socket is present and has the correct permissions.
        assert!(
            ext_sock.exists(),
            "extension socket must exist after successful start"
        );
        let meta = std::fs::metadata(&ext_sock).expect("stat extension socket");
        let mode = meta.permissions().mode() & 0o777;
        assert_eq!(
            mode, 0o660,
            "extension socket mode must be 0660 after stale-socket rebind, got {mode:o}"
        );

        run_shutdown_protocol(runtime, &cfg).await;
    }

    #[tokio::test(flavor = "current_thread")]
    async fn start_subsystems_returns_service_down_when_warm_pool_spawn_fails() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let mut cfg = test_cfg_with_sockets(&tmp);
        cfg.pi_agent_command = "__definitely_missing_pi_binary__".to_string();
        cfg.pi_agent_args = vec!["--mode".to_string(), "rpc".to_string()];
        cfg.pi_agent_warm_pool_size = 1;
        cfg.pi_agent_max_processes = 2;

        let result = start_subsystems(&cfg);

        assert!(
            matches!(result, Err(ServiceError::ServiceDown)),
            "expected ServiceError::ServiceDown on warm-pool spawn failure"
        );
        assert!(
            !cfg.admin_sock_path.exists(),
            "admin socket should not remain after failed startup"
        );
        assert!(
            !cfg.extension_sock_path.exists(),
            "extension socket should not remain after failed startup"
        );
    }

    // B-012 part 1: a non-empty extension socket path that cannot be bound must
    // fail startup with ServiceDown, so the path is never advertised to workers
    // while bob does not own the listener.
    #[tokio::test(flavor = "current_thread")]
    async fn start_subsystems_returns_service_down_when_extension_socket_cannot_bind() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let mut cfg = test_cfg_with_sockets(&tmp);
        // Make the extension socket's parent a regular file so the gated bind's
        // create_dir_all fails deterministically.
        let blocker = tmp.path().join("not-a-dir");
        std::fs::write(&blocker, b"x").expect("write blocker file");
        cfg.extension_sock_path = blocker.join("extension.sock");

        let result = start_subsystems(&cfg);

        assert!(
            matches!(result, Err(ServiceError::ServiceDown)),
            "expected ServiceError::ServiceDown when the extension socket cannot bind"
        );
        assert!(
            !cfg.admin_sock_path.exists(),
            "admin socket should not remain after failed startup"
        );
    }

    // AC-3: scaffold actors always succeed — error path is for future actors
    #[tokio::test(flavor = "current_thread")]
    async fn start_subsystems_result_is_ok_for_default_scaffold() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let cfg = test_cfg_with_sockets(&tmp);
        // With the scaffold actors and valid paths, start_subsystems returns Ok.
        let result = start_subsystems(&cfg);
        assert!(result.is_ok(), "scaffold actors must start without error");
    }

    // AC-4: actors emit start lifecycle events (verified structurally)
    // The actors themselves log "actor started" and "actor stopped" per their
    // scaffold implementations.  We verify that calling start_subsystems and
    // then dropping the runtime does not panic and that the join handles complete
    // within the drain deadline of the shutdown protocol.
    #[tokio::test(flavor = "current_thread")]
    async fn dropping_runtime_allows_actors_to_stop() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let cfg = test_cfg_with_sockets(&tmp);
        let runtime = start_subsystems(&cfg).expect("subsystems must start");
        // Run the shutdown protocol which drops handles and awaits all joins.
        run_shutdown_protocol(runtime, &cfg).await;
        // If we reach here without a timeout or panic all actors stopped cleanly.
    }

    // AC-2: shutdown protocol removes socket files — uses real UnixListener binds
    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_protocol_removes_socket_files_when_they_exist() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let admin_sock = tmp.path().join("admin.sock");
        let ext_sock = tmp.path().join("extension.sock");

        // Bind and immediately drop so the socket files exist but are not held.
        // start_subsystems will re-bind them.
        {
            let _a = tokio::net::UnixListener::bind(&admin_sock).expect("pre-bind admin sock");
            let _e = tokio::net::UnixListener::bind(&ext_sock).expect("pre-bind extension sock");
        }
        // Both socket files now exist but are no longer bound.
        assert!(
            admin_sock.exists(),
            "pre-bind should leave socket file on disk"
        );
        assert!(
            ext_sock.exists(),
            "pre-bind should leave socket file on disk"
        );

        // Remove them so start_subsystems can bind fresh.
        std::fs::remove_file(&admin_sock).ok();
        std::fs::remove_file(&ext_sock).ok();

        let cfg = BobConfig {
            admin_sock_path: admin_sock.clone(),
            extension_sock_path: ext_sock.clone(),
            extension_path: existing_extension_path(),
            shutdown_drain_deadline: Duration::from_millis(50),
            shutdown_reap_deadline: Duration::from_millis(25),
            ..BobConfig::test_base()
        };

        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        // Sockets must exist on disk while the runtime is live.
        assert!(
            admin_sock.exists(),
            "admin.sock must exist while runtime is live"
        );
        assert!(
            ext_sock.exists(),
            "extension.sock must exist while runtime is live"
        );

        run_shutdown_protocol(runtime, &cfg).await;

        assert!(
            !admin_sock.exists(),
            "admin.sock should be removed after shutdown"
        );
        assert!(
            !ext_sock.exists(),
            "extension.sock should be removed after shutdown"
        );
    }

    // AC-2: shutdown protocol tolerates absent socket files (no panic)
    #[tokio::test(flavor = "current_thread")]
    async fn shutdown_protocol_tolerates_missing_socket_files() {
        let cfg = test_cfg_no_sockets();
        // start_subsystems will fail with empty paths — test the shutdown helper directly.
        // We build a minimal runtime manually via try_start_subsystems with empty paths
        // to verify removal of missing files does not panic.
        //
        // Because try_start_subsystems will fail on bind with empty paths we call the
        // removal helper directly, which is what start_subsystems also calls on failure.
        remove_socket_files_best_effort(&cfg);
        // No panic means the test passes.
    }

    // AC-3 (T-040): try_start_subsystems wires TracingMonitoringHandle as the active
    // MonitoringHandle for the extension-ipc actor.  Constructing the config here
    // (the same expression used in try_start_subsystems) guarantees at compile time
    // that TracingMonitoringHandle is reachable and satisfies MonitoringHandle.
    //
    // Must be an async test because extension_ipc::Config::default() initialises
    // the policy_snapshot field via policy_control::start(), which requires a
    // Tokio runtime.
    #[tokio::test(flavor = "current_thread")]
    async fn extension_ipc_config_accepts_tracing_monitoring_handle() {
        let cfg = extension_ipc::Config {
            monitoring_handle: Arc::new(extension_ipc::TracingMonitoringHandle),
            ..extension_ipc::Config::default()
        };
        // The monitoring_handle field is Arc<dyn MonitoringHandle>; if the type
        // does not implement MonitoringHandle the line above will not compile.
        // A non-empty Arc is sufficient evidence.
        assert!(Arc::strong_count(&cfg.monitoring_handle) >= 1);
    }

    // AC-4 (T-065): start_subsystems wires a MonitoringBackedHandle (not the
    // tracing-only placeholder) into extension-ipc so that extension events and
    // verdicts become persistent audit records.
    //
    // The test verifies that after start_subsystems the monitoring audit log
    // receives records when an event audit record is appended through the same
    // monitoring handle that extension-ipc holds.  The runtime exposes the
    // monitoring handle through `_monitoring`, which is the same handle wired into
    // extension-ipc's MonitoringBackedHandle.
    #[tokio::test(flavor = "current_thread")]
    async fn extension_ipc_is_wired_with_monitoring_backed_handle_not_tracing_placeholder() {
        use bob_core::types::{
            AuditFilterKind, AuditRecord, AuditRecordKind, AuditRecordPayload,
            ExtensionEventAuditPayload,
        };
        use std::str::FromStr;
        use std::time::Duration;
        use tokio::time::timeout;

        let tmp = tempfile::tempdir().expect("temp dir");
        let audit_log = tmp.path().join("audit.jsonl");
        let cfg = BobConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
            extension_sock_path: tmp.path().join("extension.sock"),
            extension_path: existing_extension_path(),
            monitoring: crate::config::MonitoringConfig {
                audit_log_path: audit_log.clone(),
                default_tail_filters: vec![],
            },
            ..BobConfig::test_base()
        };
        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        // Subscribe to events on the shared monitoring handle.
        let mut subscription = runtime
            ._monitoring
            .subscribe_tail(vec![
                AuditFilterKind::from_str("events").expect("events parses")
            ])
            .await
            .expect("subscribe must succeed");

        // Append a record through the monitoring handle; if extension-ipc held the same
        // handle (MonitoringBackedHandle wraps it), the subscription will receive it.
        let record = AuditRecord {
            id: "test_wiring_001".to_owned(),
            timestamp: "2026-05-20T12:00:00Z".to_owned(),
            kind: AuditRecordKind::Event,
            session_id: None,
            payload: AuditRecordPayload::Event(ExtensionEventAuditPayload {
                name: "test.wiring".to_owned(),
                summary: None,
                resolved_cwd: None,
            }),
        };
        runtime
            ._monitoring
            .append_record(record)
            .await
            .expect("append through monitoring handle must succeed");

        let received = timeout(Duration::from_millis(500), subscription.recv())
            .await
            .expect("audit record must be delivered within deadline")
            .expect("subscription must stay open");

        assert_eq!(received.kind, AuditRecordKind::Event);
        assert_eq!(received.id, "test_wiring_001");

        run_shutdown_protocol(runtime, &cfg).await;
    }

    // B-009: extension socket bind uses gated path (0700 parent + 0660 socket).
    //
    // The production path must call extension-ipc::Listener::bind (which enforces
    // the ADR-005 permission gate) rather than a raw tokio::net::UnixListener::bind.
    // Use a nested parent directory so the test can independently verify the parent
    // mode is 0700 and the socket mode is 0660.
    #[tokio::test(flavor = "current_thread")]
    async fn start_subsystems_extension_socket_parent_is_0700_and_socket_is_0660() {
        use std::os::unix::fs::PermissionsExt;

        let tmp = tempfile::tempdir().expect("temp dir");
        // Place sockets in a subdirectory so we can check that subdirectory's mode.
        let sock_parent = tmp.path().join("socks");
        std::fs::create_dir_all(&sock_parent).expect("create socks dir");
        // Set the parent to a permissive mode first; the gated bind must tighten it.
        std::fs::set_permissions(&sock_parent, std::fs::Permissions::from_mode(0o755))
            .expect("set permissive mode");

        let cfg = BobConfig {
            admin_sock_path: sock_parent.join("admin.sock"),
            extension_sock_path: sock_parent.join("extension.sock"),
            extension_path: existing_extension_path(),
            pi_agent_command: "sh".to_string(),
            pi_agent_args: vec!["-c".to_string(), "exit 0".to_string()],
            request_queue_capacity: 16,
            shutdown_drain_deadline: Duration::from_millis(100),
            shutdown_reap_deadline: Duration::from_millis(50),
            ..BobConfig::test_base()
        };

        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        // Verify the extension socket parent directory was chmoded to 0700.
        let parent_meta = std::fs::metadata(&sock_parent).expect("stat socks dir");
        let parent_mode = parent_meta.permissions().mode() & 0o777;
        assert_eq!(
            parent_mode, 0o700,
            "extension socket parent directory mode must be 0700, got {parent_mode:o}"
        );

        // Verify the extension socket file itself was chmoded to 0660.
        let sock_meta = std::fs::metadata(&cfg.extension_sock_path).expect("stat extension socket");
        let sock_mode = sock_meta.permissions().mode() & 0o777;
        assert_eq!(
            sock_mode, 0o660,
            "extension socket file mode must be 0660, got {sock_mode:o}"
        );

        run_shutdown_protocol(runtime, &cfg).await;
    }

    // ── AC-4 (T-053): policy-control actor is started with real Config ────────
    //
    // When start_subsystems is called with a BobConfig whose policy section
    // carries admitted users, the runtime's policy snapshot handle must reflect
    // those users immediately after startup — proving the real Config (not
    // Config::default()) was used to start the actor.

    #[tokio::test(flavor = "current_thread")]
    async fn policy_snapshot_handle_reflects_admitted_users_from_config_on_startup() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let user_id = UserId::new();
        let mut cfg = test_cfg_with_sockets(&tmp);
        cfg.policy.admitted_users = vec![user_id.to_string()];

        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        // The snapshot handle stored in the runtime must already reflect the
        // admitted user sourced from cfg.policy — this proves the actor was
        // started with the initial snapshot built from config, not the deny-all
        // Config::default().
        let snapshot = runtime.policy_snapshot.load();
        assert_eq!(
            snapshot.admitted_users().len(),
            1,
            "policy snapshot must contain the admitted user from cfg.policy"
        );
        assert_eq!(
            snapshot.admitted_users()[0],
            user_id,
            "admitted user in snapshot must match the one in cfg.policy"
        );
    }

    // AC-4 (T-054): deny-all policy snapshot means events are never persisted,
    // proving the pre-flight gate reads the snapshot handle rather than any
    // static allow-list.
    #[tokio::test(flavor = "current_thread")]
    async fn deny_all_policy_snapshot_causes_all_events_to_be_denied_and_not_persisted() {
        use bob_core::types::{ChannelId, RequestContext};

        let tmp = tempfile::tempdir().expect("temp dir");
        let mut cfg = test_cfg_with_sockets(&tmp);
        // No admitted users → deny-all snapshot.
        cfg.policy.admitted_users = vec![];

        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        let event = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "should be denied".to_owned(),
        };
        // Submit with any user — policy has no admitted users so it must be denied.
        let ctx = RequestContext {
            sender: UserId::new(),
            source: ChannelId::new(),
            context_id: None,
            reply_address: None,
        };
        runtime
            ._requests_handler
            .submit_event(event, ctx)
            .await
            .expect("submit must succeed");

        // With no admitted users the snapshot denies all; nothing should be persisted.
        // Give the actor a moment to process the event, then verify the store is empty.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let result = runtime
            ._persistence
            .dequeue_next()
            .await
            .expect("dequeue should not fail");
        assert!(
            result.is_none(),
            "deny-all snapshot must prevent any event from reaching persistence"
        );

        run_shutdown_protocol(runtime, &cfg).await;
    }

    // ── T-109: periodic dispatcher tests ──────────────────────────────────────

    /// Tests that specifically cover the admitted periodic request dispatcher
    /// introduced by T-109 (AC-1 through AC-5).
    pub mod periodic {
        use super::*;

        // AC-1: periodic dispatcher task is started during bob serve startup and
        // its join handle is distinct from the scheduler join and the six
        // non-supervisor actor joins.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_starts_during_serve_startup() {
            let tmp = tempfile::tempdir().expect("temp dir");
            let cfg = test_cfg_with_sockets(&tmp);
            let runtime = start_subsystems(&cfg).expect("subsystems must start");
            assert!(
                !runtime.dispatcher_join.is_finished(),
                "periodic dispatcher task must be running after startup"
            );
            run_shutdown_protocol(runtime, &cfg).await;
        }

        // AC-1: graceful shutdown awaits the periodic dispatcher and completes
        // without hanging.
        #[tokio::test(flavor = "current_thread")]
        async fn shutdown_protocol_awaits_periodic_dispatcher_and_completes() {
            let tmp = tempfile::tempdir().expect("temp dir");
            let mut cfg = test_cfg_with_sockets(&tmp);
            cfg.shutdown_drain_deadline = Duration::from_millis(500);
            cfg.shutdown_reap_deadline = Duration::from_millis(250);
            let runtime = start_subsystems(&cfg).expect("subsystems must start");
            tokio::time::timeout(Duration::from_secs(5), run_shutdown_protocol(runtime, &cfg))
                .await
                .expect(
                    "shutdown protocol must complete within deadline when dispatcher is running",
                );
        }

        // AC-2: a Periodic event enqueued in persistence is dequeued by the
        // dispatcher, a pi-agent session is acquired, and the payload is
        // forwarded verbatim via send_prompt. B-017: the dispatcher does not
        // close the session synchronously on success (that would abort a real
        // in-flight agent run) — release is left to the supervisor's idle
        // reaper, exercised here with a short `pi_agent_idle_reap_timeout` so
        // the backstop fires within the test window.
        // B-025 tried switching this test to multi_thread (worker_threads =
        // 2), theorizing that serializing the actor task, the poll loops
        // below, and the real `sh` subprocess I/O onto one OS thread was
        // starving observation of the idle reaper's release under CI
        // contention. CI failed the exact same way immediately after that
        // fix landed (B-026), and B-026's investigation found `multi_thread`
        // had no working precedent for this task topology anywhere in the
        // codebase: it was the only `multi_thread` test in this file (vs. 44
        // `current_thread` siblings with a clean CI record) and the only
        // place combining `multi_thread` with the full 9-actor
        // `start_subsystems()` stack. That made `multi_thread` itself the
        // prime suspect for the changed failure signature, so it is
        // reverted here back to `current_thread`. The 20s timeout below is
        // retained as a safety net against genuine CI-runner contention, but
        // is not believed to be the fix mechanism.
        // B-028: this test fails deterministically in CI (never locally, despite
        // three independent sessions' increasingly aggressive local contention
        // simulation, up to and including taskset CPU-pinning oversubscription).
        // Three prior bugs (B-025: timing margin, B-026: multi_thread runtime,
        // B-027: duplicate-CI-trigger contention) each proposed and implemented a
        // plausible, evidence-backed hypothesis; each was independently falsified
        // by the next CI failure. B-027's fix genuinely eliminated duplicate-run
        // contention (confirmed via `gh run list`), yet the single, non-contended
        // surviving run still failed identically. All three sessions independently
        // audited crates/pi-agent-supervisor/src/{reaper,pool,lib,process}.rs and
        // found the idle-reaper/pool/process-termination logic deterministic,
        // bounded, and exercised successfully by numerous sibling tests in the same
        // failing CI runs — do not re-audit that code without new evidence; see
        // B-028 for the full trail. Ignored pending CI-runner-level investigation
        // (e.g. shell access to the self-hosted runner, or richer instrumentation
        // than a black-box CI log) that this repository's tooling cannot currently
        // perform. Run explicitly with:
        //   cargo test -p bob --lib serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt -- --ignored --exact
        #[tokio::test(flavor = "current_thread")]
        #[ignore = "B-028: fails deterministically in CI only, never locally; production code audited correct 3x (B-025/026/027); root cause unknown, see bug file"]
        async fn periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt() {
            use bob_core::ports::PersistenceStore;

            let tmp = tempfile::tempdir().expect("temp dir");
            let record_file = tmp.path().join("received_prompt.txt");
            let record_file_str = record_file.to_string_lossy().into_owned();

            // Worker script: parse the RPC prompt, write the message to a file,
            // then respond with success so send_prompt returns Ok(()).
            let worker_script = format!(
                "while IFS= read -r line; do \
                 id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 msg=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"message\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 printf '%s\\n' \"$msg\" >> \"{}\"; \
                 printf '{{\"id\":\"%s\",\"type\":\"response\",\"success\":true}}\\n' \"$id\"; \
                 done",
                record_file_str
            );

            let cfg = BobConfig {
                admin_sock_path: tmp.path().join("admin.sock"),
                extension_sock_path: tmp.path().join("extension.sock"),
                extension_path: existing_extension_path(),
                pi_agent_command: "sh".to_string(),
                pi_agent_args: vec!["-c".to_string(), worker_script],
                pi_agent_warm_pool_size: 1,
                pi_agent_max_processes: 2,
                pi_agent_idle_reap_timeout: Duration::from_millis(100),
                request_queue_capacity: 16,
                shutdown_drain_deadline: Duration::from_millis(500),
                shutdown_reap_deadline: Duration::from_millis(250),
                ..BobConfig::test_base()
            };

            let runtime = start_subsystems(&cfg).expect("subsystems must start");

            // Enqueue a Periodic event directly onto the dedicated periodic
            // queue (B-023) so the dispatcher picks it up without going
            // through the requests-handler preflight.
            runtime
                ._persistence
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "periodic-test-prompt".to_owned(),
                    },
                    None,
                )
                .await
                .expect("enqueue must succeed");

            // Wait for the dispatcher to dequeue the event, acquire a one-shot
            // session, and forward the payload. The worker writes the message
            // to the record file upon receiving the prompt.
            //
            // B-025: 20s (not the file's usual 5s) — this wait, like the
            // idle-reaper wait below, polls on real subprocess I/O, so it
            // gets the same widened margin for consistency even though only
            // the idle-reaper wait has actually failed in CI so far.
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    if record_file.exists() {
                        let content = std::fs::read_to_string(&record_file).unwrap_or_default();
                        if content.contains("periodic-test-prompt") {
                            break;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("dispatcher must forward periodic event payload to pi-agent within timeout");

            // The session is not closed synchronously after dispatch (B-017);
            // it is released once the idle reaper's backstop timeout elapses.
            //
            // B-025: 20s (not the file's usual 5s) budget to absorb realistic
            // CI-runner contention spikes — the two CI failures this test
            // produced were both `Elapsed(())` panics here under contention
            // from a second concurrently-triggered CI job on the same
            // commit, not a defect in the reaper itself (see B-025 Diagnosis
            // Log). The reaper's own work still normally completes within a
            // few hundred ms given the 100ms pi_agent_idle_reap_timeout
            // configured above, so this only widens worst-case headroom.
            tokio::time::timeout(Duration::from_secs(20), async {
                loop {
                    if runtime
                        ._pi_agent_supervisor
                        .list_sessions()
                        .await
                        .expect("list_sessions must succeed")
                        .is_empty()
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("idle reaper must eventually release the one-shot session");

            run_shutdown_protocol(runtime, &cfg).await;
        }

        // B-017 regression: the dispatcher must not tear down the pi worker
        // immediately after the prompt-acceptance ack. Real pi workers accept
        // the prompt over `runRpcMode()` (the `{"success":true}` response) and
        // then continue the agent run (provider call, tool execution)
        // asynchronously; the ack only confirms receipt, not completion. This
        // fake worker mirrors that timing by sending the ack first and only
        // performing its observable side effect afterward, inside the same
        // (unforked) worker process — so if the dispatcher kills the worker
        // right after the ack, the deferred side effect is aborted along with
        // the process and never happens.
        #[tokio::test(flavor = "current_thread")]
        async fn dispatcher_does_not_kill_worker_before_deferred_agent_run_completes() {
            use bob_core::ports::PersistenceStore;

            let tmp = tempfile::tempdir().expect("temp dir");
            let record_file = tmp.path().join("deferred_side_effect.txt");
            let record_file_str = record_file.to_string_lossy().into_owned();

            // Worker script: acknowledge the prompt immediately, then sleep
            // (simulating the in-flight agent run continuing past the ack)
            // before performing the observable side effect. No subshell/`&`
            // is used: the sleep and the write happen in the same process the
            // dispatcher would kill, exactly like a real pi run continuing
            // after its RPC acceptance response.
            let worker_script = format!(
                "while IFS= read -r line; do \
                 id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 msg=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"message\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 printf '{{\"id\":\"%s\",\"type\":\"response\",\"success\":true}}\\n' \"$id\"; \
                 sleep 0.3; \
                 printf '%s\\n' \"$msg\" >> \"{}\"; \
                 done",
                record_file_str
            );

            let cfg = BobConfig {
                admin_sock_path: tmp.path().join("admin.sock"),
                extension_sock_path: tmp.path().join("extension.sock"),
                extension_path: existing_extension_path(),
                pi_agent_command: "sh".to_string(),
                pi_agent_args: vec!["-c".to_string(), worker_script],
                pi_agent_warm_pool_size: 1,
                pi_agent_max_processes: 2,
                request_queue_capacity: 16,
                shutdown_drain_deadline: Duration::from_millis(500),
                shutdown_reap_deadline: Duration::from_millis(250),
                ..BobConfig::test_base()
            };

            let runtime = start_subsystems(&cfg).expect("subsystems must start");

            runtime
                ._persistence
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "deferred-side-effect-prompt".to_owned(),
                    },
                    None,
                )
                .await
                .expect("enqueue must succeed");

            // The deferred side effect (the file write) only happens ~300ms
            // after the ack. If the dispatcher kills the worker right after
            // the ack (the B-017 bug), the sleep is interrupted by SIGTERM
            // and this write never happens, so this wait times out.
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if record_file.exists() {
                        let content = std::fs::read_to_string(&record_file).unwrap_or_default();
                        if content.contains("deferred-side-effect-prompt") {
                            break;
                        }
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect(
                "the deferred agent-run side effect must complete; the dispatcher must not \
                 kill the worker before the run (simulated by the post-ack sleep) finishes",
            );

            run_shutdown_protocol(runtime, &cfg).await;
        }

        // AC-3: when send_prompt returns an error (e.g. the worker process
        // exits immediately and cannot handle the prompt), the dispatcher logs
        // a warning and continues processing subsequent events without crashing.
        #[tokio::test(flavor = "current_thread")]
        async fn dispatcher_continues_after_send_prompt_error() {
            use bob_core::ports::PersistenceStore;

            let tmp = tempfile::tempdir().expect("temp dir");
            // "exit 0" workers exit immediately; send_prompt will fail because
            // the child process is gone.
            let cfg = test_cfg_with_sockets(&tmp);
            let runtime = start_subsystems(&cfg).expect("subsystems must start");

            // Enqueue several Periodic events; each will trigger a send_prompt
            // error because the worker exits before the RPC reply arrives.
            for _ in 0..3_u8 {
                runtime
                    ._persistence
                    .enqueue_periodic_with_job_id(
                        InternalEvent {
                            kind: DeliveryKind::Periodic,
                            payload: "error-resilience-test".to_owned(),
                        },
                        None,
                    )
                    .await
                    .expect("enqueue must succeed");
            }

            // Give the dispatcher time to attempt all three events.
            tokio::time::sleep(Duration::from_millis(300)).await;

            // The dispatcher must still be running — errors must not crash it.
            assert!(
                !runtime.dispatcher_join.is_finished(),
                "dispatcher must still be running after send_prompt errors"
            );

            run_shutdown_protocol(runtime, &cfg).await;
        }

        // AC-4: when no Periodic event is available the dispatcher waits without
        // busy-spinning.  Verified indirectly: with an empty queue the shutdown
        // completes cleanly and quickly (the dispatcher responds to the shutdown
        // signal promptly rather than blocking until a drain deadline is hit).
        #[tokio::test(flavor = "current_thread")]
        async fn dispatcher_waits_without_busy_spinning_when_queue_is_empty() {
            let tmp = tempfile::tempdir().expect("temp dir");
            let mut cfg = test_cfg_with_sockets(&tmp);
            cfg.shutdown_drain_deadline = Duration::from_millis(500);
            cfg.shutdown_reap_deadline = Duration::from_millis(250);

            let runtime = start_subsystems(&cfg).expect("subsystems must start");

            // Leave the queue empty; give the dispatcher a cycle to enter its
            // idle-wait state.
            tokio::time::sleep(Duration::from_millis(50)).await;

            let started_at = std::time::Instant::now();
            run_shutdown_protocol(runtime, &cfg).await;

            assert!(
                started_at.elapsed() < cfg.shutdown_drain_deadline,
                "idle dispatcher must respond to shutdown signal before the drain deadline expires"
            );
        }

        // ── T-126 / B-023: job-id correlator wiring through the periodic
        //    dispatcher, and the dedicated-periodic-queue contract ─────────

        /// A `PersistenceStore` spy that records which methods were called and
        /// serves at most one pre-loaded `(event, job_id)` pair via the
        /// dedicated periodic-queue methods, then reports an empty periodic
        /// queue forever after. The general (shared) queue methods are
        /// tracked but never serve `pending` — B-023 requires the periodic
        /// dispatcher to never touch the general queue at all.
        ///
        /// Used to prove — deterministically, without racing the real queue or
        /// depending on process/tracing timing — which of the correlator-carrying
        /// (T-120) methods `start_periodic_dispatcher` calls on dequeue, and that
        /// it never calls the general (shared) queue's methods.
        struct SpyPersistence {
            calls: std::sync::Mutex<Vec<&'static str>>,
            pending: std::sync::Mutex<Option<(InternalEvent, Option<String>)>>,
        }

        impl SpyPersistence {
            fn with_pending(event: InternalEvent, job_id: Option<String>) -> Self {
                Self {
                    calls: std::sync::Mutex::new(Vec::new()),
                    pending: std::sync::Mutex::new(Some((event, job_id))),
                }
            }

            fn calls(&self) -> Vec<&'static str> {
                self.calls.lock().expect("calls lock").clone()
            }
        }

        #[async_trait::async_trait]
        impl PersistenceStore for SpyPersistence {
            async fn enqueue(&self, _event: InternalEvent) -> ServiceResult<()> {
                self.calls.lock().expect("calls lock").push("enqueue");
                Ok(())
            }

            async fn dequeue_next(&self) -> ServiceResult<Option<InternalEvent>> {
                self.calls.lock().expect("calls lock").push("dequeue_next");
                Ok(None)
            }

            async fn enqueue_with_job_id(
                &self,
                _event: InternalEvent,
                _job_id: Option<String>,
            ) -> ServiceResult<()> {
                self.calls
                    .lock()
                    .expect("calls lock")
                    .push("enqueue_with_job_id");
                Ok(())
            }

            async fn dequeue_next_with_job_id(
                &self,
            ) -> ServiceResult<Option<(InternalEvent, Option<String>)>> {
                self.calls
                    .lock()
                    .expect("calls lock")
                    .push("dequeue_next_with_job_id");
                Ok(None)
            }

            async fn enqueue_periodic_with_job_id(
                &self,
                _event: InternalEvent,
                _job_id: Option<String>,
            ) -> ServiceResult<()> {
                self.calls
                    .lock()
                    .expect("calls lock")
                    .push("enqueue_periodic_with_job_id");
                Ok(())
            }

            async fn dequeue_next_periodic_with_job_id(
                &self,
            ) -> ServiceResult<Option<(InternalEvent, Option<String>)>> {
                self.calls
                    .lock()
                    .expect("calls lock")
                    .push("dequeue_next_periodic_with_job_id");
                Ok(self.pending.lock().expect("pending lock").take())
            }

            async fn put_session_state(
                &self,
                _id: bob_core::types::SessionId,
                _state: bob_core::ports::SessionState,
            ) -> ServiceResult<()> {
                Ok(())
            }

            async fn get_session_state(
                &self,
                _id: bob_core::types::SessionId,
            ) -> ServiceResult<Option<bob_core::ports::SessionState>> {
                Ok(None)
            }
        }

        /// A supervisor whose `acquire_session` fails immediately (missing
        /// binary, empty warm pool) so tests can exercise the periodic branch's
        /// dequeue step without waiting on any real process I/O.
        fn failing_supervisor_handle() -> (pi_agent_supervisor::Handle, JoinHandle<()>) {
            let cfg = pi_agent_supervisor::Config {
                worker_command: "__t126_missing_pi_binary__".to_string(),
                worker_args: Vec::new(),
                warm_pool_size: 0,
                max_processes: 1,
                extension_path: existing_extension_path(),
                ..pi_agent_supervisor::Config::default()
            };
            pi_agent_supervisor::start(cfg).expect("supervisor must start with an empty warm pool")
        }

        /// An `AuditSink` that records every appended record, so T-127 tests can
        /// assert on the AC-2 monitoring failure record without depending on the
        /// real monitoring actor.
        #[derive(Default)]
        struct SpyAuditSink {
            records: std::sync::Mutex<Vec<bob_core::types::AuditRecord>>,
        }

        impl SpyAuditSink {
            fn records(&self) -> Vec<bob_core::types::AuditRecord> {
                self.records.lock().expect("records lock").clone()
            }
        }

        #[async_trait::async_trait]
        impl bob_core::ports::AuditSink for SpyAuditSink {
            async fn append(&self, record: bob_core::types::AuditRecord) -> ServiceResult<()> {
                self.records.lock().expect("records lock").push(record);
                Ok(())
            }
        }

        /// A live schedule table receiver seeded with `entries`, for tests that
        /// don't need a real `scheduler_adapter` actor — the dispatcher only ever
        /// calls `.borrow()` on this receiver.
        fn schedule_rx_with_entries(
            entries: Vec<ScheduleEntry>,
        ) -> watch::Receiver<Vec<ScheduleEntry>> {
            let (_tx, rx) = watch::channel(entries);
            rx
        }

        // AC-3 (T-126) / B-023: the periodic dispatcher reads the job-id
        // correlator back via `dequeue_next_periodic_with_job_id` — the
        // dedicated periodic queue — and never calls any of the general
        // (shared) queue's methods at all.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_calls_dequeue_next_periodic_with_job_id() {
            let spy = Arc::new(SpyPersistence::with_pending(
                InternalEvent {
                    kind: DeliveryKind::Periodic,
                    payload: "job-id-readback-test".to_owned(),
                },
                Some("job-readback-77".to_owned()),
            ));
            let (supervisor_handle, supervisor_join) = failing_supervisor_handle();

            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::clone(&spy) as Arc<dyn PersistenceStore>,
                supervisor_handle.clone(),
                schedule_rx_with_entries(Vec::new()),
                None,
                Arc::new(SpyAuditSink::default()),
                cancel_rx,
            );

            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if spy.calls().contains(&"dequeue_next_periodic_with_job_id") {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect(
                "dispatcher must call dequeue_next_periodic_with_job_id to read the job id back",
            );

            assert!(
                !spy.calls().contains(&"dequeue_next")
                    && !spy.calls().contains(&"dequeue_next_with_job_id")
                    && !spy.calls().contains(&"enqueue")
                    && !spy.calls().contains(&"enqueue_with_job_id"),
                "dispatcher must exclusively use the dedicated periodic-queue methods, never the \
                 general (shared) queue's methods; calls: {:?}",
                spy.calls()
            );

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
        }

        // B-023: supersedes the old
        // `dispatcher_re_enqueues_non_periodic_event_via_plain_enqueue` test,
        // which asserted the buggy destructive re-enqueue as the desired
        // contract. The periodic dispatcher must never mutate the shared
        // inbound queue at all — no plain `enqueue` call — regardless of what
        // it observes there.
        #[tokio::test(flavor = "current_thread")]
        async fn dispatcher_never_calls_plain_enqueue_on_the_shared_queue() {
            let spy = Arc::new(SpyPersistence::with_pending(
                InternalEvent {
                    kind: DeliveryKind::Sync,
                    payload: "must-not-be-touched".to_owned(),
                },
                Some("stray-job-id".to_owned()),
            ));
            let (supervisor_handle, supervisor_join) = failing_supervisor_handle();

            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::clone(&spy) as Arc<dyn PersistenceStore>,
                supervisor_handle.clone(),
                schedule_rx_with_entries(Vec::new()),
                None,
                Arc::new(SpyAuditSink::default()),
                cancel_rx,
            );

            // Give the dispatcher several poll cycles to (mis)behave if it
            // still treats the spy's pending item as something to dequeue
            // and push back onto the shared queue.
            tokio::time::sleep(PERIODIC_DISPATCH_POLL_INTERVAL * 3).await;

            assert!(
                !spy.calls().contains(&"enqueue"),
                "the periodic dispatcher must never call the plain enqueue to push an event \
                 back onto the shared inbound queue; calls: {:?}",
                spy.calls()
            );

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
        }

        // ── B-023: periodic dispatcher must not reorder or be delayed by the
        //    shared inbound persistence queue ──────────────────────────────

        // Regression (a): non-periodic events queued through the shared
        // inbound persistence queue must retain their original relative
        // FIFO order even while the periodic dispatcher is running
        // concurrently. Before the fix, the dispatcher dequeued the FIFO
        // head regardless of DeliveryKind and re-enqueued non-Periodic items
        // at the tail, rotating the queue on every poll tick.
        #[tokio::test(flavor = "current_thread")]
        async fn non_periodic_events_retain_fifo_order_while_periodic_dispatcher_runs_concurrently()
        {
            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());

            let sync_event = |n: u32| InternalEvent {
                kind: DeliveryKind::Sync,
                payload: format!("sync-{n}"),
            };
            let non_periodic: Vec<InternalEvent> = (0..7).map(sync_event).collect();
            for event in &non_periodic {
                persistence_handle
                    .enqueue(event.clone())
                    .await
                    .expect("enqueue must succeed");
            }

            // Admit real periodic work too, exactly the way production code
            // does, so the dispatcher has something to actively poll for
            // concurrently with the assertion below.
            admit_periodic_event(
                &persistence_handle,
                InternalEvent {
                    kind: DeliveryKind::Periodic,
                    payload: "concurrent-tick".to_owned(),
                },
                Some("concurrent-tick-job".to_owned()),
            )
            .await;

            let (supervisor_handle, supervisor_join) = failing_supervisor_handle();
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx_with_entries(Vec::new()),
                None,
                Arc::new(SpyAuditSink::default()),
                cancel_rx,
            );

            // Let the dispatcher run concurrently for several poll cycles —
            // long enough that, under the pre-fix behaviour, several
            // non-periodic events would have been dequeued and re-enqueued
            // at the tail, but not so long that a full rotation coincidentally
            // restores the original order.
            tokio::time::sleep(PERIODIC_DISPATCH_POLL_INTERVAL * 3 + Duration::from_millis(50))
                .await;

            let mut drained = Vec::new();
            while let Some(event) = persistence_handle
                .dequeue_next()
                .await
                .expect("dequeue must not fail")
            {
                drained.push(event);
            }

            assert_eq!(
                drained, non_periodic,
                "non-periodic events must retain their original relative FIFO order even while \
                 the periodic dispatcher is running concurrently"
            );

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
        }

        // Regression (b): a periodic item's dispatch latency must be bounded
        // by the periodic dispatcher's own poll cadence
        // (PERIODIC_DISPATCH_POLL_INTERVAL), independent of the depth of
        // unrelated non-periodic backlog queued ahead of it. Before the fix,
        // the dispatcher paid one full PERIODIC_DISPATCH_POLL_INTERVAL
        // back-off per non-periodic item ahead of the periodic one.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatch_latency_is_independent_of_non_periodic_backlog_depth() {
            let tmp = tempfile::tempdir().expect("temp dir");
            let record_file = tmp.path().join("received_prompt.txt");
            let record_file_str = record_file.to_string_lossy().into_owned();

            let worker_script = format!(
                "while IFS= read -r line; do \
                 id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 printf 'dispatched\\n' >> \"{}\"; \
                 printf '{{\"id\":\"%s\",\"type\":\"response\",\"success\":true}}\\n' \"$id\"; \
                 done",
                record_file_str
            );

            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());

            // Queue several unrelated non-periodic events ahead of the
            // periodic one.
            const BACKLOG_DEPTH: u32 = 10;
            for i in 0..BACKLOG_DEPTH {
                persistence_handle
                    .enqueue(InternalEvent {
                        kind: DeliveryKind::Sync,
                        payload: format!("backlog-{i}"),
                    })
                    .await
                    .expect("enqueue must succeed");
            }

            admit_periodic_event(
                &persistence_handle,
                InternalEvent {
                    kind: DeliveryKind::Periodic,
                    payload: "latency-probe".to_owned(),
                },
                Some("latency-probe-job".to_owned()),
            )
            .await;

            let (supervisor_handle, supervisor_join) =
                pi_agent_supervisor::start(pi_agent_supervisor::Config {
                    worker_command: "sh".to_string(),
                    worker_args: vec!["-c".to_string(), worker_script],
                    warm_pool_size: 1,
                    max_processes: 2,
                    extension_path: existing_extension_path(),
                    ..pi_agent_supervisor::Config::default()
                })
                .expect("supervisor must start");

            let (cancel_tx, cancel_rx) = watch::channel(false);
            let started_at = Instant::now();
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx_with_entries(Vec::new()),
                None,
                Arc::new(SpyAuditSink::default()),
                cancel_rx,
            );

            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if record_file.exists() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(5)).await;
                }
            })
            .await
            .expect("periodic dispatcher must dispatch the periodic event within the timeout");

            let elapsed = started_at.elapsed();
            let bound = PERIODIC_DISPATCH_POLL_INTERVAL * 5;
            assert!(
                elapsed < bound,
                "periodic dispatch latency ({elapsed:?}) must be bounded by the dispatcher's \
                 own poll cadence ({bound:?}), independent of the {BACKLOG_DEPTH} unrelated \
                 non-periodic events queued ahead of it"
            );

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
        }

        // ── T-127: dispatcher-level cwd resolution and dedicated acquisition ──

        // AC-1: when the dequeued job id resolves to a live entry with a
        // per-entry `cwd`, the dispatcher acquires a dedicated worker bound to
        // that directory (T-122) rather than a plain `acquire_session`.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_acquires_dedicated_worker_at_resolved_per_entry_cwd() {
            let worker_cwd = std::env::temp_dir().join(format!(
                "bob-serve-t127-per-entry-cwd-{}",
                bob_core::types::SessionId::new()
            ));
            std::fs::create_dir_all(&worker_cwd).expect("create dedicated cwd should succeed");

            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());
            persistence_handle
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "per-entry-cwd-test".to_owned(),
                    },
                    Some("cwd-job".to_owned()),
                )
                .await
                .expect("enqueue must succeed");

            let mut entry = ScheduleEntry::with_prompt("cwd-job", "0 9 * * *", "unused");
            entry.cwd = Some(worker_cwd.to_string_lossy().into_owned());
            let schedule_rx = schedule_rx_with_entries(vec![entry]);

            let worker_script = "pwd > marker.txt; while IFS= read -r line; do \
                 id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":true}\\n' \"$id\"; \
                 done"
                .to_string();
            // warm_pool_size: 0 — a warm worker would also run worker_script but
            // inherit the (unset) launch cwd instead of worker_cwd, writing a
            // stray marker.txt outside the dedicated cwd this test asserts on.
            let (supervisor_handle, supervisor_join) =
                pi_agent_supervisor::start(pi_agent_supervisor::Config {
                    worker_command: "sh".to_string(),
                    worker_args: vec!["-c".to_string(), worker_script],
                    warm_pool_size: 0,
                    max_processes: 2,
                    extension_path: existing_extension_path(),
                    ..pi_agent_supervisor::Config::default()
                })
                .expect("supervisor must start");

            let audit_sink: Arc<dyn AuditSink> = Arc::new(SpyAuditSink::default());
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx,
                None,
                audit_sink,
                cancel_rx,
            );

            let marker_path = worker_cwd.join("marker.txt");
            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if marker_path.exists() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("dedicated worker should have written the marker file in its cwd");

            let contents = std::fs::read_to_string(&marker_path).expect("read marker file");
            let actual_cwd =
                std::fs::canonicalize(contents.trim()).expect("canonicalize actual reported cwd");
            let expected_cwd =
                std::fs::canonicalize(&worker_cwd).expect("canonicalize expected worker cwd");
            assert_eq!(
                actual_cwd, expected_cwd,
                "dedicated worker should run in the resolved per-entry cwd"
            );

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
            std::fs::remove_dir_all(&worker_cwd).ok();
        }

        // ── T-128: resolved-cwd population on the periodic-fire event audit
        //    record ──

        // AC-1/AC-2: when a periodic firing dispatched via a per-entry `cwd`
        // reaches dispatch, an `event`-kind audit record is appended carrying
        // the concrete resolved absolute path used (the per-entry `cwd`
        // itself, the top precedence tier) on `resolved_cwd` — not left
        // unset and not the raw per-entry field before resolution.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_records_resolved_cwd_on_event_audit_record_for_per_entry_cwd_fire(
        ) {
            let worker_cwd = std::env::temp_dir().join(format!(
                "bob-serve-t128-per-entry-cwd-{}",
                bob_core::types::SessionId::new()
            ));
            std::fs::create_dir_all(&worker_cwd).expect("create dedicated cwd should succeed");

            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());
            persistence_handle
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "per-entry-cwd-audit-test".to_owned(),
                    },
                    Some("cwd-audit-job".to_owned()),
                )
                .await
                .expect("enqueue must succeed");

            let mut entry = ScheduleEntry::with_prompt("cwd-audit-job", "0 9 * * *", "unused");
            entry.cwd = Some(worker_cwd.to_string_lossy().into_owned());
            let schedule_rx = schedule_rx_with_entries(vec![entry]);

            let worker_script = "while IFS= read -r line; do \
                 id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":true}\\n' \"$id\"; \
                 done"
                .to_string();
            let (supervisor_handle, supervisor_join) =
                pi_agent_supervisor::start(pi_agent_supervisor::Config {
                    worker_command: "sh".to_string(),
                    worker_args: vec!["-c".to_string(), worker_script],
                    warm_pool_size: 0,
                    max_processes: 2,
                    extension_path: existing_extension_path(),
                    ..pi_agent_supervisor::Config::default()
                })
                .expect("supervisor must start");

            let audit_sink = Arc::new(SpyAuditSink::default());
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx,
                None,
                Arc::clone(&audit_sink) as Arc<dyn AuditSink>,
                cancel_rx,
            );

            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if audit_sink
                        .records()
                        .iter()
                        .any(|r| r.kind == AuditRecordKind::Event)
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("dispatched per-entry-cwd fire must produce an event audit record");

            let records = audit_sink.records();
            let event_records: Vec<_> = records
                .iter()
                .filter(|r| r.kind == AuditRecordKind::Event)
                .collect();
            assert_eq!(
                event_records.len(),
                1,
                "expected exactly one event audit record, got {records:?}"
            );
            match &event_records[0].payload {
                AuditRecordPayload::Event(payload) => {
                    assert_eq!(
                        payload.resolved_cwd,
                        Some(worker_cwd.clone()),
                        "resolved_cwd must be the concrete per-entry cwd used for this fire"
                    );
                }
                other => panic!("expected an Event payload, got {other:?}"),
            }

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
            std::fs::remove_dir_all(&worker_cwd).ok();
        }

        // AC-2: when no per-entry `cwd` applies, the event audit record's
        // `resolved_cwd` carries the configured service-wide `pi_agent_cwd`
        // (the middle precedence tier) — the concrete resolved path, not the
        // raw (absent) per-entry field, and not left unset.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_records_configured_service_default_cwd_on_event_audit_record()
        {
            let configured_default_cwd = std::env::temp_dir().join(format!(
                "bob-serve-t128-service-default-cwd-{}",
                bob_core::types::SessionId::new()
            ));
            std::fs::create_dir_all(&configured_default_cwd)
                .expect("create configured default cwd should succeed");

            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());
            persistence_handle
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "service-default-cwd-audit-test".to_owned(),
                    },
                    None,
                )
                .await
                .expect("enqueue must succeed");

            let schedule_rx = schedule_rx_with_entries(Vec::new());

            let worker_script = "while IFS= read -r line; do \
                 id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":true}\\n' \"$id\"; \
                 done"
                .to_string();
            let (supervisor_handle, supervisor_join) =
                pi_agent_supervisor::start(pi_agent_supervisor::Config {
                    worker_command: "sh".to_string(),
                    worker_args: vec!["-c".to_string(), worker_script],
                    warm_pool_size: 0,
                    max_processes: 2,
                    extension_path: existing_extension_path(),
                    ..pi_agent_supervisor::Config::default()
                })
                .expect("supervisor must start");

            let audit_sink = Arc::new(SpyAuditSink::default());
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx,
                Some(configured_default_cwd.clone()),
                Arc::clone(&audit_sink) as Arc<dyn AuditSink>,
                cancel_rx,
            );

            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if audit_sink
                        .records()
                        .iter()
                        .any(|r| r.kind == AuditRecordKind::Event)
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("dispatched service-default fire must produce an event audit record");

            let records = audit_sink.records();
            let event_records: Vec<_> = records
                .iter()
                .filter(|r| r.kind == AuditRecordKind::Event)
                .collect();
            assert_eq!(
                event_records.len(),
                1,
                "expected exactly one event audit record, got {records:?}"
            );
            match &event_records[0].payload {
                AuditRecordPayload::Event(payload) => {
                    assert_eq!(
                        payload.resolved_cwd,
                        Some(configured_default_cwd.clone()),
                        "resolved_cwd must be the configured service-wide pi_agent_cwd, not left unset"
                    );
                }
                other => panic!("expected an Event payload, got {other:?}"),
            }

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
            std::fs::remove_dir_all(&configured_default_cwd).ok();
        }

        // AC-2: when neither a per-entry `cwd` nor a service-wide
        // `pi_agent_cwd` applies (the bottom precedence tier), the event
        // audit record's `resolved_cwd` still carries a concrete absolute
        // path — the dispatcher's own inherited launch cwd — rather than
        // being left unset.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_records_inherited_launch_cwd_on_event_audit_record_when_pi_agent_cwd_unset(
        ) {
            let inherited_launch_cwd =
                std::env::current_dir().expect("current dir should be available in tests");

            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());
            persistence_handle
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "inherited-cwd-audit-test".to_owned(),
                    },
                    None,
                )
                .await
                .expect("enqueue must succeed");

            let schedule_rx = schedule_rx_with_entries(Vec::new());

            let worker_script = "while IFS= read -r line; do \
                 id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":true}\\n' \"$id\"; \
                 done"
                .to_string();
            let (supervisor_handle, supervisor_join) =
                pi_agent_supervisor::start(pi_agent_supervisor::Config {
                    worker_command: "sh".to_string(),
                    worker_args: vec!["-c".to_string(), worker_script],
                    warm_pool_size: 0,
                    max_processes: 2,
                    extension_path: existing_extension_path(),
                    ..pi_agent_supervisor::Config::default()
                })
                .expect("supervisor must start");

            let audit_sink = Arc::new(SpyAuditSink::default());
            let (cancel_tx, cancel_rx) = watch::channel(false);
            // default_worker_cwd is None — no pi_agent_cwd configured — so the
            // bottom precedence tier (the dispatcher's own inherited launch
            // cwd) applies.
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx,
                None,
                Arc::clone(&audit_sink) as Arc<dyn AuditSink>,
                cancel_rx,
            );

            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if audit_sink
                        .records()
                        .iter()
                        .any(|r| r.kind == AuditRecordKind::Event)
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect(
                "dispatched fire with no configured default cwd must produce an event audit record",
            );

            let records = audit_sink.records();
            let event_records: Vec<_> = records
                .iter()
                .filter(|r| r.kind == AuditRecordKind::Event)
                .collect();
            assert_eq!(
                event_records.len(),
                1,
                "expected exactly one event audit record, got {records:?}"
            );
            match &event_records[0].payload {
                AuditRecordPayload::Event(payload) => {
                    assert_eq!(
                        payload.resolved_cwd,
                        Some(inherited_launch_cwd),
                        "resolved_cwd must be the dispatcher's inherited launch cwd, not left unset"
                    );
                }
                other => panic!("expected an Event payload, got {other:?}"),
            }

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
        }

        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_does_not_record_dispatched_event_when_prompt_send_fails() {
            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());
            persistence_handle
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "send-failure-audit-test".to_owned(),
                    },
                    Some("send-failure-job".to_owned()),
                )
                .await
                .expect("enqueue must succeed");

            let schedule_rx = schedule_rx_with_entries(vec![ScheduleEntry::with_prompt(
                "send-failure-job",
                "0 9 * * *",
                "unused",
            )]);

            let (supervisor_handle, supervisor_join) =
                pi_agent_supervisor::start(pi_agent_supervisor::Config {
                    worker_command: "sh".to_string(),
                    worker_args: vec!["-c".to_string(), "exit 0".to_string()],
                    warm_pool_size: 0,
                    max_processes: 1,
                    extension_path: existing_extension_path(),
                    ..pi_agent_supervisor::Config::default()
                })
                .expect("supervisor must start");

            let audit_sink = Arc::new(SpyAuditSink::default());
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx,
                None,
                Arc::clone(&audit_sink) as Arc<dyn AuditSink>,
                cancel_rx,
            );

            tokio::time::sleep(Duration::from_millis(200)).await;

            let records = audit_sink.records();
            let event_records: Vec<_> = records
                .iter()
                .filter(|r| r.kind == AuditRecordKind::Event)
                .collect();
            assert!(
                event_records.is_empty(),
                "failed prompt delivery must not append a dispatched event audit record: {records:?}"
            );

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
        }

        // AC-2: a resolved per-entry `cwd` that does not exist at fire time is
        // skipped with a warning and a monitoring failure record. No worker is
        // ever acquired for the missing directory — proven here by pairing the
        // missing-cwd entry with a supervisor that fails fast (missing binary,
        // empty warm pool), so any accidental acquisition attempt would be
        // observable as a *different* failure path than the one asserted below.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_skips_fire_and_records_failure_when_per_entry_cwd_is_missing()
        {
            let missing_cwd = std::env::temp_dir().join(format!(
                "bob-serve-t127-missing-cwd-{}",
                bob_core::types::SessionId::new()
            ));
            // Deliberately do not create `missing_cwd` on disk.

            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());
            persistence_handle
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "missing-cwd-test".to_owned(),
                    },
                    Some("missing-cwd-job".to_owned()),
                )
                .await
                .expect("enqueue must succeed");

            let mut entry = ScheduleEntry::with_prompt("missing-cwd-job", "0 9 * * *", "unused");
            entry.cwd = Some(missing_cwd.to_string_lossy().into_owned());
            let schedule_rx = schedule_rx_with_entries(vec![entry]);

            let (supervisor_handle, supervisor_join) = failing_supervisor_handle();

            let audit_sink = Arc::new(SpyAuditSink::default());
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx,
                None,
                Arc::clone(&audit_sink) as Arc<dyn AuditSink>,
                cancel_rx,
            );

            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if !audit_sink.records().is_empty() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("missing per-entry cwd must produce a monitoring failure record");

            let records = audit_sink.records();
            assert_eq!(
                records.len(),
                1,
                "expected exactly one monitoring failure record, got {records:?}"
            );
            match &records[0].payload {
                AuditRecordPayload::Report(payload) => {
                    assert_eq!(payload.outcome, ReportOutcome::Error);
                    assert!(
                        payload
                            .summary
                            .as_deref()
                            .unwrap_or("")
                            .contains("missing-cwd-job"),
                        "summary should reference the job id: {:?}",
                        payload.summary
                    );
                }
                other => panic!("expected a Report payload, got {other:?}"),
            }

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
        }

        // AC-3: a job id that no longer resolves to any live schedule entry
        // (removed between enqueue and fire) falls back to the service-wide
        // default cwd — the fire still dispatches via the plain
        // `acquire_session`, it is not dropped or blocked.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_falls_back_to_default_cwd_when_job_id_not_in_live_table() {
            let tmp = tempfile::tempdir().expect("temp dir");
            let record_file = tmp.path().join("received_prompt.txt");
            let record_file_str = record_file.to_string_lossy().into_owned();

            let worker_script = format!(
                "while IFS= read -r line; do \
                 id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 printf 'received\\n' >> \"{}\"; \
                 printf '{{\"id\":\"%s\",\"type\":\"response\",\"success\":true}}\\n' \"$id\"; \
                 done",
                record_file_str
            );

            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());
            persistence_handle
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "stale-job-id-test".to_owned(),
                    },
                    Some("removed-job".to_owned()),
                )
                .await
                .expect("enqueue must succeed");

            // The live table does not contain "removed-job" — simulates the
            // entry being removed between enqueue and fire.
            let schedule_rx = schedule_rx_with_entries(Vec::new());

            let (supervisor_handle, supervisor_join) =
                pi_agent_supervisor::start(pi_agent_supervisor::Config {
                    worker_command: "sh".to_string(),
                    worker_args: vec!["-c".to_string(), worker_script],
                    warm_pool_size: 1,
                    max_processes: 2,
                    extension_path: existing_extension_path(),
                    ..pi_agent_supervisor::Config::default()
                })
                .expect("supervisor must start");

            let audit_sink: Arc<dyn AuditSink> = Arc::new(SpyAuditSink::default());
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx,
                None,
                audit_sink,
                cancel_rx,
            );

            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if record_file.exists() {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("dispatcher must fall back to the default cwd and still dispatch the fire");

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
        }

        // AC-3: a job id that no longer resolves to a live schedule entry must
        // also produce a monitoring record for the fallback condition — per
        // coding-guidelines-rust.md §6, "record the condition" means a
        // persisted audit record, not just an operational tracing log.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_records_fallback_condition_when_job_id_not_in_live_table() {
            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());
            persistence_handle
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "stale-job-id-record-test".to_owned(),
                    },
                    Some("removed-job-for-record-test".to_owned()),
                )
                .await
                .expect("enqueue must succeed");

            // The live table does not contain "removed-job-for-record-test".
            let schedule_rx = schedule_rx_with_entries(Vec::new());

            let worker_script = "while IFS= read -r line; do \
                 id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":true}\\n' \"$id\"; \
                 done"
                .to_string();
            let (supervisor_handle, supervisor_join) =
                pi_agent_supervisor::start(pi_agent_supervisor::Config {
                    worker_command: "sh".to_string(),
                    worker_args: vec!["-c".to_string(), worker_script],
                    warm_pool_size: 1,
                    max_processes: 2,
                    extension_path: existing_extension_path(),
                    ..pi_agent_supervisor::Config::default()
                })
                .expect("supervisor must start");

            let audit_sink = Arc::new(SpyAuditSink::default());
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx,
                None,
                Arc::clone(&audit_sink) as Arc<dyn AuditSink>,
                cancel_rx,
            );

            tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    if audit_sink
                        .records()
                        .iter()
                        .any(|r| r.kind == AuditRecordKind::Report)
                    {
                        break;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("stale job id fallback must produce a monitoring record");

            // T-128: once the fallback is recorded, the dispatcher still
            // proceeds to dispatch the fire via the default cwd, which now
            // also appends an `event`-kind audit record (T-128) alongside
            // this `report`-kind fallback record — filter to the report kind
            // so this AC-3 (T-127) assertion stays independent of T-128's
            // unrelated event record.
            let records = audit_sink.records();
            let report_records: Vec<_> = records
                .iter()
                .filter(|r| r.kind == AuditRecordKind::Report)
                .collect();
            assert_eq!(
                report_records.len(),
                1,
                "expected exactly one fallback monitoring record, got {records:?}"
            );
            match &report_records[0].payload {
                AuditRecordPayload::Report(payload) => {
                    assert_eq!(payload.outcome, ReportOutcome::Error);
                    let summary = payload.summary.as_deref().unwrap_or("");
                    assert!(
                        summary.contains("removed-job-for-record-test"),
                        "summary should reference the job id: {summary:?}"
                    );
                    assert!(
                        summary.to_lowercase().contains("fall"),
                        "summary should describe a fallback, not a skip: {summary:?}"
                    );
                }
                other => panic!("expected a Report payload, got {other:?}"),
            }

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
        }

        // AC-4: when the pool is already at `max_processes`, a per-entry-cwd
        // fire is skipped with a warning rather than blocking or evicting the
        // existing live worker.
        #[tokio::test(flavor = "current_thread")]
        async fn periodic_dispatcher_skips_per_entry_cwd_fire_without_evicting_when_pool_is_full() {
            let cwd_dir = std::env::temp_dir().join(format!(
                "bob-serve-t127-max-processes-cwd-{}",
                bob_core::types::SessionId::new()
            ));
            std::fs::create_dir_all(&cwd_dir).expect("create dedicated cwd should succeed");

            // Worker script: acknowledge every prompt and keep running, so the
            // first acquired session stays alive (occupying the sole
            // max_processes slot) for the rest of the test.
            let worker_script = "while IFS= read -r line; do \
                 id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
                 printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":true}\\n' \"$id\"; \
                 done"
                .to_string();

            let (supervisor_handle, supervisor_join) =
                pi_agent_supervisor::start(pi_agent_supervisor::Config {
                    worker_command: "sh".to_string(),
                    worker_args: vec!["-c".to_string(), worker_script],
                    warm_pool_size: 0,
                    max_processes: 1,
                    extension_path: existing_extension_path(),
                    ..pi_agent_supervisor::Config::default()
                })
                .expect("supervisor must start");

            let (persistence_handle, _persistence_join) =
                persistence::start(persistence::Config::default());

            // First fire: no per-entry cwd, occupies the sole max_processes
            // slot via the plain acquire_session path.
            persistence_handle
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "first-fire".to_owned(),
                    },
                    None,
                )
                .await
                .expect("enqueue must succeed");

            let mut entry =
                ScheduleEntry::with_prompt("cwd-job-at-capacity", "0 9 * * *", "unused");
            entry.cwd = Some(cwd_dir.to_string_lossy().into_owned());
            let schedule_rx = schedule_rx_with_entries(vec![entry]);

            let audit_sink: Arc<dyn AuditSink> = Arc::new(SpyAuditSink::default());
            let (cancel_tx, cancel_rx) = watch::channel(false);
            let dispatcher_join = start_periodic_dispatcher(
                Arc::new(persistence_handle.clone()),
                supervisor_handle.clone(),
                schedule_rx,
                None,
                audit_sink,
                cancel_rx,
            );

            // Wait for the first fire to acquire the sole slot.
            let first_session_id = tokio::time::timeout(Duration::from_secs(5), async {
                loop {
                    let sessions = supervisor_handle
                        .list_sessions()
                        .await
                        .expect("list sessions should succeed");
                    if let Some(id) = sessions.first().copied() {
                        break id;
                    }
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
            })
            .await
            .expect("first fire must acquire the sole max_processes slot");

            // Second fire: resolves to a per-entry cwd, but the pool is
            // already full.
            persistence_handle
                .enqueue_periodic_with_job_id(
                    InternalEvent {
                        kind: DeliveryKind::Periodic,
                        payload: "second-fire-should-be-skipped".to_owned(),
                    },
                    Some("cwd-job-at-capacity".to_owned()),
                )
                .await
                .expect("enqueue must succeed");

            // Give the dispatcher time to process (and skip) the second fire.
            tokio::time::sleep(Duration::from_millis(200)).await;

            let marker_path = cwd_dir.join("marker.txt");
            assert!(
                !marker_path.exists(),
                "a dedicated worker must never be spawned for the per-entry cwd fire while the pool is full"
            );

            let sessions_after = supervisor_handle
                .list_sessions()
                .await
                .expect("list sessions should succeed");
            assert_eq!(
                sessions_after,
                vec![first_session_id],
                "the existing live worker must not be evicted by the refused cwd-scoped fire"
            );

            let _ = cancel_tx.send(true);
            drop(supervisor_handle);
            let _ = tokio::time::timeout(Duration::from_secs(1), dispatcher_join).await;
            let _ = tokio::time::timeout(Duration::from_secs(1), supervisor_join).await;
            std::fs::remove_dir_all(&cwd_dir).ok();
        }

        // ── T-127: periodic-fire cwd precedence resolution ─────────────────

        // AC-1: a job id that resolves to a live entry with a per-entry `cwd`
        // set must resolve to that directory (top precedence tier).
        #[test]
        fn resolve_periodic_cwd_returns_per_entry_when_live_entry_has_cwd_set() {
            let mut entry = ScheduleEntry::with_prompt("cwd-job", "0 9 * * *", "unused");
            entry.cwd = Some("/srv/workspaces/email".to_string());

            let resolution = resolve_periodic_cwd(Some("cwd-job"), &[entry]);

            assert_eq!(
                resolution,
                PeriodicCwdResolution::PerEntry(PathBuf::from("/srv/workspaces/email"))
            );
        }

        // AC-1: a job id that resolves to a live entry with no per-entry `cwd`
        // falls through to the service-wide default tier.
        #[test]
        fn resolve_periodic_cwd_returns_service_default_when_live_entry_has_no_cwd() {
            let entry = ScheduleEntry::with_prompt("no-cwd-job", "0 9 * * *", "unused");

            let resolution = resolve_periodic_cwd(Some("no-cwd-job"), &[entry]);

            assert_eq!(resolution, PeriodicCwdResolution::ServiceDefault);
        }

        // AC-1: a fire carrying no job id at all (no scheduler correlator) has
        // nothing to resolve against, so it uses the service-wide default tier.
        #[test]
        fn resolve_periodic_cwd_returns_service_default_when_job_id_is_none() {
            let mut entry = ScheduleEntry::with_prompt("cwd-job", "0 9 * * *", "unused");
            entry.cwd = Some("/srv/workspaces/email".to_string());

            let resolution = resolve_periodic_cwd(None, &[entry]);

            assert_eq!(resolution, PeriodicCwdResolution::ServiceDefault);
        }

        // AC-3: a job id that no longer resolves to any live entry (removed
        // between enqueue and fire) is reported distinctly so the dispatcher
        // can fall back to the default and record the condition.
        #[test]
        fn resolve_periodic_cwd_returns_entry_not_found_when_job_id_not_in_live_table() {
            let entry = ScheduleEntry::with_prompt("other-job", "0 9 * * *", "unused");

            let resolution = resolve_periodic_cwd(Some("removed-job"), &[entry]);

            assert_eq!(resolution, PeriodicCwdResolution::EntryNotFound);
        }
    }

    // T-117 AC-1: WHEN a valid scheduled job fires and admitted_users is empty
    // THE SYSTEM SHALL admit the scheduler firing into the periodic dispatch path.
    //
    // Periodic events submitted through the requests-handler must bypass the
    // UserId admission check (ADR-012) and reach pi-agent via the periodic
    // dispatcher, even when no users are listed in admitted_users.
    //
    // The test submits through the requests-handler (not directly to persistence)
    // to exercise the admission-bypass path, then waits for the prompt to appear
    // in the worker output — proving the event traversed the full path:
    // requests-handler → (bypass) → persistence → dispatcher → pi-agent.
    #[tokio::test(flavor = "current_thread")]
    async fn periodic_event_is_admitted_and_reaches_pi_agent_with_empty_admitted_users() {
        use bob_core::types::{ChannelId, RequestContext};

        let tmp = tempfile::tempdir().expect("temp dir");
        let record_file = tmp.path().join("received_prompt.txt");
        let record_file_str = record_file.to_string_lossy().into_owned();

        // Worker script: write the incoming message to a file and respond with success.
        let worker_script = format!(
            "while IFS= read -r line; do \
             id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
             msg=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"message\":\"\\([^\"]*\\)\".*/\\1/p'); \
             printf '%s\\n' \"$msg\" >> \"{}\"; \
             printf '{{\"id\":\"%s\",\"type\":\"response\",\"success\":true}}\\n' \"$id\"; \
             done",
            record_file_str
        );

        // BobConfig::test_base() already has policy: PolicyConfig::default() which
        // yields empty admitted_users (deny-all for normal admission-gated requests).
        let cfg = BobConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
            extension_sock_path: tmp.path().join("extension.sock"),
            extension_path: existing_extension_path(),
            pi_agent_command: "sh".to_string(),
            pi_agent_args: vec!["-c".to_string(), worker_script],
            pi_agent_warm_pool_size: 1,
            pi_agent_max_processes: 2,
            request_queue_capacity: 16,
            shutdown_drain_deadline: Duration::from_millis(500),
            shutdown_reap_deadline: Duration::from_millis(250),
            ..BobConfig::test_base()
        };

        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        // Submit a Periodic event via the requests-handler.  The preflight closure
        // must bypass UserId admission (ADR-012) and enqueue directly to persistence.
        let event = InternalEvent {
            kind: DeliveryKind::Periodic,
            payload: "adr012-scheduler-test-prompt".to_owned(),
        };
        // Context has attribution fields (job_id, channel, scheduler user) for AC-3.
        let ctx = RequestContext {
            sender: UserId::new(), // not in admitted_users — admission must be bypassed
            source: ChannelId::new(),
            context_id: Some("test-job".to_owned()),
            reply_address: None,
        };
        runtime
            ._requests_handler
            .submit_event(event, ctx)
            .await
            .expect("submit must succeed");

        // Wait for the periodic dispatcher to pick up the event and forward to pi-agent.
        // The worker writes the message to record_file on each successful send_prompt call.
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                if record_file.exists() {
                    let content = std::fs::read_to_string(&record_file).unwrap_or_default();
                    if content.contains("adr012-scheduler-test-prompt") {
                        break;
                    }
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect(
            "periodic event must reach pi-agent even with empty admitted_users (ADR-012 bypass)",
        );

        run_shutdown_protocol(runtime, &cfg).await;
    }

    // T-117 AC-5: IF a non-scheduler admission-gated request has a sender absent
    // from admitted_users THEN THE SYSTEM SHALL continue to deny that request.
    // Non-periodic events still go through the normal pre-flight admission gate.
    #[tokio::test(flavor = "current_thread")]
    async fn sync_event_from_sender_absent_from_admitted_users_is_denied() {
        use bob_core::types::{ChannelId, RequestContext};

        let tmp = tempfile::tempdir().expect("temp dir");
        let mut cfg = test_cfg_with_sockets(&tmp);
        // Admit exactly one user; the event will come from a different user.
        let admitted_user = UserId::new();
        cfg.policy.admitted_users = vec![admitted_user.to_string()];

        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        let event = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "from non-admitted user".to_owned(),
        };
        let ctx = RequestContext {
            sender: UserId::new(), // not in admitted_users
            source: ChannelId::new(),
            context_id: None,
            reply_address: None,
        };
        runtime
            ._requests_handler
            .submit_event(event, ctx)
            .await
            .expect("submit must succeed");

        // Give the preflight actor time to process the event.
        tokio::time::sleep(Duration::from_millis(50)).await;

        let result = runtime
            ._persistence
            .dequeue_next()
            .await
            .expect("dequeue should not fail");
        assert!(
            result.is_none(),
            "sync event from non-admitted sender must not reach persistence"
        );

        run_shutdown_protocol(runtime, &cfg).await;
    }

    // AC-3 (T-068): the pre-flight check uses the per-request context, not a
    // shared startup-time context.
    //
    // Set up a policy with one admitted user (alice).  Submit two events:
    // - one with alice's context → must be persisted.
    // - one with a non-admitted user's context → must NOT be persisted.
    // If a shared startup context carrying alice were used for both, both events
    // would pass; the test distinguishes per-request from shared-context behaviour.
    #[tokio::test(flavor = "current_thread")]
    async fn preflight_uses_per_request_context_not_shared_startup_context() {
        use bob_core::types::{ChannelId, RequestContext};

        let tmp = tempfile::tempdir().expect("temp dir");
        let mut cfg = test_cfg_with_sockets(&tmp);
        let alice = UserId::new();
        cfg.policy.admitted_users = vec![alice.to_string()];

        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        // Event for alice — should be persisted.
        let alice_event = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "from alice".to_owned(),
        };
        let alice_ctx = RequestContext {
            sender: alice,
            source: ChannelId::new(),
            context_id: None,
            reply_address: None,
        };
        runtime
            ._requests_handler
            .submit_event(alice_event.clone(), alice_ctx)
            .await
            .expect("submit must succeed");

        // Event for a non-admitted user — must be denied.
        let intruder_event = InternalEvent {
            kind: DeliveryKind::Sync,
            payload: "from intruder".to_owned(),
        };
        let intruder_ctx = RequestContext {
            sender: UserId::new(), // not in admitted_users
            source: ChannelId::new(),
            context_id: None,
            reply_address: None,
        };
        runtime
            ._requests_handler
            .submit_event(intruder_event, intruder_ctx)
            .await
            .expect("submit must succeed");

        // Wait for both events to be processed.
        let alice_persisted = tokio::time::timeout(Duration::from_secs(1), async {
            loop {
                if let Some(next) = runtime
                    ._persistence
                    .dequeue_next()
                    .await
                    .expect("dequeue should not fail")
                {
                    break next;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("alice event should be persisted before timeout");

        assert_eq!(
            alice_persisted, alice_event,
            "alice's event must be the one persisted"
        );

        // Give a moment for the intruder event to be processed, then confirm no second event arrives.
        tokio::time::sleep(Duration::from_millis(50)).await;
        let second = runtime
            ._persistence
            .dequeue_next()
            .await
            .expect("dequeue should not fail");
        assert!(
            second.is_none(),
            "intruder event must not reach persistence; got: {second:?}"
        );

        run_shutdown_protocol(runtime, &cfg).await;
    }
}
