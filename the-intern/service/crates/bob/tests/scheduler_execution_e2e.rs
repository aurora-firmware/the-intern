// End-to-end tests for the scheduled prompt execution path.
//
// Each test assembles the full subsystem pipeline using public crate APIs:
//   scheduler-adapter → requests-handler (ADR-012 bypass) → persistence →
//   periodic-dispatcher → pi-agent-supervisor (fake sh worker)
//
// `tokio::time::pause()` + `advance()` is used to trigger the scheduler's
// cron tick immediately without waiting for a real wall-clock minute boundary.
// IO-driven operations (subprocess stdio, file writes) complete in real time
// even with tokio time paused; the polling loops use `advance()` to keep the
// dispatcher's idle sleep from blocking.
//
// Admission model (ADR-012 / T-117):
//   Periodic events bypass pre-flight UserId admission checks entirely.
//   The trusted JSON schedule store (`schedules.json`) is the admission gate.
//   An empty [policy].admitted_users list therefore does not block scheduled
//   prompt delivery. Every resulting tool_call still uses S-004 action authz.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

use bob_core::{
    ports::{AuditSink, PersistenceStore},
    types::{
        AuditRecord, AuditRecordKind, AuditRecordPayload, DeliveryKind, ExtensionEventAuditPayload,
        ExternalReportAuditPayload, ReportOutcome, ScheduleEntry, SessionId,
    },
};

// Interval used by the inline dispatcher for idle-queue back-off.
// Must be shorter than the scheduler's minimum 60-second wait so the
// dispatcher does not hold up test shutdown.
const DISPATCHER_POLL_INTERVAL: Duration = Duration::from_millis(100);

fn current_exe_path() -> std::path::PathBuf {
    std::env::current_exe().expect("test executable must exist")
}

// ── T-127: per-entry cwd resolution, replicated for the e2e dispatcher ─────
//
// `serve::resolve_periodic_cwd` and `serve::PeriodicCwdResolution` are private
// to the `bob` crate, so this e2e suite replicates them using only public
// `bob-core` types (same approach as `start_inline_dispatcher` below).

/// Resolution of a periodic fire's working directory against the live
/// schedule table, mirroring `serve::PeriodicCwdResolution` (T-127).
#[derive(Debug, Clone, PartialEq, Eq)]
enum PeriodicCwdResolution {
    /// The job id resolved to a live entry with a per-entry `cwd`.
    PerEntry(std::path::PathBuf),
    /// The job id resolved to a live entry with no per-entry `cwd`, or no job
    /// id was carried with this fire.
    ServiceDefault,
    /// The job id did not resolve to any live entry.
    EntryNotFound,
}

/// Resolves the working directory for one periodic fire from the live
/// schedule table, mirroring `serve::resolve_periodic_cwd` (T-127).
fn resolve_periodic_cwd(
    job_id: Option<&str>,
    live_entries: &[ScheduleEntry],
) -> PeriodicCwdResolution {
    let Some(job_id) = job_id else {
        return PeriodicCwdResolution::ServiceDefault;
    };

    match live_entries.iter().find(|entry| entry.id == job_id) {
        Some(entry) => match &entry.cwd {
            Some(cwd) => PeriodicCwdResolution::PerEntry(std::path::PathBuf::from(cwd)),
            None => PeriodicCwdResolution::ServiceDefault,
        },
        None => PeriodicCwdResolution::EntryNotFound,
    }
}

/// Appends a monitoring failure record for a periodic fire skipped because
/// its resolved per-entry `cwd` does not exist at fire time (AC-2, T-130),
/// mirroring `serve::record_periodic_fire_skipped` (T-127).
async fn record_periodic_fire_skipped(
    audit: &dyn AuditSink,
    job_id: Option<&str>,
    summary: String,
) {
    let record = AuditRecord {
        id: format!("e2e_audit_periodic_fire_skipped_{}", SessionId::new()),
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

    let _ = audit.append(record).await;
}

/// Appends an `event`-kind audit record for a periodic firing that reached
/// dispatch, carrying the concrete resolved absolute working directory used
/// for the firing (AC-3, T-130), mirroring `serve::record_periodic_fire_dispatched`
/// (T-128).
async fn record_periodic_fire_dispatched(
    audit: &dyn AuditSink,
    session_id: SessionId,
    job_id: Option<&str>,
    resolved_cwd: Option<std::path::PathBuf>,
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
        id: format!("e2e_audit_periodic_fire_dispatched_{}", SessionId::new()),
        timestamp: chrono::Utc::now().to_rfc3339(),
        kind: AuditRecordKind::Event,
        session_id: Some(session_id),
        payload: AuditRecordPayload::Event(ExtensionEventAuditPayload {
            name: "scheduler.periodic_fire_dispatched".to_owned(),
            summary: Some(summary),
            resolved_cwd,
        }),
    };

    let _ = audit.append(record).await;
}

/// An in-memory `AuditSink` spy so e2e tests can assert on the exact audit
/// records the dispatcher appends (AC-2's skip record, AC-3's resolved-cwd
/// event record) without depending on the real monitoring actor's JSONL log.
#[derive(Default)]
struct SpyAuditSink {
    records: std::sync::Mutex<Vec<AuditRecord>>,
}

impl SpyAuditSink {
    fn records(&self) -> Vec<AuditRecord> {
        self.records.lock().expect("records lock").clone()
    }
}

#[async_trait::async_trait]
impl AuditSink for SpyAuditSink {
    async fn append(&self, record: AuditRecord) -> bob_core::error::ServiceResult<()> {
        self.records.lock().expect("records lock").push(record);
        Ok(())
    }
}

// Replicates `serve::start_periodic_dispatcher` using only public crate APIs.
//
// The production function lives in `bob/src/serve.rs` (private). This inline
// version is identical in behaviour and serves as the dispatcher under test for
// the e2e path.
//
// T-130: `schedule_entries_rx` observes the live schedule table (via
// `scheduler_adapter::ReloadHandle::subscribe`) so each fire's working
// directory can be resolved by job id (`resolve_periodic_cwd`), and
// `audit_sink` receives the skip/dispatched audit records the production
// dispatcher appends (T-127/T-128).
fn start_inline_dispatcher(
    persistence: persistence::Handle,
    supervisor: pi_agent_supervisor::Handle,
    schedule_entries_rx: watch::Receiver<Vec<ScheduleEntry>>,
    audit_sink: Arc<dyn AuditSink>,
    mut cancel_rx: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if *cancel_rx.borrow() {
                break;
            }

            match persistence.dequeue_next_with_job_id().await {
                Err(_) => {
                    tokio::select! {
                        _ = tokio::time::sleep(DISPATCHER_POLL_INTERVAL) => {}
                        _ = cancel_rx.changed() => {}
                    }
                }
                Ok(None) => {
                    tokio::select! {
                        _ = tokio::time::sleep(DISPATCHER_POLL_INTERVAL) => {}
                        _ = cancel_rx.changed() => {}
                    }
                }
                Ok(Some((event, _job_id))) if event.kind != DeliveryKind::Periodic => {
                    // Re-enqueue non-periodic events so they are not lost.
                    let _ = persistence.enqueue(event).await;
                    tokio::select! {
                        _ = tokio::time::sleep(DISPATCHER_POLL_INTERVAL) => {}
                        _ = cancel_rx.changed() => {}
                    }
                }
                Ok(Some((event, job_id))) => {
                    // Admitted Periodic event: resolve this fire's working
                    // directory from the live schedule table (T-127
                    // precedence: per-entry `cwd` -> service default ->
                    // inherited launch cwd) before acquiring a session.
                    let live_entries = schedule_entries_rx.borrow().clone();
                    let resolution = resolve_periodic_cwd(job_id.as_deref(), &live_entries);

                    let (session_id, resolved_cwd) = match resolution {
                        PeriodicCwdResolution::PerEntry(cwd) => {
                            if !cwd.exists() {
                                // AC-2 (T-130): the resolved per-entry cwd
                                // does not exist at fire time. Skip this fire
                                // (it fires again next tick) with a
                                // monitoring failure record; the schedule
                                // entry itself is left untouched.
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
                                Err(_) => continue,
                            }
                        }
                        PeriodicCwdResolution::ServiceDefault
                        | PeriodicCwdResolution::EntryNotFound => {
                            match supervisor.acquire_session().await {
                                Ok(id) => (id, None),
                                Err(_) => continue,
                            }
                        }
                    };

                    // AC-3 (T-130): record the resolved absolute working
                    // directory used for this dispatched fire before
                    // forwarding the prompt.
                    record_periodic_fire_dispatched(
                        audit_sink.as_ref(),
                        session_id,
                        job_id.as_deref(),
                        resolved_cwd,
                    )
                    .await;

                    let _ = supervisor.send_prompt(session_id, event.payload).await;
                }
            }
        }
    })
}

// ── AC-4 (T-116) ─────────────────────────────────────────────────────────────

/// AC-4 (T-116): WHEN the scheduler execution e2e test runs with a valid JSON
/// schedule entry and empty `[policy].admitted_users` THE SYSTEM SHALL deliver
/// the scheduled prompt to the fake pi-agent worker.
///
/// This test covers the ADR-012 / T-117 trust model: Periodic events bypass
/// pre-flight UserId admission checks and are directly enqueued, so an empty
/// `admitted_users` list does not block scheduled prompt delivery.
///
/// The schedule entry is written to a `schedules.json` file and read back via
/// `read_schedule_store`, matching the production startup path from T-113 /
/// T-114. The requests-handler closure used here replicates the production
/// logic from `serve.rs`: Periodic events bypass `run_preflight` entirely.
///
/// The delivered prompt must equal the JSON store entry's prompt byte-for-byte.
#[tokio::test(flavor = "current_thread")]
async fn schedule_entry_from_json_store_is_delivered_when_admitted_users_is_empty() {
    tokio::time::pause();

    let tmp = tempfile::tempdir().expect("temp dir");
    let record_file = tmp.path().join("received_prompt.txt");
    let record_file_str = record_file.to_string_lossy().into_owned();

    // Exact prompt value — assert byte-for-byte equality at the end.
    let expected_prompt = "e2e-scheduled-prompt-json-store-ac4";
    let job_id = "e2e-scheduler-json-store-job";

    // Write the schedule entry to a JSON store, then read it back.
    // This mirrors what BobConfig::load_with_sources does at startup (T-114).
    let store_path = tmp.path().join("schedules.json");
    bob_core::types::schedule::write_schedule_store(
        &store_path,
        &[ScheduleEntry::with_prompt(
            job_id.to_string(),
            "* * * * *".to_string(),
            expected_prompt.to_string(),
        )],
    )
    .expect("JSON schedule store write must succeed");
    let entries = bob_core::types::schedule::read_schedule_store(&store_path)
        .expect("JSON schedule store read must succeed");
    assert_eq!(
        entries.len(),
        1,
        "one schedule entry must be loaded from the JSON store"
    );

    // Fake pi-agent RPC worker: reads one JSON-RPC request, writes the
    // `message` field to a file (byte-for-byte), and responds with success.
    let worker_script = format!(
        "while IFS= read -r line; do \
         id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
         msg=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"message\":\"\\([^\"]*\\)\".*/\\1/p'); \
         printf '%s' \"$msg\" > \"{dst}\"; \
         printf '{{\"id\":\"%s\",\"type\":\"response\",\"success\":true}}\\n' \"$id\"; \
         done",
        dst = record_file_str
    );

    // ── Monitoring ────────────────────────────────────────────────────────────
    let audit_log = tmp.path().join("audit.jsonl");
    let (monitoring_handle, monitoring_join) = monitoring::start(monitoring::Config {
        command_buffer: 16,
        audit_log_path: audit_log,
    });

    // ── Persistence ───────────────────────────────────────────────────────────
    let (persistence_handle, persistence_join) = persistence::start(persistence::Config::default());

    // ── Policy: EMPTY admitted_users ──────────────────────────────────────────
    // Periodic events bypass pre-flight, so an empty admitted_users list must
    // not block delivery.
    let policy_cfg = policy_control::PolicyConfig::default(); // no admitted users
    let initial_snapshot = policy_control::RulesetSnapshot::from_config(policy_cfg)
        .expect("empty (deny-all) policy config is always valid");
    let (_, policy_join, policy_snapshot) = policy_control::start(policy_control::Config {
        initial_snapshot,
        config_path: std::path::PathBuf::new(),
        command_buffer: 16,
    });

    // ── Pi-agent supervisor with fake sh worker ───────────────────────────────
    let (supervisor_handle, supervisor_join) =
        pi_agent_supervisor::start(pi_agent_supervisor::Config {
            worker_command: "sh".to_string(),
            worker_args: vec!["-c".to_string(), worker_script],
            warm_pool_size: 1,
            max_processes: 2,
            idle_reap_timeout: Duration::from_secs(300),
            command_buffer: 16,
            child_termination_deadline: Duration::from_millis(500),
            extension_sock_path: std::path::PathBuf::new(),
            extension_path: current_exe_path(),
            worker_cwd: None,
        })
        .expect("pi-agent supervisor must start with fake worker");

    // ── Requests handler (production-like: Periodic bypasses pre-flight) ──────
    //
    // Replicates the production closure from `serve.rs` (ADR-012 / T-117):
    // - Periodic events are directly enqueued without UserId admission checks.
    // - Non-Periodic events continue to go through run_preflight.
    let persistence_arc: Arc<dyn PersistenceStore> = Arc::new(persistence_handle.clone());
    let audit_arc: Arc<dyn AuditSink> = Arc::new(monitoring::MonitoringAuditSink::new(
        monitoring_handle.clone(),
    ));
    // T-127/T-128: a separate clone for the periodic dispatcher's own audit
    // writes, taken before `audit_arc` is moved into the pre-flight closure.
    let periodic_dispatch_audit_sink = Arc::clone(&audit_arc);
    let snap_for_preflight = policy_snapshot.clone();

    let (rh_cancel_tx, rh_cancel_rx) = watch::channel(false);
    let (requests_handle, requests_join) = requests_handler::start_with(
        requests_handler::Config {
            request_queue_capacity: 16,
            request_submit_timeout: Duration::from_secs(5),
        },
        move |(event, context)| {
            let store = Arc::clone(&persistence_arc);
            let audit = Arc::clone(&audit_arc);
            let snap = snap_for_preflight.clone();
            async move {
                if event.kind == DeliveryKind::Periodic {
                    // ADR-012/ADR-013: Periodic events bypass pre-flight and
                    // carry their job-id correlator (RequestContext::context_id,
                    // set by scheduler-adapter) through to the queue so the
                    // dispatcher can resolve the live schedule entry by id.
                    let _ = store
                        .enqueue_with_job_id(event, context.context_id.clone())
                        .await;
                } else {
                    requests_handler::run_preflight(
                        event,
                        Some(&context),
                        &snap,
                        store.as_ref(),
                        audit.as_ref(),
                    )
                    .await;
                }
            }
        },
        rh_cancel_rx,
    );

    // ── Scheduler adapter: entries from the JSON store ────────────────────────
    let (scheduler_handle, scheduler_join) = scheduler_adapter::start(
        requests_handle.clone(),
        entries, // loaded from schedules.json above
    );

    // ── Inline periodic dispatcher ────────────────────────────────────────────
    let (dispatcher_cancel_tx, dispatcher_cancel_rx) = watch::channel(false);
    let dispatcher_join = start_inline_dispatcher(
        persistence_handle.clone(),
        supervisor_handle.clone(),
        scheduler_handle.subscribe(),
        periodic_dispatch_audit_sink,
        dispatcher_cancel_rx,
    );

    // ── Drive the e2e flow via tokio time ─────────────────────────────────────

    // Yield to let all actors start and register their initial timers.
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }

    // Advance 61 s: the `* * * * *` cron sleep (≤60 s) elapses and the
    // scheduler task wakes up, submitting a Periodic event to the requests
    // handler.  The handler bypasses pre-flight and enqueues directly.
    tokio::time::advance(Duration::from_secs(61)).await;

    // Let the scheduler, requests-handler, and persistence actor process.
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }

    // Advance 200 ms: the dispatcher's DISPATCHER_POLL_INTERVAL (100 ms) sleep
    // elapses, waking the dispatcher to dequeue and forward the event.
    tokio::time::advance(Duration::from_millis(200)).await;

    // Give the dispatcher enough task-yield slices to reach send_prompt() before
    // we resume real time.
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    // Resume real time so the IO reactor can detect child stdout readability
    // via epoll and the OS can schedule the sh child process.
    tokio::time::resume();

    // Poll for the record file using real-time delays.  The sh child is already
    // running (warm pool); once it processes the JSON-RPC request it writes the
    // prompt to the file in microseconds.  5 s of real time is ample.
    let mut delivered = false;
    let poll_deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < poll_deadline {
        if record_file.exists() {
            let content = std::fs::read_to_string(&record_file).unwrap_or_default();
            if content == expected_prompt {
                delivered = true;
                break;
            }
        }
        // Real 50 ms sleep: parks the runtime so the IO reactor can process
        // the child's stdout pipe event and the OS can schedule the child.
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    assert!(
        delivered,
        "scheduler prompt from JSON store must be delivered to the fake pi-agent worker \
         with empty admitted_users (ADR-012 bypass)"
    );

    // Assert byte-for-byte equality of the delivered prompt.
    let delivered_prompt =
        std::fs::read_to_string(&record_file).expect("record file must be readable");
    assert_eq!(
        delivered_prompt, expected_prompt,
        "delivered prompt must equal the JSON store entry prompt byte-for-byte"
    );

    // ── Teardown ──────────────────────────────────────────────────────────────
    let _ = dispatcher_cancel_tx.send(true);
    let _ = rh_cancel_tx.send(true);
    drop(scheduler_handle);
    drop(supervisor_handle);
    drop(requests_handle);
    drop(monitoring_handle);
    drop(persistence_handle);
    drop(policy_snapshot);

    let _ = tokio::time::timeout(Duration::from_millis(500), dispatcher_join).await;
    let _ = tokio::time::timeout(Duration::from_millis(500), scheduler_join).await;
    let _ = supervisor_join.await;
    let _ = tokio::time::timeout(Duration::from_millis(500), requests_join).await;
    let _ = tokio::time::timeout(Duration::from_millis(500), monitoring_join).await;
    let _ = tokio::time::timeout(Duration::from_millis(500), persistence_join).await;
    let _ = tokio::time::timeout(Duration::from_millis(500), policy_join).await;
}

// ── T-130: per-entry cwd end-to-end coverage ───────────────────────────────
//
// The tests below extend the pipeline above (scheduler-adapter → requests-
// handler → persistence → periodic-dispatcher → pi-agent-supervisor) to
// cover the per-entry `cwd` path (T-118/T-127/T-128) end to end: a live
// schedule entry carrying a `cwd`, resolved via the same job-id correlator
// (ADR-013) and live-table lookup the production dispatcher uses.

// AC-1 (T-130): WHEN a scheduled entry with a per-entry `cwd` fires THE
// SYSTEM SHALL run the pi session with that directory as its working
// directory. The configured service-wide `worker_cwd` is deliberately set to
// a *different* directory here so a passing test proves the per-entry `cwd`
// takes precedence, not just that some cwd was applied.
#[tokio::test(flavor = "current_thread")]
async fn scheduled_entry_with_per_entry_cwd_runs_pi_session_in_that_directory_honouring_precedence()
{
    tokio::time::pause();

    let tmp = tempfile::tempdir().expect("temp dir");
    let job_id = "e2e-per-entry-cwd-job";
    let per_entry_cwd = tmp.path().join("per-entry-cwd");
    std::fs::create_dir_all(&per_entry_cwd).expect("create per-entry cwd");
    let configured_default_cwd = tmp.path().join("configured-default-cwd");
    std::fs::create_dir_all(&configured_default_cwd).expect("create configured default cwd");

    let store_path = tmp.path().join("schedules.json");
    bob_core::types::schedule::write_schedule_store(
        &store_path,
        &[ScheduleEntry::with_prompt(
            job_id.to_string(),
            "* * * * *".to_string(),
            "e2e-scheduled-prompt-per-entry-cwd".to_string(),
        )
        .with_cwd(per_entry_cwd.to_string_lossy().into_owned())],
    )
    .expect("JSON schedule store write must succeed");
    let entries = bob_core::types::schedule::read_schedule_store(&store_path)
        .expect("JSON schedule store read must succeed");

    // Fake pi-agent RPC worker: writes its actual working directory to a
    // relative `marker.txt` (so it lands wherever the child actually runs),
    // then acknowledges the one JSON-RPC request it receives.
    let worker_script = "pwd > marker.txt; while IFS= read -r line; do \
         id=$(printf '%s\\n' \"$line\" | sed -n 's/.*\"id\":\"\\([^\"]*\\)\".*/\\1/p'); \
         printf '{\"id\":\"%s\",\"type\":\"response\",\"success\":true}\\n' \"$id\"; \
         done"
        .to_string();

    let (monitoring_handle, monitoring_join) = monitoring::start(monitoring::Config {
        command_buffer: 16,
        audit_log_path: tmp.path().join("audit.jsonl"),
    });

    let (persistence_handle, persistence_join) = persistence::start(persistence::Config::default());

    let policy_cfg = policy_control::PolicyConfig::default();
    let initial_snapshot = policy_control::RulesetSnapshot::from_config(policy_cfg)
        .expect("empty (deny-all) policy config is always valid");
    let (_, policy_join, policy_snapshot) = policy_control::start(policy_control::Config {
        initial_snapshot,
        config_path: std::path::PathBuf::new(),
        command_buffer: 16,
    });

    // warm_pool_size: 0 — a warm worker would run worker_script too but
    // inherit the configured default cwd instead of the per-entry cwd,
    // writing a stray marker.txt that would mask a precedence regression.
    let (supervisor_handle, supervisor_join) =
        pi_agent_supervisor::start(pi_agent_supervisor::Config {
            worker_command: "sh".to_string(),
            worker_args: vec!["-c".to_string(), worker_script],
            warm_pool_size: 0,
            max_processes: 2,
            idle_reap_timeout: Duration::from_secs(300),
            command_buffer: 16,
            child_termination_deadline: Duration::from_millis(500),
            extension_sock_path: std::path::PathBuf::new(),
            extension_path: current_exe_path(),
            worker_cwd: Some(configured_default_cwd.clone()),
        })
        .expect("pi-agent supervisor must start with fake worker");

    let persistence_arc: Arc<dyn PersistenceStore> = Arc::new(persistence_handle.clone());
    let audit_arc: Arc<dyn AuditSink> = Arc::new(monitoring::MonitoringAuditSink::new(
        monitoring_handle.clone(),
    ));
    // T-127/T-128: a separate clone for the periodic dispatcher's own audit
    // writes, taken before `audit_arc` is moved into the pre-flight closure.
    let periodic_dispatch_audit_sink = Arc::clone(&audit_arc);
    let snap_for_preflight = policy_snapshot.clone();

    let (rh_cancel_tx, rh_cancel_rx) = watch::channel(false);
    let (requests_handle, requests_join) = requests_handler::start_with(
        requests_handler::Config {
            request_queue_capacity: 16,
            request_submit_timeout: Duration::from_secs(5),
        },
        move |(event, context)| {
            let store = Arc::clone(&persistence_arc);
            let audit = Arc::clone(&audit_arc);
            let snap = snap_for_preflight.clone();
            async move {
                if event.kind == DeliveryKind::Periodic {
                    // ADR-012/ADR-013: Periodic events bypass pre-flight and
                    // carry their job-id correlator (RequestContext::context_id,
                    // set by scheduler-adapter) through to the queue so the
                    // dispatcher can resolve the live schedule entry by id.
                    let _ = store
                        .enqueue_with_job_id(event, context.context_id.clone())
                        .await;
                } else {
                    requests_handler::run_preflight(
                        event,
                        Some(&context),
                        &snap,
                        store.as_ref(),
                        audit.as_ref(),
                    )
                    .await;
                }
            }
        },
        rh_cancel_rx,
    );

    let (scheduler_handle, scheduler_join) =
        scheduler_adapter::start(requests_handle.clone(), entries);

    let (dispatcher_cancel_tx, dispatcher_cancel_rx) = watch::channel(false);
    let dispatcher_join = start_inline_dispatcher(
        persistence_handle.clone(),
        supervisor_handle.clone(),
        scheduler_handle.subscribe(),
        periodic_dispatch_audit_sink,
        dispatcher_cancel_rx,
    );

    for _ in 0..8 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_secs(61)).await;
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }
    tokio::time::advance(Duration::from_millis(200)).await;
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }
    tokio::time::resume();

    let marker_path = per_entry_cwd.join("marker.txt");
    let mut delivered = false;
    let poll_deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < poll_deadline {
        if marker_path.exists() {
            delivered = true;
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    assert!(
        delivered,
        "scheduled fire with a per-entry cwd must run the pi session in that directory"
    );

    let contents = std::fs::read_to_string(&marker_path).expect("read marker file");
    let actual_cwd =
        std::fs::canonicalize(contents.trim()).expect("canonicalize actual reported cwd");
    let expected_cwd =
        std::fs::canonicalize(&per_entry_cwd).expect("canonicalize expected per-entry cwd");
    assert_eq!(
        actual_cwd, expected_cwd,
        "the per-entry cwd must take precedence over the configured service-wide default cwd"
    );

    // ── Teardown ──────────────────────────────────────────────────────────────
    let _ = dispatcher_cancel_tx.send(true);
    let _ = rh_cancel_tx.send(true);
    drop(scheduler_handle);
    drop(supervisor_handle);
    drop(requests_handle);
    drop(monitoring_handle);
    drop(persistence_handle);
    drop(policy_snapshot);

    let _ = tokio::time::timeout(Duration::from_millis(500), dispatcher_join).await;
    let _ = tokio::time::timeout(Duration::from_millis(500), scheduler_join).await;
    let _ = supervisor_join.await;
    let _ = tokio::time::timeout(Duration::from_millis(500), requests_join).await;
    let _ = tokio::time::timeout(Duration::from_millis(500), monitoring_join).await;
    let _ = tokio::time::timeout(Duration::from_millis(500), persistence_join).await;
    let _ = tokio::time::timeout(Duration::from_millis(500), policy_join).await;
}
