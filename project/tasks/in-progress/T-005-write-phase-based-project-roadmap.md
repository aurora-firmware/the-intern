---
id: T-005
title: Write phase-based project roadmap
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-15'
---

# Write phase-based project roadmap

## Description

Author `project/docs/roadmap.md` describing the planned implementation of
the-intern as a sequence of phases. The phases mirror the
*Implementation Order* table in
`project/specs/the-intern-agent-service-architecture.md` (1. Rust service
skeleton, 2. pi-agent process supervision, 3. JS extension, 4. Policy
Control, 5. Monitoring, 6. Channel adapters, 7. Actions), preceded by a
"Phase 0 — Foundations" covering CI scaffolding, dev container, coding
guidelines, and code-folder layout.

The roadmap is narrative and prose-first. For each phase: one short paragraph
saying *what the phase delivers* and *why it comes when it does* (depends on
prior phases per the spec).

Out of scope (explicit): no task or ticket IDs (do not enumerate T-NNN), no
effort estimates (no story points, hours, or t-shirt sizes), no ownership /
team assignments, and no explicit per-phase exit criteria (phases are goals,
not contracts).

## Acceptance Criteria

AC-1: The system shall provide `project/docs/roadmap.md`.
AC-2: The roadmap shall contain a Phase 0 ("Foundations") plus the seven phases from `project/specs/the-intern-agent-service-architecture.md` in the same order.
AC-3: Each phase shall include a brief paragraph describing the delivered outcome and a reference to the phase or component(s) it implements from the architecture spec.
AC-4: The system shall NOT mention any task ID matching `T-\d+`, effort estimate (story points / hours / t-shirt sizes), owner, or per-phase exit criterion in the roadmap.
AC-5: The roadmap shall NOT contradict the dependency ordering stated in the architecture spec's *Implementation Order* table.

## Dependencies

- None (reads the existing spec; does not modify it)

## Files to Touch

- `project/docs/roadmap.md` — new

## Verification

```bash
test -f project/docs/roadmap.md

# All eight phase headings are present (Phase 0 + 1..7)
for n in 0 1 2 3 4 5 6 7; do
  grep -qE "Phase[[:space:]]+$n([^0-9]|$)" project/docs/roadmap.md || { echo "missing Phase $n"; exit 1; }
done

# Forbidden content
! grep -qE 'T-[0-9]+' project/docs/roadmap.md
! grep -qiE 'story point|t-shirt|estimate|hours?:|owner:|assignee' project/docs/roadmap.md
! grep -qiE 'exit criteri' project/docs/roadmap.md
```

## Work Log

### Session 1 — 2026-05-15

Implemented `project/docs/roadmap.md` as a phase-based narrative roadmap with Phase 0 Foundations followed by Phases 1 through 7 in the architecture spec’s implementation order. Each phase now has a short prose paragraph that states the delivered outcome, why it appears at that point in the sequence, and a direct reference to `project/specs/the-intern-agent-service-architecture.md`. The document intentionally avoids task IDs, effort estimates, ownership/assignee language, and exit-criteria wording.

For TDD, I first added `tests/test_roadmap.sh` and ran it before implementation to establish a failing baseline (all AC checks failed with no roadmap file present). After drafting the roadmap, tests exposed a parser flaw in the new test script: I initially used `\b` word-boundary patterns in `awk`, which produced false negatives for section extraction. I rejected that approach and refactored extraction to use explicit `([^0-9]|$)` phase-boundary regexes, then re-ran the suite to green.

What remains: no implementation work remains on this task branch. The next step is for the loop to append this session entry to the canonical task file on `dev-agent` and continue handoff/review flow.

## Review

### Review Verdict — 2026-05-15
PASS

Result: PASS

Summary:
- Reviewed T-005 against the canonical acceptance criteria and the implementation branch `task/T-005-write-phase-based-project-roadmap`; Stage 1 acceptance checks and Stage 2 quality checks both passed.

Artifacts:
- Canonical task file updated: `project/tasks/in-progress/T-005-write-phase-based-project-roadmap.md` (this verdict entry).
- Diff reviewed: `dev-agent...task/T-005-write-phase-based-project-roadmap`.
- Primary files inspected: `project/docs/roadmap.md`, `project/specs/the-intern-agent-service-architecture.md`, `tests/test_roadmap.sh`.

Evidence:
- Stage 1 AC checks:
- AC-1 PASS: `project/docs/roadmap.md` exists on source branch.
- AC-2 PASS: roadmap includes Phase 0 plus Phases 1-7 in architecture implementation order.
- AC-3 PASS: each phase contains a brief delivery paragraph and an explicit architecture-spec reference.
- AC-4 PASS: no task IDs (`T-\\d+`), effort-estimate terms, owner/assignee terms, or exit-criteria text found.
- AC-5 PASS: dependency statements align with the architecture spec’s Implementation Order dependencies.
- Stage 2 checks PASS for this documentation-focused change:
- Correctness: phase sequencing and dependency rationale are internally consistent.
- Tests: executed `tests/test_roadmap.sh` from an isolated archive of the source branch; 5 passed, 0 failed.
- Security/readability/performance: no concerns identified for static markdown/test-script scope.
- Scope note: source branch also adds `tests/test_roadmap.sh`; this is acceptable as task-focused verification support and does not alter product behavior.

Obstacles Encountered:
- none

Next Owner:
- Development Loop

Next Action:
- none
