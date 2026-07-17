---
id: B-024
title: session.interactive.open accepts blank or relative cwd values without 
  validation
severity: medium
status: in-progress
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

### Diagnosis 1 — 2026-07-17

Reproduction status: confirmed (dynamic, via temporary diagnostic test — not just static
inspection).

Evidence captured:
- Added a temporary test in `crates/admin-rpc/src/dispatch.rs`'s `dispatch::tests` module
  dispatching `session.interactive.open` with `params.cwd` set to `""`, `"   "`, and
  `"relative/dir"` in turn, and printing the resulting `DispatchOutcome`. All three malformed
  values were accepted and forwarded as `Some(PathBuf)` in the `InteractiveSessionOpening`
  outcome — no `CODE_INVALID_REQUEST` was ever produced. The temporary test was removed after
  capturing this evidence.
- Read `handle_session_interactive_open` (`crates/admin-rpc/src/dispatch.rs:456-485`, current
  `dev-agent` tip): `cwd` is built with
  `params.as_ref().and_then(|p| p.get("cwd")).and_then(Value::as_str).map(PathBuf::from)` — no
  trim/blank check, no type-mismatch error, no absolute-path check.
- Read `schedule.add`'s `cwd` parsing (`dispatch.rs:673-697`): rejects a non-string `params.cwd`
  and a blank/whitespace-only string with `CODE_INVALID_REQUEST`. Precision beyond the bug
  report's framing: this dispatch-level check only covers type and blank, not absolute-path-ness.
  The absolute-path requirement for `schedule.add`'s `cwd` is actually enforced one layer
  downstream, in `validate_schedule_store` (`crates/bob-core/src/types/schedule.rs:138-152`),
  which runs during `write_and_reload` via `write_schedule_store`.
- Traced the `session.interactive.open` cwd path end-to-end and found no equivalent downstream
  validation layer exists for it: `DispatchOutcome::InteractiveSessionOpening` →
  `handle_interactive_session_opening` (`crates/admin-rpc/src/lib.rs:326-341`) passes `cwd`
  straight into the interactive-session start call → `InteractiveProcessConfig.cwd` →
  `InteractiveProcess::spawn` (`crates/pi-agent-supervisor/src/process.rs:306-336`), where
  `cmd.current_dir(cwd)` is called unconditionally whenever `cfg.cwd` is `Some`, with no re-check.
- Found an existing test that currently encodes the pre-fix contract and will conflict with the
  planned fix: `dispatch_session_interactive_open_with_non_string_params_cwd_leaves_cwd_none`
  (`dispatch.rs:3011-3031`) asserts a non-string `params.cwd` (e.g. `42`) is silently treated as
  `None` rather than erroring. Mirroring `schedule.add`'s type check means this test's expected
  behavior must change to `CODE_INVALID_REQUEST` as part of the fix.

Isolated fault: `Dispatcher::handle_session_interactive_open` in `crates/admin-rpc/src/dispatch.rs`,
lines 470-474 (the `let cwd = ...` block). This is the sole point where `params.cwd` is parsed for
this method, and it performs zero validation before constructing the `PathBuf` that is forwarded,
unconditionally, all the way to `Command::current_dir`.

Root cause: when `params.cwd` forwarding was added to `session.interactive.open` for CR-005/B-021,
no validation was added alongside it — unlike `schedule.add`, whose `cwd` support (added later, in
`82302c2`) got both a dispatch-level type/blank check and a downstream absolute-path check via
`validate_schedule_store`. `session.interactive.open` has no downstream validation layer at all (it
goes directly to process spawn), so the omission at the single parse site is a complete gap: blank
strings, whitespace-only strings, relative paths, and non-string values are all silently accepted.

Planned fix: in `handle_session_interactive_open`, replace the unconditional `.map(PathBuf::from)`
parse with explicit validation mirroring `schedule.add`'s dispatch-level check plus the
absolute-path check that, for `schedule.add`, currently lives downstream in
`validate_schedule_store` — since `session.interactive.open` has no such downstream layer, both
checks must live directly in the handler:
- If `params.cwd` is present and not a JSON string → `CODE_INVALID_REQUEST`.
- If present and, after trimming, empty → `CODE_INVALID_REQUEST`.
- If present, non-blank, but not an absolute path (`Path::new(trimmed).is_absolute()` is `false`)
  → `CODE_INVALID_REQUEST`.
- Otherwise, construct `Some(PathBuf::from(trimmed))`.
Use an error message in the style of `schedule.add`'s ("session.interactive.open: params.cwd must
be a non-blank absolute path string when present"). Also update
`dispatch_session_interactive_open_with_non_string_params_cwd_leaves_cwd_none` to assert
`CODE_INVALID_REQUEST` instead of silent `None`, since the fix changes that contract.

Planned verification:
- New/updated tests in `crates/admin-rpc/src/dispatch.rs` asserting `CODE_INVALID_REQUEST` for
  `params.cwd` = `""`, `"   "`, `"relative/dir"`, and a non-string value (e.g. `42`), and asserting
  the existing valid-absolute-path case
  (`dispatch_session_interactive_open_with_params_cwd_parses_it_into_outcome`) still parses into
  `Some(PathBuf)` unchanged.
- `cd the-intern/service && cargo test -p admin-rpc dispatch::tests` and
  `cargo test -p admin-rpc` — both must pass with 0 failures.
- `cd the-intern/service && cargo test --workspace`, to confirm no regression elsewhere (e.g. the
  `run_connection_session_interactive_open_with_params_cwd_spawns_child_in_that_directory`
  end-to-end test, which uses a valid absolute path and must remain green).

## Work Log

### Session 1 — 2026-07-17

Implemented the fix contract from the Diagnosis Log for B-024. `handle_session_interactive_open`
(`the-intern/service/crates/admin-rpc/src/dispatch.rs`) previously parsed `params.cwd` with
`.and_then(Value::as_str).map(PathBuf::from)` — zero validation. Replaced this with an explicit
match that mirrors `schedule.add`'s dispatch-level checks: a non-string `cwd` value, a
blank/whitespace-only string (after `.trim()`), or a non-absolute path
(`Path::new(trimmed).is_absolute()` false) all return `DispatchOutcome::Err` with
`CODE_INVALID_REQUEST` and the message "session.interactive.open: params.cwd must be a non-blank
absolute path string when present". A valid absolute path is trimmed and wrapped in
`Some(PathBuf::from(trimmed))` as before.

Followed the tdd skill strictly: wrote four new failing tests first
(`dispatch_session_interactive_open_with_empty_string_cwd_returns_invalid_request`,
`..._with_whitespace_only_cwd_returns_invalid_request`,
`..._with_relative_cwd_returns_invalid_request`, and a rewritten
`..._with_non_string_params_cwd_returns_invalid_request` replacing the old
`..._leaves_cwd_none` test that encoded the pre-fix, buggy contract). Confirmed all four failed
against the unfixed handler, then implemented the minimal fix and confirmed green.

Considered whether the absolute-path check should live downstream (as it does for `schedule.add`,
in `validate_schedule_store`), but the Diagnosis Log's fix contract was explicit that
`session.interactive.open` has no downstream validation layer (it goes straight to process spawn
via `InteractiveProcess::spawn`), so both the type/blank check and the absolute-path check had to
be added directly in the dispatch handler. No alternative design was pursued.

Ran the full verification matrix: `cargo test -p admin-rpc dispatch::tests` (66 passed),
`cargo test -p admin-rpc` full crate (116 passed, including the end-to-end
`run_connection_session_interactive_open_with_params_cwd_spawns_child_in_that_directory` test using
a valid absolute path, which remained green), `cargo test --workspace` (all binaries 0 failed), and
`cargo fmt --all -- --check` (clean). Nothing remains outstanding for this bug. Only `dispatch.rs`
was modified and committed (commit `1fec028`).

**Obstacles Encountered:** None blocking. Pre-existing, unrelated working-tree state
(`pr-35-review.md`/`pr-38-review.md`) was left untouched.

## Review

### Review Verdict — 2026-07-17

PASS

**Evidence chain (bug-fix specific checks):**
- Diagnosis Log ("Diagnosis 1 — 2026-07-17") records reproduction status as
  confirmed **dynamically**, via a temporary diagnostic test added to
  `dispatch::tests` (dispatching `session.interactive.open` with
  `params.cwd` = `""`, `"   "`, `"relative/dir"` and observing all three were
  silently accepted as `Some(PathBuf)`), not just static code reading. The
  temporary test was removed after capturing evidence — no leftover
  diagnostic artifacts found in the diff.
- Isolated fault, root cause, planned fix, and planned verification are all
  present and specific (dispatch.rs:470-474, the unconditional
  `.map(PathBuf::from)` parse site).
- Implementation matches the fix contract exactly: `handle_session_interactive_open`
  (`the-intern/service/crates/admin-rpc/src/dispatch.rs:470-497` on the bug
  branch) now rejects a non-string `params.cwd`, a blank/whitespace-only
  string (after `.trim()`), and a non-absolute path
  (`Path::new(trimmed).is_absolute()` false) with `CODE_INVALID_REQUEST` and
  message "session.interactive.open: params.cwd must be a non-blank absolute
  path string when present"; a valid absolute path is trimmed and wrapped in
  `Some(PathBuf::from(trimmed))` unchanged.
- Error-message style matches `schedule.add`'s cwd validation
  (`dispatch.rs:673-697` on `dev-agent`) exactly in wording and structure
  (`match ... { None => None, Some(value) => { ... } }`), consistent with
  the Diagnosis Log's stated rationale that both the type/blank check and
  the absolute-path check had to live in the dispatch handler here (unlike
  `schedule.add`, `session.interactive.open` has no downstream validation
  layer before reaching `Command::current_dir`).

**Stage 1 — Bug criteria:**
- Blank (`""`), whitespace-only (`"   "`), relative (`"relative/dir"`), and
  non-string (`42`) `params.cwd` values each verified (by test and by
  reading the code) to return `CODE_INVALID_REQUEST`.
- A valid absolute `params.cwd` still parses into `Some(PathBuf)` unchanged
  — confirmed via `dispatch_session_interactive_open_with_params_cwd_parses_it_into_outcome`
  (untouched) and the end-to-end
  `run_connection_session_interactive_open_with_params_cwd_spawns_child_in_that_directory`
  test in `lib.rs`, which uses `std::env::temp_dir().join(...)` (absolute)
  and passed.
- Only `the-intern/service/crates/admin-rpc/src/dispatch.rs` was modified
  (confirmed via `git diff --stat dev-agent...bug/B-024-...`); no unrelated
  changes present.
- Grepped for other `session.interactive.open` callers/consumers
  (`the-intern/service/crates`, `the-intern/extensions`, `the-intern/docs`):
  the sole real client is `bob chat`
  (`the-intern/service/crates/bob/src/cli/commands/chat.rs`), which builds
  `params.cwd` from `std::env::current_dir()` — always an absolute path on
  Unix — so nothing in the codebase relied on the old silent-`None`
  treatment of blank/relative/non-string `cwd`. The downstream
  `handle_interactive_session_opening` (`lib.rs`) still receives
  `Option<PathBuf>` unchanged; the new rejection happens earlier, at
  dispatch, so no downstream contract was altered.

**Stage 2 — Code quality:**
- Correctness: logic mirrors `schedule.add`'s validation; trims before both
  the blank and absolute-path checks; only meaningfully-invalid inputs are
  rejected.
- Tests: four new focused tests
  (`..._with_non_string_params_cwd_returns_invalid_request` [rewritten from
  the old `..._leaves_cwd_none` test, which encoded the pre-fix contract and
  now genuinely asserts `CODE_INVALID_REQUEST`, not a tautology],
  `..._with_empty_string_cwd_...`, `..._with_whitespace_only_cwd_...`,
  `..._with_relative_cwd_...`), each independent (fresh dispatcher/registry
  per test), asserting response id, `CODE_INVALID_REQUEST` code, and that
  the message mentions "cwd".
- No debugging artifacts, dead code, or unrelated refactoring found in the
  diff (`git diff dev-agent...bug/B-024-...` limited to the validation block
  and its four new/updated tests).
- Bug-fix addendum: fix is minimal (126 insertions / 16 deletions, all in
  `dispatch.rs`); Diagnosis Log fix contract matches what was implemented,
  including the explicit deviation from `schedule.add` (absolute-path check
  inline rather than in a downstream validator) with a stated rationale.

**Re-run verification (bug branch `bug/B-024-session-interactive-open-cwd-validation`, commit `1fec028`, via a temporary worktree):**
- `cd the-intern/service && cargo test -p admin-rpc` — 116 passed, 0 failed
  (includes all four new tests and the unchanged end-to-end
  `run_connection_session_interactive_open_with_params_cwd_spawns_child_in_that_directory`).
- `cd the-intern/service && cargo test --workspace` — all crates passed, 0
  failed, 0 `FAILED`/panic lines in the full output.
- `cargo fmt --all -- --check` — clean, no diff.

No blocking issues found. Both review stages pass.

Next owner: Bug-Fix Loop.
