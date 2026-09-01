use std::{
    path::{Path, PathBuf},
    process::Command,
};

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

// ── bob worklog: end-to-end coverage with no running service (T-194) ──────────
//
// These cases drive the real `bob` binary across separate process invocations
// that share a working directory, covering the cross-invocation guarantees
// S-015 makes that in-crate unit tests cannot: that `bob worklog` is
// filesystem-only (no admin socket, no `bob serve`), that a read refuses to
// invent a missing `worklog/`, and that carried-forward reporting and
// carry-forward idempotency hold when one process writes what another reads.

/// AC-1: WHEN `bob worklog append` runs in a fresh temp directory with no
/// `worklog/` and no admin socket THE SYSTEM SHALL exit 0 and create
/// `<dir>/worklog/<today>.md` containing the entry.
#[test]
fn worklog_append_creates_todays_file_without_a_worklog_dir_or_admin_socket() {
    let temp = tempfile::tempdir().expect("temp dir");
    let state_home = temp.path().join("state");
    let home_dir = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");

    let output = bob_command_with_temp_state(&state_home, &home_dir)
        .current_dir(&workspace)
        .args([
            "worklog",
            "append",
            "--item",
            "vendor-invoice",
            "--done",
            "Chased the vendor for the missing PDF.",
            "--left",
            "awaiting the corrected invoice",
            "--next",
            "closes when the corrected invoice arrives",
        ])
        .output()
        .expect("bob binary to run");

    assert_eq!(
        output.status.code(),
        Some(0),
        "bob worklog append must succeed without an admin socket; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    let day_file = parse_recorded_path(&stdout);
    assert_eq!(
        day_file.parent(),
        Some(workspace.join("worklog").as_path()),
        "the entry must be written under <cwd>/worklog/: {}",
        day_file.display()
    );
    assert!(
        is_iso_dated_markdown_name(&day_file),
        "the day file must be named <YYYY-MM-DD>.md: {}",
        day_file.display()
    );

    let content = std::fs::read_to_string(&day_file).expect("today's worklog file");
    assert!(
        content.contains("vendor-invoice"),
        "the entry's item is missing from the day file: {content}"
    );
    assert!(
        content.contains("- Done: Chased the vendor for the missing PDF."),
        "the entry's done field is missing from the day file: {content}"
    );
    assert!(
        content.contains("- Left: awaiting the corrected invoice"),
        "the entry's left field is missing from the day file: {content}"
    );
    assert!(
        content.contains("- Next: closes when the corrected invoice arrives"),
        "the entry's next field is missing from the day file: {content}"
    );
}

/// AC-2: WHEN `bob worklog list` runs in the directory a prior `bob worklog
/// append` wrote to THE SYSTEM SHALL exit 0 and print the entry just written.
#[test]
fn worklog_list_reads_back_an_entry_a_prior_invocation_appended() {
    let temp = tempfile::tempdir().expect("temp dir");
    let state_home = temp.path().join("state");
    let home_dir = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");

    let append = bob_command_with_temp_state(&state_home, &home_dir)
        .current_dir(&workspace)
        .args([
            "worklog",
            "append",
            "--item",
            "vendor-invoice",
            "--done",
            "Chased the vendor for the missing PDF.",
            "--left",
            "awaiting the corrected invoice",
            "--next",
            "closes when the corrected invoice arrives",
        ])
        .output()
        .expect("bob binary to run");
    assert_eq!(
        append.status.code(),
        Some(0),
        "arrange: append must succeed; stderr: {}",
        String::from_utf8_lossy(&append.stderr)
    );

    let output = bob_command_with_temp_state(&state_home, &home_dir)
        .current_dir(&workspace)
        .args(["worklog", "list"])
        .output()
        .expect("bob binary to run");

    assert_eq!(
        output.status.code(),
        Some(0),
        "bob worklog list must succeed in a directory that has a worklog/; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(
        stdout.contains("vendor-invoice"),
        "list must print the appended item: {stdout}"
    );
    assert!(
        stdout.contains("- Done: Chased the vendor for the missing PDF."),
        "list must print the appended done field: {stdout}"
    );
    assert!(
        stdout.contains("- Left: awaiting the corrected invoice"),
        "list must print the appended left field: {stdout}"
    );
    assert!(
        stdout.contains("- Next: closes when the corrected invoice arrives"),
        "list must print the appended next field: {stdout}"
    );
}

/// AC-3: IF `bob worklog list` runs in a temp directory that has no `worklog/`
/// THEN THE SYSTEM SHALL exit non-zero and name the `worklog/` path it
/// expected.
#[test]
fn worklog_list_exits_non_zero_and_names_the_missing_worklog_directory() {
    let temp = tempfile::tempdir().expect("temp dir");
    let state_home = temp.path().join("state");
    let home_dir = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");

    let output = bob_command_with_temp_state(&state_home, &home_dir)
        .current_dir(&workspace)
        .args(["worklog", "list"])
        .output()
        .expect("bob binary to run");

    assert_eq!(
        output.status.code(),
        Some(1),
        "bob worklog list must exit non-zero when worklog/ is absent; stdout: {}",
        String::from_utf8_lossy(&output.stdout)
    );
    let stderr = String::from_utf8(output.stderr).expect("utf8 stderr");
    let expected_dir = workspace.join("worklog");
    assert!(
        stderr.contains(&expected_dir.display().to_string()),
        "stderr must name the worklog directory it expected ({}); got: {stderr}",
        expected_dir.display()
    );
    assert!(
        !expected_dir.exists(),
        "a failed list must not create the worklog directory"
    );
}

/// AC-4: WHEN a prior-day worklog file with an open item exists and `bob
/// worklog list` runs for a later day THE SYSTEM SHALL show a carried-forward
/// entry for that item and report it in the carried-forward set.
#[test]
fn worklog_list_carries_a_prior_day_open_item_forward_and_reports_it() {
    let temp = tempfile::tempdir().expect("temp dir");
    let state_home = temp.path().join("state");
    let home_dir = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    write_prior_day_open_item(&workspace, "2000-01-01", "vendor-invoice");

    let output = bob_command_with_temp_state(&state_home, &home_dir)
        .current_dir(&workspace)
        .args(["worklog", "list"])
        .output()
        .expect("bob binary to run");

    assert_eq!(
        output.status.code(),
        Some(0),
        "bob worklog list must succeed; stderr: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).expect("utf8 stdout");
    assert!(
        stdout.contains("- Done: Carried forward from 2000-01-01.md"),
        "list must render a carried-forward entry sourced from the prior-day file: {stdout}"
    );
    assert!(
        stdout.contains("vendor-invoice"),
        "the carried-forward entry must name the open item: {stdout}"
    );
    assert!(
        stdout.contains("carried forward: vendor-invoice"),
        "list must report the item in today's carried-forward set: {stdout}"
    );
}

/// AC-5: WHEN `bob worklog append` is invoked twice for the same day after a
/// carry-forward THE SYSTEM SHALL leave exactly one carried-forward entry for
/// that item in today's file.
#[test]
fn worklog_append_twice_the_same_day_keeps_exactly_one_carried_forward_entry() {
    let temp = tempfile::tempdir().expect("temp dir");
    let state_home = temp.path().join("state");
    let home_dir = temp.path().join("home");
    let workspace = temp.path().join("workspace");
    std::fs::create_dir_all(&workspace).expect("workspace");
    write_prior_day_open_item(&workspace, "2000-01-01", "vendor-invoice");

    let first = bob_command_with_temp_state(&state_home, &home_dir)
        .current_dir(&workspace)
        .args([
            "worklog",
            "append",
            "--item",
            "morning-standup",
            "--done",
            "Reviewed the overnight alerts.",
            "--left",
            "nothing",
            "--next",
            "nothing further",
        ])
        .output()
        .expect("bob binary to run");
    assert_eq!(
        first.status.code(),
        Some(0),
        "first append must succeed; stderr: {}",
        String::from_utf8_lossy(&first.stderr)
    );

    let second = bob_command_with_temp_state(&state_home, &home_dir)
        .current_dir(&workspace)
        .args([
            "worklog",
            "append",
            "--item",
            "afternoon-review",
            "--done",
            "Walked the release checklist.",
            "--left",
            "nothing",
            "--next",
            "nothing further",
        ])
        .output()
        .expect("bob binary to run");
    assert_eq!(
        second.status.code(),
        Some(0),
        "second append must succeed; stderr: {}",
        String::from_utf8_lossy(&second.stderr)
    );

    let first_stdout = String::from_utf8(first.stdout).expect("utf8 stdout");
    let day_file = parse_recorded_path(&first_stdout);
    let content = std::fs::read_to_string(&day_file).expect("today's worklog file");

    assert_eq!(
        content
            .matches("Carried forward from 2000-01-01.md")
            .count(),
        1,
        "a second same-day append must not add a second carried-forward copy: {content}"
    );
    assert_eq!(
        content.matches("\u{2014} vendor-invoice").count(),
        1,
        "exactly one carried-forward entry header for the item must remain: {content}"
    );
    assert!(
        content.contains("morning-standup") && content.contains("afternoon-review"),
        "both same-day appends must still be recorded: {content}"
    );
}

fn bob_command_with_temp_state(state_home: &Path, home_dir: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_bob"));
    command
        .env("XDG_STATE_HOME", state_home)
        .env("HOME", home_dir);
    command
}

/// Pull the day-file path out of `bob worklog append`'s text output, whose
/// second line is `path: <absolute path>`.
fn parse_recorded_path(append_stdout: &str) -> PathBuf {
    append_stdout
        .lines()
        .find_map(|line| line.strip_prefix("path: "))
        .map(|rest| PathBuf::from(rest.trim()))
        .expect("append output must contain a `path:` line")
}

/// Whether `path`'s file name is `<YYYY-MM-DD>.md` — the shape S-015 fixes
/// for a day file, without this test needing to know the binary's clock.
fn is_iso_dated_markdown_name(path: &Path) -> bool {
    let Some(stem) = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix(".md"))
    else {
        return false;
    };
    let bytes = stem.as_bytes();
    bytes.len() == 10
        && bytes.iter().enumerate().all(|(index, byte)| {
            if index == 4 || index == 7 {
                *byte == b'-'
            } else {
                byte.is_ascii_digit()
            }
        })
}

/// Hand-write a prior-day worklog file `<dir>/worklog/<date>.md` holding one
/// still-open item, in the S-015 Contract shape: a `## HH:MM — <item>` header,
/// a blank line, then `- Done:` / `- Left:` / `- Next:` bullets with `- Left:`
/// set to something other than `nothing`, so the item classifies as open.
/// This is the nearest existing prior file, so its open item carries forward
/// into today's file on the next `bob worklog` invocation.
fn write_prior_day_open_item(working_dir: &Path, date: &str, item: &str) {
    let worklog_dir = working_dir.join("worklog");
    std::fs::create_dir_all(&worklog_dir).expect("create prior-day worklog dir");
    let body = format!(
        "## 09:00 \u{2014} {item}\n\n\
         - Done: Chased the vendor for the missing PDF.\n\
         - Left: awaiting the corrected invoice\n\
         - Next: closes when the corrected invoice arrives\n"
    );
    std::fs::write(worklog_dir.join(format!("{date}.md")), body)
        .expect("write prior-day worklog file");
}
