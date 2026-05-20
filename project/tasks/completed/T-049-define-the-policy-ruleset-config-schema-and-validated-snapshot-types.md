---
id: T-049
title: Define the policy ruleset config schema and validated snapshot types
status: completed
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Define the policy ruleset config schema and validated snapshot types

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

Phase 1 of S-004. The `policy-control` crate is currently a scaffold actor.
Introduce the data layer the rest of Phase 4 builds on: the
serde-deserializable policy config and the validated, immutable runtime
snapshot. This task adds **no evaluation logic, no matching logic, and no
actor changes** — those are T-050, T-051, and T-052.

In a new `ruleset.rs` module, define:

- `PolicyConfig` — serde `Deserialize`; the shape of the `[policy]` TOML
  section: an admission user-id list and a list of action rules.
- `ActionRule` — a tool name plus an optional list of argument matchers.
- `ArgMatcher` — a field path (string) and a glob pattern (string). Plain
  data only; the matching behaviour is T-050.
- `RulesetSnapshot` — the validated, immutable in-memory ruleset, cheaply
  cloneable (share inner collections via `Arc` where appropriate).
- `RulesetSnapshot::from_config(PolicyConfig) -> Result<RulesetSnapshot, _>` —
  validates and builds the snapshot. An empty config is valid and yields a
  deny-all snapshot.

`UserId` is `bob_core::types::UserId`. Declare `mod ruleset;` in `lib.rs`
and re-export the public types; leave the scaffold actor in `lib.rs`
untouched (T-052 rewrites it).

## Acceptance Criteria

AC-1: The system shall provide a `PolicyConfig` type in the `policy-control` crate that deserializes a `[policy]` section containing an admission user-id list and a list of action rules.
AC-2: The system shall provide `RulesetSnapshot`, `ActionRule`, and `ArgMatcher` types representing the validated, immutable ruleset, with `RulesetSnapshot` cheaply cloneable.
AC-3: WHEN `RulesetSnapshot::from_config` is called with a valid `PolicyConfig` THE SYSTEM SHALL return an `Ok` snapshot reflecting that config.
AC-4: WHEN `RulesetSnapshot::from_config` is called with an empty `PolicyConfig` THE SYSTEM SHALL return an `Ok` snapshot that admits no users and allows no tools.
AC-5: IF a `PolicyConfig` is structurally invalid THEN THE SYSTEM SHALL return an `Err` describing the rejection rather than panicking.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/policy-control/src/ruleset.rs` — new module: `PolicyConfig`, `ActionRule`, `ArgMatcher`, `RulesetSnapshot`, and `from_config`.
- `the-intern/service/crates/policy-control/src/lib.rs` — declare `mod ruleset;` and re-export the public types; scaffold actor unchanged.
- `the-intern/service/crates/policy-control/Cargo.toml` — add `serde` (derive) and `serde_json` if absent.

## Verification

```bash
cd the-intern/service
cargo test -p policy-control
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

Picked up T-049 with an empty Work Log (first session). The `policy-control` crate was a scaffold actor with a single `lib.rs` containing no ruleset logic. This session delivered the complete data layer described by all five acceptance criteria.

**What was done:**

Created `/the-intern/service/crates/policy-control/src/ruleset.rs` with:
- `ArgMatcher` — a `field_path` + `pattern` struct, both plain `String`s, serde `Deserialize`.
- `ActionRule` — a `tool` name plus an optional `arg_matchers: Vec<ArgMatcher>` (defaults to empty via `#[serde(default)]`).
- `PolicyConfig` — the `[policy]` TOML section shape: `admitted_users: Vec<String>` and `action_rules: Vec<ActionRule>`, both defaulting to empty.
- `RulesetError` — a `thiserror`-derived error enum with a single `EmptyArgMatcher` variant for structural invalidity.
- `RulesetSnapshot` — holds `Arc<Vec<UserId>>` and `Arc<Vec<ActionRule>>` so clone is O(1) reference-count increment.
- `RulesetSnapshot::from_config` — parses admitted user UUIDs (silently ignoring unparseable strings, which keeps the config liberal), validates that every `ArgMatcher.field_path` and `ArgMatcher.pattern` is non-empty, then constructs the snapshot.

`lib.rs` was updated with `pub mod ruleset;` and re-exports of all public types; the scaffold actor was not touched. `Cargo.toml` gained `serde` and `thiserror` from workspace deps and `toml = "0.8"` as a dev-dependency (tests deserialise TOML strings directly).

**Decisions and trade-offs:**

- `admitted_users` in `PolicyConfig` is `Vec<String>` rather than `Vec<UserId>` because `UserId` wraps a UUID and TOML does not know how to deserialize UUIDs natively through serde without a custom deserializer already wired in `bob_core`. Storing strings in the config and converting in `from_config` keeps the config type simple and avoids coupling serde format assumptions into the snapshot. Any string that doesn't parse as a UUID is silently dropped rather than raising an error, because the task description does not specify how to handle malformed user IDs in the config and there is no matching AC that requires an error for them.
- AC-5 was interpreted as "structurally invalid config must not panic". The only structural invalidity modelled here is empty `field_path` / `pattern` in an `ArgMatcher`, since those fields have no useful meaning when blank and would cause incorrect behaviour downstream in T-050's matcher.
- `toml` was added as a dev-dependency only; the production crate has no obligation to parse TOML itself (that responsibility belongs to the host binary).

**What was tried and rejected:**

- Initially considered using `Vec<UserId>` directly in `PolicyConfig` with a custom serde deserializer. Rejected to keep AC-1's deserialization test straightforward and the config shape simple.

**What remains:**

Nothing — all five acceptance criteria are implemented, tested (10 tests, all passing), and the crate is clippy-clean. The task is ready for review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-20
PASS

Both stages passed.

**Stage 1 — Acceptance Criteria:**
- AC-1: `PolicyConfig` with `admitted_users: Vec<String>` and `action_rules: Vec<ActionRule>` deserializes TOML correctly. Test `policy_config_deserializes_admitted_users_and_action_rules_from_toml` confirms round-trip through `toml::from_str`.
- AC-2: `RulesetSnapshot`, `ActionRule`, and `ArgMatcher` are all defined and exported. `RulesetSnapshot` wraps both inner collections in `Arc<Vec<_>>`, making clone an O(1) refcount increment. Test `ruleset_snapshot_is_cheaply_cloneable_via_arc_sharing` verifies `Arc::ptr_eq` holds after clone.
- AC-3: `from_config` with a non-empty valid config returns `Ok` and the snapshot reflects the input. Test `from_config_with_valid_config_returns_ok_snapshot_reflecting_config` confirms.
- AC-4: `from_config` with an empty config returns `Ok` with empty `admitted_users` and `action_rules`. Test `from_config_with_empty_config_returns_deny_all_snapshot` confirms.
- AC-5: Empty `field_path` or `pattern` in an `ArgMatcher` returns `Err(RulesetError::EmptyArgMatcher)`. Two tests cover both invalid-field-path and invalid-pattern cases; neither panics.

Files modified are exactly those listed in the task. The `Cargo.lock` change is an expected side effect of adding `serde`, `thiserror`, and `toml` dependencies — not an out-of-scope modification. `serde_json` was not added (mentioned in the task's Cargo.toml note as "if absent"), which is correct since the crate has no JSON serialization requirement at this phase.

**Stage 2 — Code Quality:**
- Correctness: UUID parsing in `from_config` silently drops unparseable strings — rationale is documented in the Work Log and no AC requires an error for malformed user IDs. Validation of empty `ArgMatcher` fields is sound.
- Tests: 10 tests total; 8 new tests cover all 5 ACs across both success and failure paths. Tests are independent with no shared mutable state.
- Security: No hardcoded credentials, no external input beyond the scope of a config data layer.
- Readability: Names are descriptive, follow Rust conventions, and comments explain purpose. Forward-references to T-050 are appropriate. No dead code or debugging artifacts.
- Performance: `Arc` wrapping for cheap clone is appropriate. No unnecessary loops or resource leaks.

All 10 tests passed (`cargo test -p policy-control`). Clippy reported no warnings (`cargo clippy -p policy-control --all-targets`).
