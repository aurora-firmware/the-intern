---
id: T-195
title: Rewrite the canonical worklog skill to use bob worklog
status: pending
priority: medium
assigned-role: developer
created: '2026-08-30'
---

# Rewrite the canonical worklog skill to use bob worklog

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

Component 4: replace the `worklog` skill's raw-shell diary recipe with
instructions to call `bob worklog append` / `bob worklog list`. The command
is now the normative definition of the entry format and the owner of
first-run detection and reconciliation; the skill describes *when* to call
it and the item-identifier convention, and must not restate the format or
the reconciliation algorithm.

Rewrite these canonical (vendor-neutral) files under
`the-intern/bob-skills/skills/worklog/`:

- `SKILL.md` — the run shape becomes: call `bob worklog list` at the start
  of a run (it reconciles automatically) and `bob worklog append` once per
  item handled. Delete the "Determining whether this is the day's first
  executed run" section — the command does this. Keep "How an open item
  closes" as delegating to the consuming skill's policy. Rewrite "Tool
  usage": the skill's runtime surface is now `bash` invocations of
  `bob worklog append` / `bob worklog list` — no `read` of prior files, no
  `mkdir`/`>>`/`date`/`test`/`find`/`ls`. Also rewrite the frontmatter
  `description` (the skill's activation surface): it currently claims the
  skill "Defines where the diary lives, how to create what is missing, the
  per-item entry format, how to tell whether a run is the day's first
  executed run, how first-run reconciliation carries forward still-open
  items" — every one of those clauses moves to the command, matching
  `S-011`'s amended Responsibility row ("defers to the `bob worklog`
  command for entry format, first-run detection, and reconciliation").
  And rewrite the **Location** section so it states the *invoking* working
  directory **strictly**, with no upward search and no override (ADR-015) —
  the current "`<workspace>` is the run's own working directory" wording
  reads as compatible with an ancestor-searching resolver.
- `references/entry-format.md` — describe the entry shape the command
  writes (`## <HH:MM> — <item-identifier>` + `Done`/`Left`/`Next`) as
  reference only, explicitly deferring to `bob worklog` as the definition.
  Delete the `NOW=$(date +%H:%M)` / `mkdir -p worklog` / `cat >>
  worklog/$TODAY.md` recipe and all `<NOW>` placeholder guidance.
- `references/reconciliation.md` — state that `bob worklog` reconciles
  automatically and idempotently on every call against the nearest prior
  worklog file that exists, and reports today's carried-forward set. Remove
  the manual "walk `worklog/*.md` backward" procedure and the "most recent
  worklog file with open items" phrasing.

All three must stay free of this project's internal identifiers (S-011
constraint: no spec/task/bug/ADR numbers in shipped skill content).

Also update `the-intern/bob-skills/test_worklog_entry_format_timestamp.sh`:
it is a B-039 regression test asserting the now-deleted `date +%H:%M` /
`<NOW>` prose in `entry-format.md`. Replace its assertions with ones that
match the rewritten content (e.g. that `entry-format.md` instructs calling
`bob worklog append` and contains no raw `>> worklog/` redirect), or remove
the script if no meaningful file-level assertion remains — state which in
the Work Log.

Do **not** run the packaging script here — pi-package regeneration is
T-199, after the email-triage canonical edits (T-196) are also in.

## Acceptance Criteria

AC-1: The canonical `worklog` `SKILL.md` — its frontmatter `description`,
its Location section, and its body — shall instruct the reader to use
`bob worklog list` and `bob worklog append`, shall state cwd-strict
resolution of the worklog (no upward search, no override), and shall
contain no `mkdir`, `>>`, `date +%H:%M`, `test -f`, or `cat` shell recipe
for the worklog and no claim that the skill owns entry format, first-run
detection, or reconciliation.

AC-2: WHERE `references/entry-format.md` describes the entry shape THE
SYSTEM SHALL present it as derived from `bob worklog` and SHALL NOT contain
the `NOW=$(date +%H:%M)` recipe or the `<NOW>` placeholder guidance.

AC-3: The rewritten `references/reconciliation.md` shall state that
`bob worklog` performs reconciliation automatically against the nearest
prior worklog file that exists, and shall not instruct the reader to walk
`worklog/*.md` manually.

AC-4: IF any of the three rewritten files contains a project-internal
identifier (a spec, task, bug, or ADR number) THEN the task is not
complete.

AC-5: WHEN `test_worklog_entry_format_timestamp.sh` is run against the
rewritten files THE SYSTEM SHALL exit 0, whether by updated assertions or
by the script's removal being reflected in the verification step.

## Dependencies

- `T-193` — the `bob worklog append` / `list` surface the rewritten skill instructs callers to use must exist and be stable

## Files to Touch

- `the-intern/bob-skills/skills/worklog/SKILL.md` — rewrite to call the command
- `the-intern/bob-skills/skills/worklog/references/entry-format.md` — reference-only entry shape, recipe deleted
- `the-intern/bob-skills/skills/worklog/references/reconciliation.md` — automatic-reconciliation description, manual walk deleted
- `the-intern/bob-skills/test_worklog_entry_format_timestamp.sh` — updated to match, or removed

## Verification

```bash
cd the-intern/bob-skills
! test -f test_worklog_entry_format_timestamp.sh || ./test_worklog_entry_format_timestamp.sh
! grep -REn 'S-[0-9]{3}|T-[0-9]{3}|B-[0-9]{3}|ADR-[0-9]{3}|date \+%H:%M|mkdir -p worklog|>> worklog/' skills/worklog/
grep -RIl 'bob worklog' skills/worklog/
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
