---
id: T-051
title: Implement PolicyEngine admission and action evaluation
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Implement PolicyEngine admission and action evaluation

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

Phase 1 of S-004. Implement `PolicyEngine` — the pure, synchronous verdict
logic that both gates call. No I/O, no async, no actor.

In a new `engine.rs` module, provide:

- `PolicyEngine::evaluate_admission(snapshot: &RulesetSnapshot, user: UserId)
  -> PolicyVerdict` — allow iff `user` is in the snapshot's admission list;
  otherwise a deny verdict with a non-empty reason.
- `PolicyEngine::evaluate_action(snapshot: &RulesetSnapshot, tool: &str,
  arguments: &serde_json::Value) -> PolicyVerdict` — allow-only,
  default-deny: the call is allowed iff some `ActionRule` names `tool` and
  **every** `ArgMatcher` on that rule matches `arguments` (a rule with no
  matchers allows the tool for any arguments). If no rule allows it, deny
  with a non-empty reason.

`PolicyVerdict` is `bob_core::types::PolicyVerdict`
(`{ allow: bool, reason: Option<String> }`). `PolicyEngine` carries no
state — the snapshot is passed in (a unit struct or a module of free
functions is fine). Declare `mod engine;` in `lib.rs` and re-export
`PolicyEngine`. Unit-test both gates, covering: unknown user denied, known
user admitted, tool absent denied, tool present with all matchers passing
allowed, tool present with one matcher failing denied.

## Acceptance Criteria

AC-1: WHEN `evaluate_admission` is called with a user id present in the snapshot admission list THE SYSTEM SHALL return an allow verdict.
AC-2: IF `evaluate_admission` is called with a user id absent from the admission list THEN THE SYSTEM SHALL return a deny verdict with a non-empty reason.
AC-3: WHEN `evaluate_action` is called and some action rule names the tool and every argument matcher on that rule matches THE SYSTEM SHALL return an allow verdict.
AC-4: IF `evaluate_action` is called and no action rule both names the tool and has all its matchers match THEN THE SYSTEM SHALL return a deny verdict with a non-empty reason.
AC-5: The system shall implement both evaluation functions as pure and synchronous, taking the ruleset snapshot as a parameter and performing no I/O.

## Dependencies

- `T-050` — uses `ArgMatcher::matches`; shares `policy-control/src/lib.rs`. Transitively depends on `T-049`.

## Files to Touch

- `the-intern/service/crates/policy-control/src/engine.rs` — new module: `PolicyEngine` and its unit tests.
- `the-intern/service/crates/policy-control/src/lib.rs` — declare `mod engine;` and re-export `PolicyEngine`.

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
