---
id: T-099
title: Document bob schedule commands and [schedule] config section in operator guide
status: completed
priority: medium
assigned-role: developer
created: '2026-06-12'
spec: S-009
---

# Document bob schedule commands and [schedule] config section in operator guide

## Description

S-009 adds operator-facing functionality (`bob schedule` subcommands,
`[[schedule]]` TOML config) that must be documented in the user-facing docs so
operators can discover and use it. The CLI reference is auto-generated from
clap (T-082 preprocessor), so only the operator guide needs manual updates.

**Add to `the-intern/docs/src/operator-guide/index.md`** (or a new sub-page
`scheduling.md` if the operator guide uses per-topic pages — check the SUMMARY
and current structure):

1. **Scheduled jobs section** — introduce the concept: bob can run pi-agent
   prompts on a cron schedule; if bob is down, jobs are skipped (ADR-006).

2. **Configuring jobs in `bob.toml`** — show the `[[schedule]]` entry format
   (id, cron, prompt) with a worked example (e.g. check email every 15 minutes).

3. **Managing jobs at runtime** — document the four `bob schedule` subcommands
   with example invocations and expected output.

4. **Cron expression format** — note that 5-field standard cron expressions
   are required; link or describe the field order (minute hour day-of-month
   month day-of-week).

If the operator guide uses a single `index.md`, add the scheduling section
after the policy section. If it uses sub-pages, create
`the-intern/docs/src/operator-guide/scheduling.md` and add it to
`SUMMARY.md`.

## Acceptance Criteria

AC-1: The system shall build the mdBook docs (`cd the-intern/docs && mdbook build`)
      without errors after the changes.

AC-2: The operator guide shall contain a section that shows a complete
      `[[schedule]]` TOML example with `id`, `cron`, and `prompt` fields.

AC-3: The operator guide shall document all four `bob schedule` subcommands
      (`add`, `remove`, `list`, `reload`) with at least one example invocation each.

AC-4: The operator guide shall state that scheduled jobs do not fire while
      bob is stopped (per ADR-006).

## Dependencies

- `T-098` — CLI must be implemented before docs can accurately reflect its
  flags and output

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — add scheduling section
  (or new `scheduling.md` + `SUMMARY.md` update if guide uses sub-pages)

## Verification

```bash
cd the-intern/docs
mdbook build
```

## Work Log

### Session 1 — 2026-06-12

**What was done**

Added a "Scheduled jobs" section to `the-intern/docs/src/operator-guide/index.md`, inserted after the policy section (operator guide uses a single `index.md`, no sub-pages).

Read the schedule CLI source (`cli/mod.rs`, `commands/schedule.rs`) and `config.rs` for exact flag names. Read ADR-006 for the authoritative skip-on-down wording.

Added 109 lines covering:
- Concept introduction with ADR-006 skip-on-down statement (AC-4)
- `[[schedule]]` TOML table format with a "check email every 15 minutes" worked example (AC-2)
- Cron expression field-order diagram (minute / hour / day-of-month / month / day-of-week)
- All four `bob schedule` subcommands with example invocations and flag tables (AC-3)

`mdbook build` passes without errors.

**What was tried and rejected**

Nothing — structure was clear from the first read.

**What remains**

Nothing. All acceptance criteria met.

**Obstacles Encountered**

None.

**Final branch state:** 1 commit on branch. `mdbook build` clean.

## Review

### Review Verdict — 2026-06-12

PASS

**Stage 1 — Acceptance Criteria**

- AC-1: `mdbook build` completed without errors (only a non-fatal mdbook-mermaid version warning, no failures). PASS.
- AC-2: `[[schedule]]` TOML example with `id`, `cron`, and `prompt` fields present at lines 333–338 of `the-intern/docs/src/operator-guide/index.md`. PASS.
- AC-3: All four `bob schedule` subcommands (`list`, `add`, `remove`, `reload`) documented with at least one example invocation each (lines 364–414). PASS.
- AC-4: Lines 316–319 explicitly state "If bob is stopped when a job is due to fire, that job is skipped and will not be replayed when the service restarts. This is by design (ADR-006)." PASS.

**Stage 2 — Code Quality**

- Only one file changed (`the-intern/docs/src/operator-guide/index.md`, +109 lines), exactly the file specified in the task.
- No unrelated files touched, no unexpected behavior added.
- Document structure is consistent with the rest of the operator guide: section headings, tables, and fenced code blocks follow the same conventions as adjacent sections.
- Cron expression field-order diagram is clear and correct.
- Flag tables for `bob schedule add` are accurate and complete.
