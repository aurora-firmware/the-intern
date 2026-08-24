use std::{path::Path, process::Command};

#[test]
fn status_exits_non_zero_when_admin_socket_is_missing() {
    let temp = tempfile::tempdir().expect("temp dir");
    let state_home = temp.path().join("state");
    let home_dir = temp.path().join("home");
    let output = bob_command_with_temp_state(&state_home, &home_dir)
        .arg("status")
        .output()
        .expect("bob binary to run");

    assert_eq!(output.status.code(), Some(1));

    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(
        stderr.contains("missing admin socket"),
        "stderr did not include marker: {stderr}"
    );
}

// ── AC-4: bob audit tail --filter reports filters at the CLI level ────────────

/// AC-4 (CLI level): WHEN `bob audit tail --filter reports` is invoked without
/// a running service THE SYSTEM SHALL exit non-zero and report a missing admin
/// socket — proving the filter argument is accepted by clap and forwarded
/// through the command dispatch path, not silently dropped or causing a panic.
///
/// This test operates without a live `bob serve` instance (hence `non_serve`)
/// because driving a long-running tail deterministically in a shell E2E test
/// would require coordinating process lifetimes and race conditions.  The full
/// filter-to-subscription-delivery path is covered at the unit level in
/// `crates/bob/src/cli/commands/audit.rs`.
#[test]
fn audit_tail_with_filter_reports_exits_non_zero_when_socket_absent() {
    let temp = tempfile::tempdir().expect("temp dir");
    let state_home = temp.path().join("state");
    let home_dir = temp.path().join("home");
    let output = bob_command_with_temp_state(&state_home, &home_dir)
        .args(["audit", "tail", "--filter", "reports"])
        .output()
        .expect("bob binary to run");

    assert_eq!(
        output.status.code(),
        Some(1),
        "bob audit tail --filter reports must exit 1 when no socket is present"
    );

    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(
        stderr.contains("missing admin socket"),
        "stderr must mention missing admin socket; got: {stderr}"
    );
}

/// AC-4 (CLI level): WHEN `bob audit tail --filter events --filter verdicts`
/// is invoked without a running service THE SYSTEM SHALL exit non-zero,
/// confirming that multiple filter values are accepted and the command reaches
/// the socket-connect stage (i.e. clap parsed all filter arguments without
/// error).
#[test]
fn audit_tail_with_multiple_filters_exits_non_zero_when_socket_absent() {
    let temp = tempfile::tempdir().expect("temp dir");
    let state_home = temp.path().join("state");
    let home_dir = temp.path().join("home");
    let output = bob_command_with_temp_state(&state_home, &home_dir)
        .args([
            "audit", "tail", "--filter", "events", "--filter", "verdicts",
        ])
        .output()
        .expect("bob binary to run");

    assert_eq!(
        output.status.code(),
        Some(1),
        "bob audit tail with multiple filters must exit 1 when no socket is present"
    );

    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    assert!(
        stderr.contains("missing admin socket"),
        "stderr must mention missing admin socket; got: {stderr}"
    );
}

#[test]
fn task_new_creates_board_and_task_without_an_admin_socket() {
    let temp = tempfile::tempdir().expect("temp dir");
    let state_home = temp.path().join("state");
    let home_dir = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");

    let output = bob_command_with_temp_state(&state_home, &home_dir)
        .current_dir(&workspace)
        .args(["task", "new", "Inspect logs", "--created", "2026-08-24"])
        .output()
        .expect("bob binary to run");

    assert_eq!(
        output.status.code(),
        Some(0),
        "bob task new must succeed without an admin socket"
    );

    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(
        stdout.contains("created task: 2026-08-24-inspect-logs"),
        "stdout must report the created task; got: {stdout}"
    );
    assert!(
        workspace
            .join("tasks")
            .join("2026-08-24-inspect-logs.md")
            .exists(),
        "task new must create the markdown file on disk"
    );
}

#[test]
fn task_show_path_succeeds_without_an_admin_socket_and_finds_the_ancestor_board() {
    let temp = tempfile::tempdir().expect("temp dir");
    let state_home = temp.path().join("state");
    let home_dir = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    let nested_dir = workspace.join("project").join("src");
    std::fs::create_dir_all(&nested_dir).expect("nested dir");

    let create_output = bob_command_with_temp_state(&state_home, &home_dir)
        .current_dir(&workspace)
        .args(["task", "new", "Inspect logs", "--created", "2026-08-24"])
        .output()
        .expect("bob binary to run");
    assert_eq!(create_output.status.code(), Some(0));

    let output = bob_command_with_temp_state(&state_home, &home_dir)
        .current_dir(&nested_dir)
        .args(["task", "show", "2026-08-24-inspect", "--path"])
        .output()
        .expect("bob binary to run");

    assert_eq!(
        output.status.code(),
        Some(0),
        "bob task show --path must succeed without an admin socket"
    );

    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert_eq!(
        stdout,
        format!(
            "{}\n",
            workspace
                .join("tasks")
                .join("2026-08-24-inspect-logs.md")
                .display()
        )
    );
}

fn bob_command_with_temp_state(state_home: &Path, home_dir: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bob"));
    command
        .env("XDG_STATE_HOME", state_home)
        .env("HOME", home_dir);
    command
}
