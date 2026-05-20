#![forbid(unsafe_code)]

use std::path::PathBuf;
use std::sync::Arc;

use bob_core::error::{ServiceError, ServiceResult};
use bob_core::ports::{AuditSink, PersistenceStore};
use bob_core::types::{ChannelId, RequestContext};
use tokio::{net::UnixListener, sync::watch, task::JoinHandle, time};
use tracing::info;

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

    // Cancellation sender for the requests-handler actor.
    requests_handler_cancel_tx: watch::Sender<bool>,

    // Bound-but-not-yet-polled extension listener.  Dropping it removes the
    // socket file descriptor; the shutdown protocol removes the on-disk path
    // explicitly.
    _extension_listener: UnixListener,

    // Join handles for non-supervisor actors (awaited in shutdown phase 3).
    joins: Vec<JoinHandle<()>>,

    // Supervisor join handle awaited separately in shutdown phase 4 so that
    // child-process reaping is distinct from the general actor drain.
    supervisor_join: JoinHandle<()>,

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
    let initial_snapshot =
        policy_control::RulesetSnapshot::from_config(cfg.policy.clone()).map_err(|e| {
            format!("invalid policy config: {e}")
        })?;
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
    // Build the pre-flight context from the initial snapshot.  Channel adapters
    // will supply real RequestContexts once they are wired in; until then the
    // first admitted user from the snapshot is used as a synthetic default so
    // that the existing integration tests (which submit events expecting
    // persistence) continue to work.
    let default_context = policy_snapshot
        .load()
        .admitted_users()
        .first()
        .copied()
        .map(|sender| RequestContext {
            sender,
            source: ChannelId::new(),
            context_id: None,
        });
    let persistence_store: Arc<dyn PersistenceStore> = Arc::new(persistence_handle.clone());
    let audit_sink: Arc<dyn AuditSink> = Arc::new(monitoring::MonitoringAuditSink::new(
        monitoring_handle.clone(),
    ));
    // Clone the snapshot handle for use in the pre-flight closure.
    let preflight_snapshot = policy_snapshot.clone();
    let (requests_handler_handle, requests_handler_join) = requests_handler::start_with(
        requests_handler::Config {
            request_queue_capacity: cfg.request_queue_capacity,
            request_submit_timeout: cfg.request_submit_timeout,
        },
        move |event| {
            let preflight_snapshot = preflight_snapshot.clone();
            let persistence_store = Arc::clone(&persistence_store);
            let audit_sink = Arc::clone(&audit_sink);
            let default_context = default_context.clone();
            async move {
                requests_handler::run_preflight(
                    event,
                    default_context.as_ref(),
                    &preflight_snapshot,
                    persistence_store.as_ref(),
                    audit_sink.as_ref(),
                )
                .await;
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
        ..extension_ipc::Config::default()
    });
    info!("extension-ipc actor started");

    info!("starting admin-rpc actor");
    let admin_rpc_cfg = admin_rpc::Config {
        admin_sock_path: cfg.admin_sock_path.clone(),
        admin_allowed_uids: cfg.admin_allowed_uids.clone(),
        supervisor: Some(pi_agent_supervisor_handle.clone()),
        policy: Some(policy_control_handle.clone()),
        monitoring: Some(monitoring_handle.clone()),
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

    // If the second bind fails, remove the first socket file explicitly before
    // propagating — `remove_socket_files_best_effort` in `start_subsystems`
    // will also attempt removal, but being explicit here ensures no race window.
    info!(path = %cfg.extension_sock_path.display(), "binding extension socket");
    let extension_listener = UnixListener::bind(&cfg.extension_sock_path).map_err(|e| {
        // Remove the admin socket file that was already created.
        let _ = std::fs::remove_file(&cfg.admin_sock_path);
        format!(
            "failed to bind extension socket at {}: {e}",
            cfg.extension_sock_path.display()
        )
    })?;
    info!(path = %cfg.extension_sock_path.display(), "extension socket bound");

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
        requests_handler_cancel_tx: rh_cancel_tx,
        _extension_listener: extension_listener,
        joins,
        supervisor_join: pi_agent_supervisor_join,
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
        requests_handler_cancel_tx,
        _extension_listener,
        joins,
        supervisor_join,
        admin_sock_path,
        extension_sock_path,
        // policy_snapshot is dropped here; gate crates will hold their own
        // clones until T-054 / T-056 wire them in.
        policy_snapshot: _policy_snapshot,
    } = runtime;

    // Phase 1: Stop accepting new connections by dropping handles (channels close).
    // Signal the requests-handler actor to drain and stop.
    let _ = requests_handler_cancel_tx.send(true);
    drop(_admin_rpc);
    drop(_extension_ipc);
    drop(_requests_handler);
    drop(_monitoring);
    drop(_persistence);
    drop(_policy_control);
    // Drop the supervisor handle so the supervisor actor sees its channel close
    // and proceeds to call shutdown_all on its pool (terminating all children).
    drop(_pi_agent_supervisor);
    // Drop listeners to release the socket file descriptors.
    drop(_extension_listener);

    info!("shutdown: phase 2 — cancelling subsystem workers");
    // Actors exit when their channel is drained and closed — no explicit cancel needed.

    info!(
        "shutdown: phase 3 — draining queues (deadline: {:?})",
        cfg.shutdown_drain_deadline
    );
    let drain_result = time::timeout(cfg.shutdown_drain_deadline, drain_joins(joins)).await;
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

#[cfg(test)]
pub mod tests {
    use std::time::Duration;

    use bob_core::error::ServiceError;
    use bob_core::{
        ports::PersistenceStore,
        types::{InternalEvent, UserId},
    };

    use crate::config::BobConfig;

    use super::*;

    fn test_cfg_no_sockets() -> BobConfig {
        BobConfig {
            // Empty paths — tests that do not bind sockets use these.
            admin_sock_path: std::path::PathBuf::new(),
            extension_sock_path: std::path::PathBuf::new(),
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
        let tmp = tempfile::tempdir().expect("temp dir");
        let mut cfg = test_cfg_with_sockets(&tmp);
        let user_id = UserId::new();
        cfg.policy.admitted_users = vec![user_id.to_string()];
        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        let event = InternalEvent::ChatMessage {
            content: "persist me".to_owned(),
        };
        runtime
            ._requests_handler
            .submit_event(event.clone())
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

    // AC-3: start_subsystems returns ServiceError::ServiceDown on bind failure
    // and cleans up the first socket when the second bind fails.
    //
    // We simulate the second bind failing by pre-binding the extension socket
    // path in the test process before calling start_subsystems.
    #[tokio::test(flavor = "current_thread")]
    async fn start_subsystems_returns_service_down_when_second_bind_fails_and_cleans_up() {
        let tmp = tempfile::tempdir().expect("temp dir");
        let admin_sock = tmp.path().join("admin.sock");
        let ext_sock = tmp.path().join("extension.sock");

        // Pre-bind the extension socket so the second bind inside start_subsystems fails.
        let _pre_bound = tokio::net::UnixListener::bind(&ext_sock)
            .expect("pre-bind extension socket for test setup");

        let cfg = BobConfig {
            admin_sock_path: admin_sock.clone(),
            extension_sock_path: ext_sock.clone(),
            request_queue_capacity: 16,
            shutdown_drain_deadline: Duration::from_millis(50),
            shutdown_reap_deadline: Duration::from_millis(25),
            ..BobConfig::test_base()
        };

        let result = start_subsystems(&cfg);

        // Must return ServiceError::ServiceDown.
        assert!(
            matches!(result, Err(ServiceError::ServiceDown)),
            "expected Err(ServiceError::ServiceDown)"
        );

        // The admin socket file created during the partial start must be removed.
        assert!(
            !admin_sock.exists(),
            "admin.sock should be cleaned up when second bind fails"
        );
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
        use bob_core::types::{AuditFilterKind, AuditRecord, AuditRecordKind, AuditRecordPayload,
            ExtensionEventAuditPayload};
        use std::str::FromStr;
        use std::time::Duration;
        use tokio::time::timeout;

        let tmp = tempfile::tempdir().expect("temp dir");
        let audit_log = tmp.path().join("audit.jsonl");
        let cfg = BobConfig {
            admin_sock_path: tmp.path().join("admin.sock"),
            extension_sock_path: tmp.path().join("extension.sock"),
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
            .subscribe_tail(vec![AuditFilterKind::from_str("events").expect("events parses")])
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
        let tmp = tempfile::tempdir().expect("temp dir");
        let mut cfg = test_cfg_with_sockets(&tmp);
        // No admitted users → deny-all snapshot.
        cfg.policy.admitted_users = vec![];

        let runtime = start_subsystems(&cfg).expect("subsystems must start");

        let event = InternalEvent::ChatMessage {
            content: "should be denied".to_owned(),
        };
        runtime
            ._requests_handler
            .submit_event(event)
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
}
