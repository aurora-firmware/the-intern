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

### Review Verdict — 2026-05-19
PASS

Stage 1 (spec compliance) and Stage 2 (code quality) both passed.

**AC-1:** Confirmed. The scaffold text appears in the generated rustdoc HTML for all four targets:
- `monitoring` crate index: "scaffold — see project/docs/roadmap.md phase 5"
- `policy_control` crate index: "scaffold — see project/docs/roadmap.md phase 4"
- `extension_ipc::Actor` struct page: "scaffold — see project/docs/roadmap.md phase 3"
- `extension_ipc::Handle` struct page: "scaffold — see project/docs/roadmap.md phase 3"

**AC-2:** `cargo build --workspace` and `cargo doc --no-deps --workspace` both pass cleanly. The four `admin-rpc` rustdoc warnings are pre-existing and unrelated to this task.

**Phase numbers:** Verified against `project/docs/roadmap.md`. Phase 3 = JS extension (Actor/Handle), Phase 4 = Policy Control, Phase 5 = Monitoring. All assignments are correct.

**Scope:** Only the three files listed in "Files to Touch" were modified. The `run_connection`, `run_listener`, and multiplex code in `extension-ipc` were not annotated, as required. No unspecified behavior was added.

**Code quality:** The attribute syntax is correct (`#![doc]` inner for crate-level, `#[doc]` outer for item-level). No dead code, no secrets, no logic changes — pure annotation additions. Readability is unchanged.
