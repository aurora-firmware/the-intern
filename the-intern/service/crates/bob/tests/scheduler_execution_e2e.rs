// End-to-end tests for the scheduled prompt execution path.
//
// Each test assembles the full subsystem pipeline using public crate APIs:
//   scheduler-adapter → requests-handler (pre-flight) → persistence →
//   periodic-dispatcher → pi-agent-supervisor (fake sh worker)
//
// `tokio::time::pause()` + `advance()` is used to trigger the scheduler's
// cron tick immediately without waiting for a real wall-clock minute boundary.
// IO-driven operations (subprocess stdio, file writes) complete in real time
// even with tokio time paused; the polling loops use `advance()` to keep the
// dispatcher's idle sleep from blocking.

#![forbid(unsafe_code)]

use std::sync::Arc;
use std::time::Duration;
use tokio::sync::watch;

use bob_core::{
    ports::{AuditSink, PersistenceStore},
    types::{AuditFilterKind, AuditRecordPayload, DeliveryKind, ScheduleEntry, UserId},
};

// Interval used by the inline dispatcher for idle-queue back-off.
// Must be shorter than the scheduler's minimum 60-second wait so the
// dispatcher does not hold up test shutdown.
const DISPATCHER_POLL_INTERVAL: Duration = Duration::from_millis(100);

fn current_exe_path() -> std::path::PathBuf {
    std::env::current_exe().expect("test executable must exist")
}

// Replicates `serve::start_periodic_dispatcher` using only public crate APIs.
//
// The production function lives in `bob/src/serve.rs` (private). This inline
// version is identical in behaviour and serves as the dispatcher under test for
// the e2e path.
fn start_inline_dispatcher(
    persistence: persistence::Handle,
    supervisor: pi_agent_supervisor::Handle,
    mut cancel_rx: watch::Receiver<bool>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        loop {
            if *cancel_rx.borrow() {
                break;
            }

            match persistence.dequeue_next().await {
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
                Ok(Some(event)) if event.kind != DeliveryKind::Periodic => {
                    // Re-enqueue non-periodic events so they are not lost.
                    let _ = persistence.enqueue(event).await;
                    tokio::select! {
                        _ = tokio::time::sleep(DISPATCHER_POLL_INTERVAL) => {}
                        _ = cancel_rx.changed() => {}
                    }
                }
                Ok(Some(event)) => {
                    // Admitted Periodic event: acquire a session and forward the prompt.
                    match supervisor.acquire_session().await {
                        Ok(session_id) => {
                            let _ = supervisor.send_prompt(session_id, event.payload).await;
                        }
                        Err(_) => {}
                    }
                }
            }
        }
    })
}

// ── AC-1, AC-2, AC-4 ─────────────────────────────────────────────────────────

/// AC-1: WHEN `bob serve` starts with a valid due `[[schedule]]` entry and an
///       admitted scheduler-derived `UserId` THE SYSTEM SHALL deliver the
///       entry's prompt to a pi-agent RPC worker.
///
/// AC-2: The delivered prompt equals the `[[schedule]].prompt` string
///       byte-for-byte.
///
/// AC-4: No real external `pi` binary is required — a fake `sh` script acts
///       as the pi-agent RPC worker.
#[tokio::test(flavor = "current_thread")]
async fn schedule_entry_prompt_is_delivered_to_pi_agent_when_scheduler_user_is_admitted() {
    tokio::time::pause();

    let tmp = tempfile::tempdir().expect("temp dir");
    let record_file = tmp.path().join("received_prompt.txt");
    let record_file_str = record_file.to_string_lossy().into_owned();

    // Exact prompt value — AC-2 asserts byte-for-byte equality.
    let expected_prompt = "e2e-scheduled-prompt-ac1-ac2";
    let job_id = "e2e-scheduler-job-admitted";

    // The scheduler derives identities deterministically from the job id.
    // We admit exactly this user so pre-flight passes.
    let scheduler_user_id = UserId::from_name(job_id);

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

    // ── Policy: admit the scheduler-derived UserId ────────────────────────────
    let mut policy_cfg = policy_control::PolicyConfig::default();
    policy_cfg.admitted_users = vec![scheduler_user_id.to_string()];
    let initial_snapshot =
        policy_control::RulesetSnapshot::from_config(policy_cfg).expect("valid policy config");
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
        })
        .expect("pi-agent supervisor must start with fake worker");

    // ── Requests handler with pre-flight gate ─────────────────────────────────
    let persistence_arc: Arc<dyn PersistenceStore> = Arc::new(persistence_handle.clone());
    let audit_arc: Arc<dyn AuditSink> = Arc::new(monitoring::MonitoringAuditSink::new(
        monitoring_handle.clone(),
    ));
    let snap_for_preflight = policy_snapshot.clone();

    let (rh_cancel_tx, rh_cancel_rx) = watch::channel(false);
    let (requests_handle, requests_join) = requests_handler::start_with(
        requests_handler::Config {
            request_queue_capacity: 16,
            request_submit_timeout: Duration::from_secs(5),
        },
        move |(event, context)| {
            let snap = snap_for_preflight.clone();
            let store = Arc::clone(&persistence_arc);
            let audit = Arc::clone(&audit_arc);
            async move {
                requests_handler::run_preflight(
                    event,
                    Some(&context),
                    &snap,
                    store.as_ref(),
                    audit.as_ref(),
                )
                .await;
            }
        },
        rh_cancel_rx,
    );

    // ── Scheduler adapter: one job that fires every minute ────────────────────
    let (scheduler_handle, scheduler_join) = scheduler_adapter::start(
        requests_handle.clone(),
        vec![ScheduleEntry {
            id: job_id.to_string(),
            cron: "* * * * *".to_string(),
            prompt: expected_prompt.to_string(),
        }],
    );

    // ── Inline periodic dispatcher ────────────────────────────────────────────
    let (dispatcher_cancel_tx, dispatcher_cancel_rx) = watch::channel(false);
    let dispatcher_join = start_inline_dispatcher(
        persistence_handle.clone(),
        supervisor_handle.clone(),
        dispatcher_cancel_rx,
    );

    // ── Drive the e2e flow via tokio time ─────────────────────────────────────

    // Yield to let all actors start and register their initial timers.
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }

    // Advance 61 s: the `* * * * *` cron sleep (≤60 s) elapses and the
    // scheduler task wakes up, submitting a Periodic event to the requests
    // handler.  The requests-handler runs pre-flight (admitted) and enqueues
    // the event in persistence.
    tokio::time::advance(Duration::from_secs(61)).await;

    // Let the scheduler, requests-handler, and persistence actor process.
    for _ in 0..20 {
        tokio::task::yield_now().await;
    }

    // Advance 200 ms: the dispatcher's DISPATCHER_POLL_INTERVAL (100 ms) sleep
    // elapses, waking the dispatcher to dequeue and forward the event.
    tokio::time::advance(Duration::from_millis(200)).await;

    // Give the dispatcher enough task-yield slices to reach send_prompt() before
    // we resume real time.  Each yield lets one other task run one slice:
    // dequeue_next (2 slices) → acquire_session (2 slices) → send_prompt start
    // (2 slices) leaves comfortable margin.
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    // Resume real time.  With tokio time paused the IO reactor never gets idle
    // cycles to detect child stdout readability via epoll, and the OS never
    // schedules the sh child process between the tight advance() iterations.
    // After resume(), tokio::time::sleep() uses real wall-clock time, causing
    // the runtime to park (epoll_wait) so the child can run and respond.
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
        "scheduler prompt must be delivered to the fake pi-agent worker within the polling deadline"
    );

    // ── Verify byte-for-byte equality (AC-2) ──────────────────────────────────
    let delivered_prompt =
        std::fs::read_to_string(&record_file).expect("record file must be readable");
    assert_eq!(
        delivered_prompt, expected_prompt,
        "delivered prompt must equal the configured schedule entry prompt byte-for-byte"
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

// ── AC-3, AC-4 ───────────────────────────────────────────────────────────────

/// AC-3: IF the scheduler-derived `UserId` is NOT admitted by policy THEN
///       THE SYSTEM SHALL record a denied pre-flight verdict and shall NOT
///       deliver the prompt to the fake pi-agent worker.
///
/// AC-4: No real external `pi` binary is required.
#[tokio::test(flavor = "current_thread")]
async fn schedule_entry_prompt_is_not_delivered_when_scheduler_user_is_not_admitted() {
    tokio::time::pause();

    let tmp = tempfile::tempdir().expect("temp dir");
    let record_file = tmp.path().join("received_prompt.txt");
    let record_file_str = record_file.to_string_lossy().into_owned();

    let expected_prompt = "e2e-scheduled-prompt-ac3-should-not-arrive";
    let job_id = "e2e-scheduler-job-denied";

    // Fake worker (same as AC-1 test).
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
    let (monitoring_handle, _monitoring_join) = monitoring::start(monitoring::Config {
        command_buffer: 16,
        audit_log_path: audit_log,
    });

    // Subscribe before any events fire so we capture the denied verdict.
    let mut verdict_rx = monitoring_handle
        .subscribe_tail(vec![AuditFilterKind::Verdicts])
        .await
        .expect("monitoring subscription must succeed");

    // ── Persistence ───────────────────────────────────────────────────────────
    let (persistence_handle, _persistence_join) =
        persistence::start(persistence::Config::default());

    // ── Policy: EMPTY admitted_users → deny-all ───────────────────────────────
    let policy_cfg = policy_control::PolicyConfig::default(); // no admitted users
    let initial_snapshot = policy_control::RulesetSnapshot::from_config(policy_cfg)
        .expect("empty (deny-all) policy config is always valid");
    let (_, _policy_join, policy_snapshot) = policy_control::start(policy_control::Config {
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
        })
        .expect("pi-agent supervisor must start with fake worker");

    // ── Requests handler with pre-flight gate ─────────────────────────────────
    let persistence_arc: Arc<dyn PersistenceStore> = Arc::new(persistence_handle.clone());
    let audit_arc: Arc<dyn AuditSink> = Arc::new(monitoring::MonitoringAuditSink::new(
        monitoring_handle.clone(),
    ));
    let snap_for_preflight = policy_snapshot.clone();

    let (rh_cancel_tx, rh_cancel_rx) = watch::channel(false);
    let (requests_handle, _requests_join) = requests_handler::start_with(
        requests_handler::Config {
            request_queue_capacity: 16,
            request_submit_timeout: Duration::from_secs(5),
        },
        move |(event, context)| {
            let snap = snap_for_preflight.clone();
            let store = Arc::clone(&persistence_arc);
            let audit = Arc::clone(&audit_arc);
            async move {
                requests_handler::run_preflight(
                    event,
                    Some(&context),
                    &snap,
                    store.as_ref(),
                    audit.as_ref(),
                )
                .await;
            }
        },
        rh_cancel_rx,
    );

    // ── Scheduler adapter ─────────────────────────────────────────────────────
    let (scheduler_handle, _scheduler_join) = scheduler_adapter::start(
        requests_handle.clone(),
        vec![ScheduleEntry {
            id: job_id.to_string(),
            cron: "* * * * *".to_string(),
            prompt: expected_prompt.to_string(),
        }],
    );

    // ── Inline periodic dispatcher ────────────────────────────────────────────
    let (dispatcher_cancel_tx, dispatcher_cancel_rx) = watch::channel(false);
    let _dispatcher_join = start_inline_dispatcher(
        persistence_handle.clone(),
        supervisor_handle.clone(),
        dispatcher_cancel_rx,
    );

    // ── Drive the flow ────────────────────────────────────────────────────────

    // Yield to let actors start and timers register.
    for _ in 0..8 {
        tokio::task::yield_now().await;
    }

    // Advance 61 s: scheduler fires, submits event; requests-handler runs
    // pre-flight which DENIES the event (user not admitted) and records a
    // denied verdict in monitoring.
    tokio::time::advance(Duration::from_secs(61)).await;

    // Give the scheduler and requests-handler task slices to begin propagating
    // the denied event before we resume real time.
    for _ in 0..10 {
        tokio::task::yield_now().await;
    }

    // Resume real time.  The denied-verdict chain crosses several actor message
    // hops (scheduler → requests-handler → pre-flight → monitoring publish).
    // With tokio time paused, a bounded yield count is not sufficient under OS
    // load — the actor tasks may not get scheduled within that window.
    // After resume(), tokio::time::sleep() parks the runtime so every actor in
    // the chain is eventually scheduled, mirroring the AC-1 approach.
    tokio::time::resume();

    // ── AC-3 assertion 1: denied verdict is recorded ──────────────────────────
    // Poll verdict_rx with real-time delays.  Each sleep parks the runtime so
    // the monitoring actor can fan out the denied verdict to the subscriber.
    let mut found_denied_verdict = false;
    let verdict_deadline = std::time::Instant::now() + Duration::from_secs(5);
    while std::time::Instant::now() < verdict_deadline {
        loop {
            match verdict_rx.try_recv() {
                Ok(record) => {
                    if matches!(
                        record.payload,
                        AuditRecordPayload::Verdict(ref p) if !p.allow
                    ) {
                        found_denied_verdict = true;
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        if found_denied_verdict {
            break;
        }
        // Real 50 ms sleep: parks the runtime so actor tasks are scheduled.
        tokio::time::sleep(Duration::from_millis(50)).await;
    }

    assert!(
        found_denied_verdict,
        "a denied pre-flight verdict must be recorded in monitoring when user is not admitted"
    );

    // ── AC-3 assertion 2: prompt NOT delivered to fake worker ─────────────────
    // Brief real-time pause: let the dispatcher cycle through persistence (which
    // is empty after denial) to confirm it dispatches nothing to the worker.
    tokio::time::sleep(Duration::from_millis(200)).await;

    assert!(
        !record_file.exists(),
        "denied scheduler event must NOT be delivered to the fake pi-agent worker"
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

    let _ = supervisor_join.await;
}
