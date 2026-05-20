---
id: T-052
title: Add the lock-free ruleset snapshot handle and reload-capable 
  policy-control actor
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Add the lock-free ruleset snapshot handle and reload-capable policy-control actor

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

Phase 2 of S-004. Replace the `policy-control` scaffold actor with the real
one and add the lock-free snapshot handle both gates will read.

Add:

- `SnapshotHandle` — a cheaply cloneable handle wrapping the active
  `RulesetSnapshot` behind `arc-swap` so readers never block writers;
  exposes a read returning the current `Arc<RulesetSnapshot>`. This is what
  the two gates hold (wired in T-053/T-054/T-056).
- A rewritten actor whose `Config` carries the initial `RulesetSnapshot`
  and the path to bob's config file. **`Config` must keep a working
  `Default`** (empty deny-all snapshot, empty path) so `bob::serve`
  continues to compile before T-053 supplies a real config.
- A `Reload` command and `Handle::reload()` (async, returns `Result`):
  re-read the config file, parse its `[policy]` table into `PolicyConfig`,
  build a new `RulesetSnapshot`, and on success atomically swap it into the
  `SnapshotHandle`; on parse/validation failure return the error and leave
  the previous snapshot in force.
- `start(Config)` returns the `Handle`, the actor `JoinHandle`, and the
  `SnapshotHandle`.

Keep the existing `Handle` type name so `admin-rpc` and `bob` still
reference it. Provide a helper that loads `PolicyConfig` from a TOML file
path (reading only the `[policy]` table).

## Acceptance Criteria

AC-1: The system shall provide a cheaply cloneable `SnapshotHandle`, backed by `arc-swap`, that returns the current `RulesetSnapshot` without blocking writers.
AC-2: The system shall provide a `policy-control` `Config` with a working `Default` that yields a deny-all snapshot so dependent crates compile without a real config.
AC-3: WHEN `Handle::reload()` is called and the config file's `[policy]` table parses and validates THE SYSTEM SHALL build a new snapshot and atomically swap it into the `SnapshotHandle`.
AC-4: IF `Handle::reload()` is called and the new config fails to parse or validate THEN THE SYSTEM SHALL return an error and leave the previously active snapshot in force.
AC-5: WHEN the `policy-control` actor starts THE SYSTEM SHALL serve the initial snapshot supplied in its `Config` through the `SnapshotHandle`.

## Dependencies

- `T-051` — uses `PolicyEngine`, `RulesetSnapshot`, and `PolicyConfig`; rewrites the actor in `policy-control/src/lib.rs`.

## Files to Touch

- `the-intern/service/crates/policy-control/src/lib.rs` — rewrite the actor, `Config`, `Handle`; add `SnapshotHandle` and the updated `start`.
- `the-intern/service/crates/policy-control/Cargo.toml` — add `arc-swap` and `toml` if absent.

## Verification

```bash
cd the-intern/service
cargo test -p policy-control
cargo build -p bob
cargo clippy -p policy-control --all-targets
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

Implemented all five acceptance criteria for T-052 in a single TDD session.

**What was done.** The scaffold `policy-control` actor was rewritten to introduce `SnapshotHandle` (AC-1), a revised `Config` with a working `Default` yielding a deny-all snapshot (AC-2), `Handle::reload()` that atomically swaps the snapshot on successful parse/validation and returns an error while preserving the previous snapshot on failure (AC-3, AC-4), and an updated `start` function that returns the `(Handle, JoinHandle, SnapshotHandle)` triple and immediately seeds the snapshot from `Config::initial_snapshot` (AC-5). The `toml` dependency was promoted from dev-only to a production dependency; `arc-swap = "1"` and `tempfile = "3"` (dev) were added to the crate manifest.

A `Default` derive was added to `PolicyConfig` in `ruleset.rs` — required because the private `Root` struct used in `load_policy_config_from_toml_str` carries `#[serde(default)]` on its `policy` field, which serde's derive requires.

**Files touched outside the task's listed scope.** `bob/src/serve.rs` was updated by one line — the `start()` call was changed from a 2-tuple destructuring to a 3-tuple destructuring (`_policy_snapshot` discarded with `_`). This was unavoidable: the verification command `cargo build -p bob` would otherwise fail. The change is trivially mechanical and introduces no logic.

**What was tried and rejected.** An early draft kept a `snapshot: SnapshotHandle` field on `Handle` so callers could reach the snapshot through the handle rather than through the separately returned `SnapshotHandle`. This produced a dead-code warning and was not needed by the spec (gates hold `SnapshotHandle` directly per T-053/T-054/T-056), so the field was dropped.

**What remains.** Nothing for this task. All 45 tests pass, `cargo build -p bob` succeeds, and `cargo clippy -p policy-control --all-targets` is clean. T-053/T-054/T-056 will wire the returned `SnapshotHandle` into the gate crates.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
