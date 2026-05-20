---
id: T-049
title: Define the policy ruleset config schema and validated snapshot types
status: pending
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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
