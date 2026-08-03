---
id: T-141
title: Document email triage operator setup in the operator guide
status: pending  # pending | in-progress | completed | blocked
priority: medium  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Document email triage operator setup in the operator guide

## Description

S-010 Phase 5: document how an operator turns the shipped email-skills package
into a working scheduled email-triage job, in the S-007 operator guide
(`the-intern/docs/src/operator-guide/index.md`). Add one new section; the guide
already has neighbouring "Policy basics", "Working directory for pi-agent
sessions", and "Scheduled jobs" sections to cross-link rather than duplicate.

Cover, in this order:
- Prerequisites: a configured himalaya IMAP/SMTP account (owned outside bob, per
  ADR-008 §5) and a manager escalation address.
- Deploying an owner-only copy of the package to a workspace outside the
  repository checkout, and why the checkout is never used as a job's `--cwd`
  (the workspace holds mutable runtime state and is a trusted, unchecked input
  per ADR-012 §7).
- The skill-local `config/email-triage.toml` and its `manager_address` key.
- The S-004 action allow rules, with the concrete worked example verified in
  T-139 — including the `arg_matchers` `field_path`/`pattern` shape, since the
  guide's existing action-rule example only shows a bare `tool = "bash"` rule —
  covering every tool call the package makes (himalaya, config read, worklog
  read/append), plus `bob policy reload`.
- Adding the job with `bob schedule add --cwd`, and what an operator should see
  afterwards (worklog entries, audit records, escalation mail).

Take the allow rule and deployment procedure from the package README as recorded
by T-139/T-140; do not invent a matcher shape that was never run.

## Acceptance Criteria

AC-1: The operator guide shall document deploying an owner-only copy of the
      email-skills package to a workspace outside the repository checkout and
      state why the checkout is never used as a scheduled job's `--cwd`.
AC-2: The operator guide shall document the skill-local `config/email-triage.toml`
      file and its required `manager_address` key.
AC-3: The operator guide shall include the S-004 action allow rule worked example
      verified in T-139, showing the `arg_matchers` `field_path` and `pattern`
      that admit every tool call the package makes — himalaya, config read, and
      worklog read/append — without a blanket `bash` allow, and the
      `bob policy reload` step.
AC-4: The operator guide shall document adding the triage job with
      `bob schedule add --cwd` and what the operator should observe after a
      tick — a worklog entry, an audit record, and escalation mail when a message
      is not confidently classified.
AC-5: WHEN the user-docs mdBook is built THE SYSTEM SHALL build without errors
      including the new section.

## Dependencies

- `T-140` — validated escalation, block, and continuity behaviour, and the
  package README content this section is derived from (transitively T-139)

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — new email-triage setup section,
  cross-linked to the existing policy, working-directory, and scheduled-jobs
  sections

## Verification

```bash
mdbook build the-intern/docs
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-03

Added the validated email-triage deployment section to the operator guide in
task commit `83e4c2f` (`docs(operator): add email triage setup guide`). It
covers prerequisites, owner-only external deployment, skill-local
`manager_address`, scoped `read.path` and `bash.command` policy rules,
relative continuity reads, `bob policy reload`, and scheduling with `--cwd`.
`mdbook build` passed from `the-intern/docs/`, the book root required by its
relative preprocessor configuration.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-03
FAIL

Stage 1 passed. AC-1 through AC-4 are satisfied by the new operator-guide
section in `the-intern/docs/src/operator-guide/index.md`: it documents the
owner-only deployed workspace outside the repository checkout, the required
skill-local `config/email-triage.toml` with `manager_address`, the exact
validated `read.path` and `bash.command` allow-rule shapes carried forward from
T-139/T-140, `bob policy reload`, and `bob schedule add --cwd` plus the
expected worklog, audit, and escalation-mail outcomes. AC-5 is satisfied by a
clean `mdbook build` from `the-intern/docs/`, which renders the new section in
the generated operator guide.

- **File and location** — `the-intern/docs/src/operator-guide/index.md:741-743`
  **What is wrong** — Stage 2 correctness failed because the new introductory
  link to ``../../email-skills/README.md`` renders as
  `../../email-skills/README.html` in `the-intern/docs/book/operator-guide/index.html`,
  but that target is not generated anywhere in the book output. The change
  therefore adds a dead link to the shipped operator guide.
  **What should change** — Replace that repository-relative markdown link with
  non-link prose or with a target that exists in the rendered docs experience.
  Rebuild the book and confirm the operator-guide page no longer contains a
  broken `email-skills` link.
