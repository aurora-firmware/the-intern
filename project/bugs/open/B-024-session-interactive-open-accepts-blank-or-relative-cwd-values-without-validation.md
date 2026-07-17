---
id: B-024
title: session.interactive.open accepts blank or relative cwd values without 
  validation
severity: medium
status: open
created: '2026-07-17'
---

# session.interactive.open accepts blank or relative cwd values without validation

## Summary

`Dispatcher::handle_session_interactive_open` in
`the-intern/service/crates/admin-rpc/src/dispatch.rs` parses an optional
`params.cwd` string and forwards it unvalidated into the interactive-session
spawn config, which is passed straight to `Command::current_dir` in
`InteractiveProcess::spawn`
(`the-intern/service/crates/pi-agent-supervisor/src/process.rs`). Unlike the
sibling `schedule.add` RPC method — which commit
`82302c2 fix(service): address pr review findings` fixed to reject blank or
non-string `cwd` values with `CODE_INVALID_REQUEST` — `session.interactive.open`
performs no validation at all: empty strings, whitespace-only strings, and
relative paths are all accepted and passed through, producing
location-dependent spawn failures or a child launched relative to `bob
serve`'s own cwd instead of a clear RPC error. This was flagged in the local
PR #38 review (`pr-38-review.md`) and confirmed still present by direct code
inspection against the current `dev-agent` tip.

## Reproduction Status

Status: confirmed (static — deterministic parsing/validation gap, verified by
reading the current handler).

## Evidence

- `the-intern/service/crates/admin-rpc/src/dispatch.rs:456-483` (current
  `dev-agent` tip, `57f6506`), `handle_session_interactive_open`:
  ```rust
  let cwd = params
      .as_ref()
      .and_then(|p| p.get("cwd"))
      .and_then(Value::as_str)
      .map(PathBuf::from);
  ```
  No check for blank/whitespace-only strings and no check that the path is
  absolute — contrast with `schedule.add`'s `cwd` parsing at
  `dispatch.rs:673-697`, which rejects non-string and blank values with
  `CODE_INVALID_REQUEST` ("schedule.add: params.cwd must be a non-blank
  absolute path string when present").
- `the-intern/service/crates/pi-agent-supervisor/src/process.rs:334`:
  `InteractiveProcess::spawn` calls `cmd.current_dir(cwd)` unconditionally
  when `cwd` is `Some`, with no re-validation at the spawn boundary.
- `pr-38-review.md` (local, uncommitted PR review report) finding:
  "\[suggestion\] `session.interactive.open` accepts malformed `cwd` values and
  passes them straight to `current_dir`, producing location-dependent
  failures instead of a clear RPC error —
  `the-intern/service/crates/admin-rpc/src/dispatch.rs:470`".

## Reproduction Steps

1. Send a `session.interactive.open` JSON-RPC request with
   `"params": {"cwd": ""}` or `"params": {"cwd": "   "}` or
   `"params": {"cwd": "relative/dir"}`.
2. Observe the dispatcher accepts the request and forwards the value into
   `InteractiveProcessConfig.cwd` without error.
3. Observe the spawned child either fails with a raw OS spawn error (for an
   empty/invalid path) or launches relative to `bob serve`'s own working
   directory (for a relative path) instead of returning a clear
   `CODE_INVALID_REQUEST` RPC error to the caller.

## Expected Behavior

`session.interactive.open`'s `params.cwd`, when present, should be validated
the same way `schedule.add`'s `cwd` is validated: require a non-blank,
absolute path string, otherwise return `CODE_INVALID_REQUEST` with a clear
message — never silently forward a blank/relative value to `current_dir`.

## Actual Behavior

Any string value (including empty, whitespace-only, or relative paths) is
accepted and forwarded unchanged to the spawn config, producing ambiguous or
confusing failures instead of a clear RPC-level rejection.

## Environment

- OS / platform: Linux (also applies to macOS; not platform-specific).
- Language / runtime version: Rust workspace at `the-intern/service`.
- Relevant dependencies: `tokio::process::Command::current_dir` semantics.
- Branch / commit: `dev-agent` at `57f6506d60581da4c76a18d9a6aa84d6bdf59b4d`
  (PR #38 head); the interactive-session `cwd` path was added by B-021/CR-005
  work and never received the same validation `schedule.add`'s `cwd` got in
  `82302c2`.

## Related

- PR: `#38` (`Promote dev-agent → main: scheduler JSON-state persistence,
  reliability fixes, per-entry cwd resolution`).
- Local review report: `pr-38-review.md` (uncommitted, working tree only) —
  originating finding.
- Bug: `B-021` (introduced the `session.interactive.open` `params.cwd` path
  this bug's validation gap lives in).
- Change request: `CR-005-configurable-working-directory-for-bob-serve-workers-and-scheduled-entries.md`.

## Suspected Area

`the-intern/service/crates/admin-rpc/src/dispatch.rs::handle_session_interactive_open`
— needs the same non-blank/absolute-path validation `schedule.add`'s `cwd`
parsing already has (dispatch.rs:673-697), returning `CODE_INVALID_REQUEST`
on failure instead of constructing a `PathBuf` from an unvalidated string.

## Fix Verification

```bash
# A regression test should assert session.interactive.open with a blank,
# whitespace-only, or relative params.cwd returns CODE_INVALID_REQUEST rather
# than opening the session:
cd the-intern/service && cargo test -p admin-rpc dispatch_session_interactive_open
cd the-intern/service && cargo test --workspace
```

## Diagnosis Log

## Work Log

## Review
