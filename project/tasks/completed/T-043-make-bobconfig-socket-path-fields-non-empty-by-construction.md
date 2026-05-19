---
id: T-043
title: Make BobConfig socket-path fields non-empty by construction
status: completed
priority: medium
assigned-role: unassigned
created: '2026-05-19'
---

# Make BobConfig socket-path fields non-empty by construction

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

`BobConfig::default()` produces `admin_sock_path: PathBuf::new()` and `extension_sock_path: PathBuf::new()`, both empty. `bob::serve` requires them non-empty to bind a UDS. The production default is therefore unbootable; intent lives in `defaults_with_runtime_root` but the type doesn't enforce it. Make the empty state unrepresentable — either use a wrapper newtype that validates on construction, or remove `Default` and force callers through a `try_new` / `defaults_with_runtime_root` factory.

## Acceptance Criteria

AC-1: IF `BobConfig` is constructed with an empty socket path THEN the construction SHALL fail at compile time or return an error at runtime, never silently produce a non-bootable runtime.
AC-2: WHEN existing call sites construct `BobConfig` via `defaults_with_runtime_root(...)` THE SYSTEM SHALL continue to work without changes (or be migrated to the new factory).
AC-3: WHEN `cargo test -p bob` runs THE SYSTEM SHALL pass.

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — introduce the validating type or remove `Default`.
- `the-intern/service/crates/bob/src/serve.rs` — adjust call sites only if the API changes.

## Verification

```bash
cd the-intern/service
cargo test -p bob
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-19

**What was done.** Implemented both halves of AC-1: runtime validation and compile-time enforcement. Added two new tests (`returns_configuration_error_when_admin_sock_path_is_empty` and `returns_configuration_error_when_extension_sock_path_is_empty`) that drove the addition of empty-path checks at the top of `BobConfig::validate()`. Those tests went red-then-green with a four-line change. In the refactor step, `impl Default for BobConfig` was removed entirely and replaced with `#[cfg(test)] pub(crate) fn test_base() -> Self` carrying the same field values, so the empty-path state is unrepresentable outside `#[cfg(test)]` contexts. All `..BobConfig::default()` call sites across seven files in the `bob` crate were mechanically migrated to `..BobConfig::test_base()`.

**What was tried and rejected.** Keeping `Default` but routing it through `validate()` was considered — rejected because `Default::default()` must return `Self` (infallible) and cannot call `validate()` which returns `ServiceResult<Self>`. Adding validation only to `load_with_sources` without removing `Default` was also considered, but that leaves `BobConfig::default()` producing empty paths silently, which violates AC-1's "never silently produce a non-bootable runtime" requirement.

**Decisions made.** The chosen approach: remove `Default`, add runtime validation in `validate()`, introduce a test-only `test_base()` as the spread-base for unit tests. This satisfies AC-1 in two layers (compile-time: `Default` gone; runtime: validate rejects empty paths), keeps AC-2 intact (all `load_with_sources` paths produce non-empty paths via `defaults_with_runtime_root`), and satisfies AC-3 (all 60 tests pass). Modifying files beyond `config.rs` and `serve.rs` was necessary to compile — all additional changes were in `#[cfg(test)]` blocks within the same crate.

**What remains.** Nothing; all acceptance criteria are met and all tests pass.

**Obstacles encountered.** `BobConfig::default()` appeared in seven files rather than the two listed in "Files to Touch". All extra usages were confined to `#[cfg(test)]` blocks, so the migration was purely mechanical and no escalation was warranted.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-19

PASS

Stage 1 (spec compliance): all three acceptance criteria are met.

- AC-1: `impl Default for BobConfig` is removed, enforcing the constraint at compile time for all non-test code. `validate()` adds two runtime guards at the top of the function that return `ServiceError::Configuration` with a message naming the offending field when either socket path is empty. Both layers confirmed in the diff.
- AC-2: The production path (`load_with_sources` → `defaults_with_runtime_root`) is unchanged and continues to produce non-empty paths. No production call site was broken.
- AC-3: `cargo test -p bob` ran 61 tests (54 unit + 7 integration); all passed.

Files modified beyond the stated scope (`audit.rs`, `chat.rs`, `admin_rpc.rs`, `lib.rs`, `telemetry.rs`) were all `#[cfg(test)]` blocks within the same crate performing mechanical `BobConfig::default()` → `BobConfig::test_base()` substitutions, justified in the Work Log.

Stage 2 (code quality): no issues found.

- Correctness: `as_os_str().is_empty()` correctly identifies `PathBuf::new()`; checks run before the existing capacity guards.
- Tests: two new tests cover each empty-path case independently via `load_with_sources`; the `test_base_has_pi_agent_rpc_worker_and_positive_pool_limits` rename correctly tracks the API change.
- Security: no new permissions, no hardcoded secrets, input validation added.
- Readability: comment block explaining the intentional absence of `Default`, and the `test_base()` docstring warning against misuse, are both clear and appropriately scoped.
- Performance: no regressions.

Minor observation (non-blocking): `serve.rs` contains a few cosmetic line-reflow changes (e.g., `audit_sink` and `extension_ipc_handle` binding style, one `assert_eq!` argument alignment) that are outside the task scope but harmless.
