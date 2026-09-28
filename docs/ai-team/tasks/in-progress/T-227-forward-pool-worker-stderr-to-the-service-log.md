---
id: T-227
title: Forward pool-worker stderr to the service log
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-29'
---

# Forward pool-worker stderr to the service log

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Forward every RPC pool worker's stderr to the service log (CR-015; S-002 v0.2
Component 6 "Worker stderr"; S-003 v0.3). Today `RpcWorkerProcess::spawn`
(`crates/pi-agent-supervisor/src/process.rs`) pipes stderr into
`_stderr: ChildStderr` and never reads it. pi reports start-up failures there
— for example `Error: Model "<x>" not found.` for an unrecognized `--model`
(issue #104) — and the bob extension writes its warning or transport-lost error
there when it has no UI, so today all of that is lost. An unread pipe also
blocks the child once the OS pipe buffer fills.

Replace the held `ChildStderr` with a background reader started at spawn:
read raw bytes up to each newline, decode with `String::from_utf8_lossy`, and
log each line with `tracing::warn!`, tagged with the worker's session id
(`cfg.session_id`). Invalid UTF-8 must never stop the reader — only EOF
(worker exited or terminated) or a genuine I/O error ends it, the latter with
one log line and never a panic. Every line is logged at warning level: no rate
limiting, filtering, or level change (S-002). The existing test
`spawn_starts_configured_command_with_piped_stdio` (`process.rs` ~853)
references `worker._stderr` and must be updated.
It must not keep a terminated worker alive or delay `terminate()`.
`spawn` is synchronous but always called inside the Tokio runtime (actor and
`#[tokio::test]`); confirm this for every call site. Interactive sessions are
out of scope: their stderr is the user's terminal fd and stays untouched.
For tests, use fake workers (`sh -c '…'`) as existing process tests do, and a
tracing-capture approach already used in the workspace (e.g. the
`extension-ipc` multiplex tests); add a dev-dependency only if needed.

## Acceptance Criteria

AC-1: WHEN a pool worker writes a line to stderr THE SYSTEM SHALL log that line
      at warning level with the worker's session id.
AC-2: WHEN a worker's stderr reaches end of file THE SYSTEM SHALL end the
      reader without an error log or panic.
AC-3: IF a worker writes more than 64 KiB to stderr THEN THE SYSTEM SHALL keep
      draining so the worker does not block (a worker writing 200 KiB to stderr
      then exiting finishes within the test timeout).
AC-4: IF a worker writes bytes that are not valid UTF-8 to stderr THEN THE
      SYSTEM SHALL log them lossily decoded and keep reading, so a later valid
      line is still logged.
AC-5: The system shall leave interactive-session stderr handling unchanged.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — stderr
  reader task and tests
- `the-intern/service/crates/pi-agent-supervisor/Cargo.toml` — test
  dev-dependency, only if needed for tracing capture (`tracing-subscriber`
  is not a dependency of this crate today)
- `the-intern/service/Cargo.lock` — only if a dev-dependency is added

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor && cargo fmt --all -- --check
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
