use std::{
    io::Write,
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Output, Stdio},
    thread,
    time::{Duration, Instant},
};

use bob::config::{BobConfig, MonitoringConfig, ScheduleConfig};
use bob_core::types::SessionId;
use policy_control::PolicyConfig;
use serde_json::{json, Value};

const SOCKET_APPEAR_DEADLINE: Duration = Duration::from_secs(2);
const SHUTDOWN_DRAIN_DEADLINE: Duration = Duration::from_millis(800);
// Phase 4 now awaits supervisor child cleanup; give it a tight deadline so the
// test does not hang on a slow pi-agent SIGTERM response.
const SHUTDOWN_REAP_DEADLINE: Duration = Duration::from_millis(200);
const SHUTDOWN_EXIT_MARGIN: Duration = Duration::from_millis(300);
const COMMAND_DEADLINE: Duration = Duration::from_secs(1);
const PROCESS_EXIT_POLL_INTERVAL: Duration = Duration::from_millis(10);

/// Deadline for async admin-RPC calls made from the test.
const ADMIN_RPC_DEADLINE: Duration = Duration::from_secs(2);
const AUDIT_TAIL_DELIVERY_DEADLINE: Duration = Duration::from_secs(2);
const LARGE_REPORT_SUMMARY_BYTES: usize = 9_000;

fn extension_fixture_path() -> PathBuf {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../pi-extension/bob.ts");
    assert!(
        path.is_file(),
        "extension fixture must exist at {}",
        path.display()
    );
    path
}

struct BobServeChild {
    child: Child,
}

impl BobServeChild {
    fn spawn(admin_sock_path: &str, extension_sock_path: &str) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_bob"))
            .arg("serve")
            .env("BOB_ADMIN_SOCK_PATH", admin_sock_path)
            .env("BOB_EXTENSION_SOCK_PATH", extension_sock_path)
            .env("BOB_EXTENSION_PATH", extension_fixture_path())
            .env(
                "BOB_SHUTDOWN_DRAIN_DEADLINE",
                format!("{}ms", SHUTDOWN_DRAIN_DEADLINE.as_millis()),
            )
            .env(
                "BOB_SHUTDOWN_REAP_DEADLINE",
                format!("{}ms", SHUTDOWN_REAP_DEADLINE.as_millis()),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn bob serve");

        Self { child }
    }

    /// Spawn `bob serve` with an explicit audit log path so that the JSONL file
    /// location is predictable from the test.
    ///
    /// `audit_log_path` is passed via `XDG_STATE_HOME` (the monitoring actor
    /// derives its default path from that env var at startup).  The derived
    /// path will be `<XDG_STATE_HOME>/bob/audit.jsonl`.
    fn spawn_with_audit_log(
        admin_sock_path: &str,
        extension_sock_path: &str,
        xdg_state_home: &str,
    ) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_bob"))
            .arg("serve")
            .env("BOB_ADMIN_SOCK_PATH", admin_sock_path)
            .env("BOB_EXTENSION_SOCK_PATH", extension_sock_path)
            .env("BOB_EXTENSION_PATH", extension_fixture_path())
            .env("XDG_STATE_HOME", xdg_state_home)
            .env(
                "BOB_SHUTDOWN_DRAIN_DEADLINE",
                format!("{}ms", SHUTDOWN_DRAIN_DEADLINE.as_millis()),
            )
            .env(
                "BOB_SHUTDOWN_REAP_DEADLINE",
                format!("{}ms", SHUTDOWN_REAP_DEADLINE.as_millis()),
            )
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn bob serve with audit log");

        Self { child }
    }

    fn pid(&self) -> i32 {
        i32::try_from(self.child.id()).expect("child pid fits i32")
    }

    fn try_wait(&mut self) -> Option<ExitStatus> {
        self.child
            .try_wait()
            .expect("polling bob serve status should succeed")
    }

    fn wait_for_exit(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.try_wait() {
                return Some(status);
            }

            if Instant::now() >= deadline {
                return None;
            }

            thread::sleep(PROCESS_EXIT_POLL_INTERVAL);
        }
    }
}

impl Drop for BobServeChild {
    fn drop(&mut self) {
        if self.try_wait().is_some() {
            return;
        }

        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[test]
fn shell_commands_work_end_to_end_against_spawned_serve() {
    let temp_dir = tempfile::tempdir().expect("create temp dir");
    let admin_sock_path = temp_dir.path().join("admin.sock");
    let extension_sock_path = temp_dir.path().join("extension.sock");
    let admin_sock_str = admin_sock_path
        .to_str()
        .expect("admin socket path is valid utf-8");
    let extension_sock_str = extension_sock_path
        .to_str()
        .expect("extension socket path is valid utf-8");

    let mut serve = BobServeChild::spawn(admin_sock_str, extension_sock_str);

    let sockets_ready = wait_for_both_sockets(&admin_sock_path, &extension_sock_path);
    assert!(
        sockets_ready,
        "expected admin.sock and extension.sock within {:?}",
        SOCKET_APPEAR_DEADLINE
    );

    let mut status_cmd = Command::new(env!("CARGO_BIN_EXE_bob"));
    status_cmd
        .arg("status")
        .env("BOB_ADMIN_SOCK_PATH", admin_sock_str)
        .env("BOB_EXTENSION_SOCK_PATH", extension_sock_str);
    let status_output = run_command_with_timeout(&mut status_cmd, "bob status", COMMAND_DEADLINE);
    assert_eq!(
        status_output.status.code(),
        Some(0),
        "bob status failed: stderr={}",
        String::from_utf8_lossy(&status_output.stderr)
    );
    let status_stdout = String::from_utf8(status_output.stdout).expect("status stdout is utf-8");
    assert!(
        !status_stdout.trim().is_empty(),
        "bob status should print non-empty payload"
    );

    let mut sessions_cmd = Command::new(env!("CARGO_BIN_EXE_bob"));
    sessions_cmd
        .args(["sessions", "list", "--json"])
        .env("BOB_ADMIN_SOCK_PATH", admin_sock_str)
        .env("BOB_EXTENSION_SOCK_PATH", extension_sock_str);
    let sessions_output = run_command_with_timeout(
        &mut sessions_cmd,
        "bob sessions list --json",
        COMMAND_DEADLINE,
    );
    assert_eq!(
        sessions_output.status.code(),
        Some(0),
        "bob sessions list --json failed: stderr={}",
        String::from_utf8_lossy(&sessions_output.stderr)
    );
    let sessions_stdout =
        String::from_utf8(sessions_output.stdout).expect("sessions stdout is utf-8");
    let sessions_json: Value =
        serde_json::from_str(sessions_stdout.trim()).expect("sessions output is valid json");
    assert_eq!(
        sessions_json,
        Value::Array(vec![]),
        "expected empty sessions array"
    );

    let kill_status = Command::new("kill")
        .arg("-TERM")
        .arg(serve.pid().to_string())
        .status()
        .expect("invoke kill -TERM");
    assert!(kill_status.success(), "kill -TERM should succeed");

    let shutdown_started_at = Instant::now();
    // Exit deadline: phase 3 drain + phase 4 reap + safety margin.
    let shutdown_exit_deadline =
        SHUTDOWN_DRAIN_DEADLINE + SHUTDOWN_REAP_DEADLINE + SHUTDOWN_EXIT_MARGIN;
    let exit_status = serve
        .wait_for_exit(shutdown_exit_deadline)
        .expect("bob serve should exit shortly after configured shutdown deadlines");
    assert_eq!(
        exit_status.code(),
        Some(0),
        "bob serve should exit with code 0 after SIGTERM"
    );
    assert!(
        shutdown_started_at.elapsed() < SHUTDOWN_DRAIN_DEADLINE,
        "idle bob serve should exit before consuming the drain timeout fallback"
    );

    assert!(
        !admin_sock_path.exists(),
        "admin socket file should be removed after graceful shutdown"
    );
    assert!(
        !extension_sock_path.exists(),
        "extension socket file should be removed after graceful shutdown"
    );
}

// ── AC-3: report.submit over admin.sock appends a report audit record ────────

/// AC-3: WHEN a same-UID client submits `report.submit` over `admin.sock`
/// THE SYSTEM SHALL append a `report` audit record to the JSONL log.
#[test]
fn report_submit_over_admin_sock_appends_report_audit_record_to_jsonl() {
    let temp_dir = tempfile::tempdir().expect("create temp dir");
    let admin_sock_path = temp_dir.path().join("admin.sock");
    let extension_sock_path = temp_dir.path().join("extension.sock");
    let state_home = temp_dir.path().join("state");
    let admin_sock_str = admin_sock_path.to_str().expect("admin sock utf-8");
    let extension_sock_str = extension_sock_path.to_str().expect("extension sock utf-8");
    let state_home_str = state_home.to_str().expect("state home utf-8");
    let audit_log_path = state_home.join("bob").join("audit.jsonl");

    let mut serve =
        BobServeChild::spawn_with_audit_log(admin_sock_str, extension_sock_str, state_home_str);

    let ready = wait_for_both_sockets(&admin_sock_path, &extension_sock_path);
    assert!(ready, "sockets must appear before calling report.submit");

    let submit_result = submit_report(
        &admin_sock_path,
        "tool.e2e.test",
        &large_report_summary("e2e report submit test"),
    );

    assert_eq!(
        submit_result["ok"],
        json!(true),
        "report.submit must return ok: true"
    );

    // Shut down serve so the monitoring actor flushes its buffer.
    let shutdown_exit_deadline =
        SHUTDOWN_DRAIN_DEADLINE + SHUTDOWN_REAP_DEADLINE + SHUTDOWN_EXIT_MARGIN;
    send_sigterm(serve.pid());
    let exit_status = serve
        .wait_for_exit(shutdown_exit_deadline)
        .expect("bob serve should exit after SIGTERM");
    assert_eq!(
        exit_status.code(),
        Some(0),
        "bob serve should exit with code 0 after SIGTERM"
    );

    // Verify the JSONL file contains a record with kind "report".
    let contents = std::fs::read_to_string(&audit_log_path).unwrap_or_else(|e| {
        panic!(
            "audit log at {} must be readable after shutdown: {e}",
            audit_log_path.display()
        )
    });
    let lines: Vec<&str> = contents.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "expected one audit record, got:\n{contents}"
    );
    let record: Value = serde_json::from_str(lines[0]).expect("audit log line must be valid JSON");
    assert_eq!(
        record["kind"],
        json!("report"),
        "audit record must have kind 'report', got: {record}"
    );
}

// ── AC-1: JSONL audit records survive bob serve restart ───────────────────────

/// AC-1: WHEN `bob serve` accepts audit records and restarts with the same
/// audit log path THE SYSTEM SHALL preserve the previously appended JSONL records.
#[test]
fn persistent_jsonl_survives_bob_serve_restart() {
    let temp_dir = tempfile::tempdir().expect("create temp dir");
    let admin_sock_path = temp_dir.path().join("admin.sock");
    let extension_sock_path = temp_dir.path().join("extension.sock");
    let state_home = temp_dir.path().join("state");
    let admin_sock_str = admin_sock_path.to_str().expect("admin sock utf-8");
    let extension_sock_str = extension_sock_path.to_str().expect("extension sock utf-8");
    let state_home_str = state_home.to_str().expect("state home utf-8");
    let audit_log_path = state_home.join("bob").join("audit.jsonl");
    let shutdown_exit_deadline =
        SHUTDOWN_DRAIN_DEADLINE + SHUTDOWN_REAP_DEADLINE + SHUTDOWN_EXIT_MARGIN;

    // ── First run: start, submit a report, shut down ──────────────────────────
    let mut serve1 =
        BobServeChild::spawn_with_audit_log(admin_sock_str, extension_sock_str, state_home_str);
    let ready = wait_for_both_sockets(&admin_sock_path, &extension_sock_path);
    assert!(ready, "sockets must appear before first report.submit");

    let _first_submit = submit_report(
        &admin_sock_path,
        "tool.first.run",
        &large_report_summary("first run"),
    );

    send_sigterm(serve1.pid());
    let first_exit_status = serve1
        .wait_for_exit(shutdown_exit_deadline)
        .expect("bob serve (first run) should exit after SIGTERM");
    assert_eq!(
        first_exit_status.code(),
        Some(0),
        "bob serve (first run) should exit with code 0 after SIGTERM"
    );

    // Confirm the JSONL has one record after the first run.
    let after_first =
        std::fs::read_to_string(&audit_log_path).expect("audit log must exist after first run");
    let lines_after_first: Vec<&str> = after_first.lines().collect();
    assert_eq!(
        lines_after_first.len(),
        1,
        "expected one record after first run, got:\n{after_first}"
    );

    // ── Second run: restart with the same state home ──────────────────────────
    let mut serve2 =
        BobServeChild::spawn_with_audit_log(admin_sock_str, extension_sock_str, state_home_str);
    let ready2 = wait_for_both_sockets(&admin_sock_path, &extension_sock_path);
    assert!(ready2, "sockets must appear before second report.submit");

    // Submit a second record so we can confirm append mode.
    let _second_submit = submit_report(
        &admin_sock_path,
        "tool.second.run",
        &large_report_summary("second run"),
    );

    send_sigterm(serve2.pid());
    let second_exit_status = serve2
        .wait_for_exit(shutdown_exit_deadline)
        .expect("bob serve (second run) should exit after SIGTERM");
    assert_eq!(
        second_exit_status.code(),
        Some(0),
        "bob serve (second run) should exit with code 0 after SIGTERM"
    );

    // The persisted audit log must retain records from both runs after restart.
    let after_second =
        std::fs::read_to_string(&audit_log_path).expect("audit log must exist after second run");
    assert_eq!(
        after_second
            .matches("\"action\":\"tool.first.run\"")
            .count(),
        1,
        "persisted log must contain the first-run report exactly once"
    );
    assert!(
        after_second.contains("\"action\":\"tool.first.run\""),
        "persisted log must contain the first-run report record"
    );
    assert_eq!(
        after_second
            .matches("\"action\":\"tool.second.run\"")
            .count(),
        1,
        "persisted log must contain the second-run report exactly once"
    );
    assert!(
        after_second.contains("\"action\":\"tool.second.run\""),
        "persisted log must contain the second-run report record"
    );
}

// ── AC-2: filtered-out kind still written to JSONL despite tail filter ────────

/// AC-2: WHEN a kind is hidden from tail visibility THE SYSTEM SHALL still
/// write that kind to the JSONL audit log.
///
/// We subscribe to the events-only tail and then submit a `report` record.
/// Reports are not delivered to an events-only subscription, but they must
/// appear in the persistent JSONL file.
#[test]
fn filtered_out_kind_still_written_to_jsonl_despite_tail_filter() {
    let temp_dir = tempfile::tempdir().expect("create temp dir");
    let admin_sock_path = temp_dir.path().join("admin.sock");
    let extension_sock_path = temp_dir.path().join("extension.sock");
    let state_home = temp_dir.path().join("state");
    let admin_sock_str = admin_sock_path.to_str().expect("admin sock utf-8");
    let extension_sock_str = extension_sock_path.to_str().expect("extension sock utf-8");
    let state_home_str = state_home.to_str().expect("state home utf-8");
    let audit_log_path = state_home.join("bob").join("audit.jsonl");
    let shutdown_exit_deadline =
        SHUTDOWN_DRAIN_DEADLINE + SHUTDOWN_REAP_DEADLINE + SHUTDOWN_EXIT_MARGIN;

    let mut serve =
        BobServeChild::spawn_with_audit_log(admin_sock_str, extension_sock_str, state_home_str);
    let ready = wait_for_both_sockets(&admin_sock_path, &extension_sock_path);
    assert!(ready, "sockets must appear before connecting");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let cfg = client_cfg(admin_sock_path.clone());
    rt.block_on(async {
        tokio::time::timeout(ADMIN_RPC_DEADLINE, async {
            // Subscribe with an events-only filter.  Reports are hidden from
            // this subscription but must still reach the JSONL log.
            let mut sub_client = bob::client::AdminClient::connect(&cfg)
                .await
                .expect("connect for subscription");
            let _sub = sub_client
                .subscribe::<_, Value>("audit.tail.subscribe", json!({ "filters": ["events"] }))
                .await
                .expect("audit.tail.subscribe must succeed");

            // Submit a report on a separate connection.
            let mut rpc_client = bob::client::AdminClient::connect(&cfg)
                .await
                .expect("connect for report.submit");
            let result: Value = rpc_client
                .call(
                    "report.submit",
                    json!({
                        "action": "tool.filtered.test",
                        "outcome": "success",
                        "session_id": null,
                        "summary": large_report_summary("report filtered from events subscription")
                    }),
                )
                .await
                .expect("report.submit must succeed");
            assert_eq!(
                result["ok"],
                json!(true),
                "report.submit must return ok: true"
            );
        })
        .await
    })
    .expect("subscription and submit must complete within deadline");

    // Shut down so the monitoring actor flushes its buffer.
    send_sigterm(serve.pid());
    let exit_status = serve
        .wait_for_exit(shutdown_exit_deadline)
        .expect("bob serve should exit after SIGTERM");
    assert_eq!(
        exit_status.code(),
        Some(0),
        "bob serve should exit with code 0 after SIGTERM"
    );

    // The JSONL must contain the report even though it was hidden from the
    // events-only tail subscription.
    let contents = std::fs::read_to_string(&audit_log_path).unwrap_or_else(|e| {
        panic!(
            "audit log at {} must be readable: {e}",
            audit_log_path.display()
        )
    });
    let lines: Vec<&str> = contents.lines().collect();
    assert_eq!(
        lines.len(),
        1,
        "expected exactly one audit record, got:\n{contents}"
    );
    let record: Value = serde_json::from_str(lines[0]).expect("audit log line must be valid JSON");
    assert_eq!(
        record["kind"],
        json!("report"),
        "filtered-out report kind must still be written to JSONL, got: {record}"
    );
}

// ── AC-4: bob audit tail --filter reports emits only report records ───────────

/// AC-4: WHEN `bob audit tail --filter reports` is running THE SYSTEM SHALL
/// print report records and suppress event and verdict records.
#[test]
fn audit_tail_filter_reports_prints_reports_and_suppresses_event_and_verdict() {
    let temp_dir = tempfile::tempdir().expect("create temp dir");
    let admin_sock_path = temp_dir.path().join("admin.sock");
    let extension_sock_path = temp_dir.path().join("extension.sock");
    let state_home = temp_dir.path().join("state");
    let admin_sock_str = admin_sock_path.to_str().expect("admin sock utf-8");
    let extension_sock_str = extension_sock_path.to_str().expect("extension sock utf-8");
    let state_home_str = state_home.to_str().expect("state home utf-8");
    let shutdown_exit_deadline =
        SHUTDOWN_DRAIN_DEADLINE + SHUTDOWN_REAP_DEADLINE + SHUTDOWN_EXIT_MARGIN;

    let mut serve =
        BobServeChild::spawn_with_audit_log(admin_sock_str, extension_sock_str, state_home_str);
    let ready = wait_for_both_sockets(&admin_sock_path, &extension_sock_path);
    assert!(ready, "sockets must appear before running audit tail");

    let tail_child = Command::new(env!("CARGO_BIN_EXE_bob"))
        .args(["audit", "tail", "--filter", "reports"])
        .env("BOB_ADMIN_SOCK_PATH", admin_sock_str)
        .env("BOB_EXTENSION_SOCK_PATH", extension_sock_str)
        .env("XDG_STATE_HOME", state_home_str)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("spawn bob audit tail --filter reports");

    // Give tail a moment to subscribe before producing records.
    thread::sleep(Duration::from_millis(250));
    let session = SessionId::new();
    send_extension_event(&extension_sock_path, session);
    send_extension_authz(&extension_sock_path, session);
    let _submit = submit_report(
        &admin_sock_path,
        "tool.tail.filter.test",
        "tail filter report",
    );
    thread::sleep(Duration::from_millis(250));

    send_signal(
        i32::try_from(tail_child.id()).expect("tail pid fits i32"),
        "-TERM",
    );
    let tail_output = wait_for_child_output(
        tail_child,
        "bob audit tail --filter reports",
        AUDIT_TAIL_DELIVERY_DEADLINE + Duration::from_secs(3),
    );

    let tail_stdout = String::from_utf8(tail_output.stdout).expect("tail stdout utf-8");
    let tail_records: Vec<Value> = tail_stdout
        .lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| serde_json::from_str(line).expect("tail line must be valid json"))
        .collect();
    assert!(
        !tail_records.is_empty(),
        "tail output must include at least one report record"
    );
    assert!(
        tail_records
            .iter()
            .all(|record| record["kind"] == json!("report")),
        "reports filter must suppress event/verdict records; got:\n{tail_stdout}"
    );

    send_sigterm(serve.pid());
    let serve_exit = serve
        .wait_for_exit(shutdown_exit_deadline)
        .expect("bob serve should exit after SIGTERM");
    assert_eq!(
        serve_exit.code(),
        Some(0),
        "bob serve should exit with code 0 after SIGTERM"
    );
}

fn run_command_with_timeout(command: &mut Command, label: &str, timeout: Duration) -> Output {
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|e| panic!("spawn {label}: {e}"));

    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .unwrap_or_else(|e| panic!("collect {label} output: {e}"));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let output = child
                        .wait_with_output()
                        .unwrap_or_else(|e| panic!("collect timed out {label} output: {e}"));
                    panic!(
                        "{label} timed out after {:?}; stderr={}",
                        timeout,
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                thread::sleep(PROCESS_EXIT_POLL_INTERVAL);
            }
            Err(e) => panic!("poll {label} completion: {e}"),
        }
    }
}

fn wait_for_both_sockets(admin_sock_path: &Path, extension_sock_path: &Path) -> bool {
    let deadline = Instant::now() + SOCKET_APPEAR_DEADLINE;
    while Instant::now() < deadline {
        if admin_sock_path.exists() && extension_sock_path.exists() {
            return true;
        }
        thread::sleep(PROCESS_EXIT_POLL_INTERVAL);
    }

    admin_sock_path.exists() && extension_sock_path.exists()
}

fn wait_for_child_output(mut child: Child, label: &str, timeout: Duration) -> Output {
    let deadline = Instant::now() + timeout;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => {
                return child
                    .wait_with_output()
                    .unwrap_or_else(|e| panic!("collect {label} output: {e}"));
            }
            Ok(None) => {
                if Instant::now() >= deadline {
                    let _ = child.kill();
                    let output = child
                        .wait_with_output()
                        .unwrap_or_else(|e| panic!("collect timed out {label} output: {e}"));
                    panic!(
                        "{label} timed out after {:?}; stderr={}",
                        timeout,
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
                thread::sleep(PROCESS_EXIT_POLL_INTERVAL);
            }
            Err(e) => panic!("poll {label} completion: {e}"),
        }
    }
}

fn large_report_summary(prefix: &str) -> String {
    let filler = "x".repeat(LARGE_REPORT_SUMMARY_BYTES);
    format!("{prefix}:{filler}")
}

fn submit_report(admin_sock_path: &Path, action: &str, summary: &str) -> Value {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("tokio runtime");
    let cfg = client_cfg(admin_sock_path.to_path_buf());
    rt.block_on(async {
        tokio::time::timeout(ADMIN_RPC_DEADLINE, async {
            let mut client = bob::client::AdminClient::connect(&cfg)
                .await
                .expect("connect for report.submit");
            client
                .call::<_, Value>(
                    "report.submit",
                    json!({
                        "action": action,
                        "outcome": "success",
                        "session_id": null,
                        "summary": summary,
                    }),
                )
                .await
                .expect("report.submit must succeed")
        })
        .await
    })
    .expect("report.submit must complete within deadline")
}

fn send_extension_event(extension_sock_path: &Path, session: SessionId) {
    let frame = json!({
        "kind": "event",
        "session": session.to_string(),
        "payload": { "event": "shell_e2e.event" },
    })
    .to_string();
    send_extension_frame(extension_sock_path, &frame);
}

fn send_extension_authz(extension_sock_path: &Path, session: SessionId) {
    let frame = json!({
        "kind": "authz",
        "session": session.to_string(),
        "tool": "bash",
        "arguments": { "cmd": "echo shell-e2e" },
    })
    .to_string();
    send_extension_frame(extension_sock_path, &frame);
}

fn send_extension_frame(extension_sock_path: &Path, frame: &str) {
    let mut stream =
        UnixStream::connect(extension_sock_path).expect("connect extension socket for frame send");
    stream
        .write_all(frame.as_bytes())
        .expect("write extension frame");
    stream
        .write_all(b"\n")
        .expect("write extension frame newline");
}

/// Build a minimal `BobConfig` that points the admin client at `admin_sock_path`.
///
/// Only `admin_sock_path` is meaningful for `AdminClient::connect`; all other
/// fields carry stand-in values that satisfy `BobConfig`'s field requirements
/// but are never used during the test.
fn client_cfg(admin_sock_path: PathBuf) -> BobConfig {
    BobConfig {
        admin_sock_path,
        admin_sock_is_tmp_fallback: false,
        extension_sock_path: PathBuf::new(),
        extension_path: PathBuf::new(),
        request_queue_capacity: 1024,
        request_submit_timeout: Duration::from_secs(5),
        shutdown_drain_deadline: Duration::from_secs(30),
        shutdown_reap_deadline: Duration::from_secs(10),
        pi_agent_command: "pi".to_string(),
        pi_agent_args: vec!["--mode".to_string(), "rpc".to_string()],
        pi_agent_warm_pool_size: 1,
        pi_agent_max_processes: 8,
        pi_agent_idle_reap_timeout: Duration::from_secs(300),
        pi_agent_cwd: None,
        skill_install_path: PathBuf::new(),
        tracing_level: "info".to_string(),
        tracing_format: "pretty".to_string(),
        policy: PolicyConfig::default(),
        monitoring: MonitoringConfig {
            audit_log_path: PathBuf::new(),
            default_tail_filters: vec![],
        },
        config_path: PathBuf::new(),
        schedule: ScheduleConfig { entries: vec![] },
        schedule_store_path: PathBuf::new(),
    }
}

/// Send `SIGTERM` to the process with the given pid.
fn send_sigterm(pid: i32) {
    send_signal(pid, "-TERM");
}

fn send_signal(pid: i32, signal: &str) {
    let status = Command::new("kill")
        .arg(signal)
        .arg(pid.to_string())
        .status()
        .unwrap_or_else(|e| panic!("invoke kill {signal}: {e}"));
    assert!(status.success(), "kill {signal} must succeed for pid {pid}");
}
