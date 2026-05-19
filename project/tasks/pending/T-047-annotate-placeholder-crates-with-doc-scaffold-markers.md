---
id: T-047
title: Annotate placeholder crates with doc scaffold markers
status: pending
priority: low
assigned-role: unassigned
created: '2026-05-19'
---

# Annotate placeholder crates with doc scaffold markers

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

The crates `monitoring`, `policy-control`, and the `Actor`/`Handle` surface inside `extension-ipc` ship a `Handle::method → ServiceError::NotImplemented` scaffold. They compile and link, masquerading as functional subsystems. Annotate each placeholder module/struct with a `#![doc = "scaffold — see project/docs/roadmap.md phase X"]` (or `#[doc = ...]` at the item level, whichever produces the clearest rustdoc) so future readers know they are intentional placeholders, not finished work. Pick the correct phase reference from `project/docs/roadmap.md` for each crate.

## Acceptance Criteria

AC-1: WHEN cargo doc is generated for the workspace THE `monitoring`, `policy-control`, and `extension-ipc::Actor` placeholders SHALL each carry a `scaffold — see roadmap phase …` doc note.
AC-2: WHEN `cargo build --workspace && cargo test --workspace` runs THE SYSTEM SHALL pass.

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/monitoring/src/lib.rs` — crate-level `#![doc]` scaffold marker.
- `the-intern/service/crates/policy-control/src/lib.rs` — crate-level `#![doc]` scaffold marker.
- `the-intern/service/crates/extension-ipc/src/lib.rs` — item-level `#[doc]` marker on the `Actor`/`Handle` scaffold only (NOT on the real `run_connection` / multiplex code).

## Verification

```bash
cd the-intern/service
cargo build --workspace
cargo doc --no-deps --workspace
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
