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
    types::{DeliveryKind, ScheduleEntry},
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
                    // ADR-012: Periodic events bypass pre-flight; the trusted
                    // schedule store is itself the admission gate.
                    let _ = store.enqueue(event).await;
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
