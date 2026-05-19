---
id: T-043
title: Make BobConfig socket-path fields non-empty by construction
status: pending
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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
