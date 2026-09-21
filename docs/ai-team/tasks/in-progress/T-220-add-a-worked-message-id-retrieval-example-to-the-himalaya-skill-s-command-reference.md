---
id: T-220
title: Add a worked Message-ID retrieval example to the himalaya skill's command
  reference
status: pending
priority: medium
assigned-role: developer
created: '2026-09-21'
---

# Add a worked Message-ID retrieval example to the himalaya skill's command reference

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

`himalaya message read`'s `-H, --header <NAME>` option is already
documented as verified, but no worked example shows retrieving a
`Message-ID` header — needed now that `email-triage` (`T-218`) depends on
it for its item-identifier discriminator. Add a worked example retrieving
the identity headers a triage run needs in one call (`-H From -H Subject
-H Date -H Message-ID`), and note `--preview` semantics for a read that
must not set `\Seen`, consistent with existing guidance in the file.

## Acceptance Criteria

AC-1: The system shall include a worked example of `himalaya message read`
with `-H Message-ID` among its headers.

AC-2: The example shall retrieve `From`, `Subject`, `Date`, and
`Message-ID` in a single command.

AC-3: WHERE the example applies to a read that must not mark the message
`\Seen` THE SYSTEM SHALL note the `--preview` flag.

## Dependencies

- None

## Files to Touch

- `the-intern/bob-skills/skills/himalaya/references/command-reference.md`

## Verification

```bash
grep -n "Message-ID" the-intern/bob-skills/skills/himalaya/references/command-reference.md
# expect at least one match
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-21

Implemented T-220 in a single TDD cycle. Read the task's Work Log (empty — first session) before starting. Confirmed red first: `grep -n "Message-ID" the-intern/bob-skills/skills/himalaya/references/command-reference.md` returned no matches, verifying the worked example the task describes genuinely didn't exist yet (the file only had an `In-Reply-To` header example elsewhere, which is a different header).

Added the worked example to the "Reading a Message" section, directly after the existing `himalaya message read`/`--preview`/`-f` example block and before the paragraph explaining the `Seen`-flag side effect — this placement keeps it adjacent to the already-verified `-H`/`--preview` flag documentation it builds on. The example shows `himalaya message read --preview -H From -H Subject -H Date -H Message-ID 42`, retrieving all four identity headers `email-triage` (T-218) needs for its `Message-ID`-discriminated item-identifier in one call, combined with `--preview` and an explicit sentence noting it's the same no-`Seen`-side-effect flag documented above. Checked T-218's completed task file for context on the downstream consumer (`email-triage`'s item-identifier convention already references `himalaya message read -H Message-ID <id>`) to keep the wording and the flag consistent with that existing consumer, without editing anything outside this task's own Files to Touch.

One choice worth flagging: did not mark the new example "Observed" the way several other entries in this file do (those carry real command transcripts from a live account run earlier in the file's history). No live himalaya/mail account was available this session, so the example was written in the same unmarked-syntax style as the plain `message read 42` / `--preview 42` examples immediately above it in the same section, rather than fabricating a transcript. This satisfies the task's three ACs (worked example with `-H Message-ID`; `From`/`Subject`/`Date`/`Message-ID` in one command; `--preview` noted for a must-not-set-`\Seen` read) without overclaiming verification status.

Confirmed green after the edit (grep now matches at three lines, including the command itself), confirmed `git diff --stat` touched only the one Files-to-Touch file with no deletions, committed as `f71ad68` (`docs(himalaya): add worked Message-ID header retrieval example`) on the task branch, and left the working tree clean. Nothing remains open for T-220; all three acceptance criteria are met and the task's exact Verification command passes.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
