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

### Review Verdict — 2026-09-21

PASS

**Stage 1 — Acceptance Criteria** (checked against
`the-intern/bob-skills/skills/himalaya/references/command-reference.md` on
`task/T-220-add-a-worked-message-id-retrieval-example-to-the-himalaya-skill-s-command-reference`,
diffed against `dev-agent`):

- AC-1 (worked example of `himalaya message read` with `-H Message-ID`
  among its headers): met. Line 143 of the file:
  `himalaya message read --preview -H From -H Subject -H Date -H Message-ID 42`.
- AC-2 (`From`, `Subject`, `Date`, `Message-ID` retrieved in one command):
  met — all four appear as repeated `-H` flags on that same single command
  line.
- AC-3 (WHERE the example is for a read that must not set `\Seen`, note
  `--preview`): met — the example uses `--preview`, and the following
  sentence (lines 146–148) explicitly states it reads "without marking the
  envelope `Seen`," consistent with the file's existing `--preview`
  documentation two paragraphs above.
- No unspecified behavior added; no unexpected files modified. `git diff
  --stat dev-agent...task/T-220-...` shows exactly the one Files-to-Touch
  file, 14 insertions, 0 deletions.
- Ran the task's exact Verification command against the branch content:
  `grep -n "Message-ID" the-intern/bob-skills/skills/himalaya/references/command-reference.md`
  → 3 matches (two in prose, one in the command itself). Matches the Work
  Log's claim.

**Stage 2 — Code Quality / content quality:**

- Placement is correct — the new block sits directly after the existing
  plain `himalaya message read 42` / `--preview 42` / `-f Archive 42 43`
  examples and before the `Seen`-flag side-effect paragraph, adjacent to
  the already-verified `-H`/`--preview` flag documentation it builds on.
- Wording is accurate and grounded: the example's claim that this is the
  header set `email-triage`'s `Message-ID`-discriminated item-identifier
  needs is corroborated by
  `the-intern/bob-skills/skills/email-triage/references/worklog.md` (line
  21) and `SKILL.md` (line 238), which independently document
  `himalaya message read -H Message-ID <id>` as the fetch mechanism for
  that discriminator.
- No dead prose, no scope creep — only the one described worked example
  was added; nothing else in the file was touched.

**Judgment point — "Observed" labeling:** confirmed non-misleading and
consistent with the file's own stated convention. The file's header
(lines 3–11) defines exactly two categories: everything is checked
against `--help` output by default (unmarked), and a subset is
additionally marked `"Observed"` when also run against a live account.
The new block does not use the word "Observed" anywhere, shows only the
command itself with no fabricated output or transcript, and sits directly
beside the unmarked plain `message read` examples immediately above it —
the same unmarked style, for the same reason (flags individually verified
via `--help`, not exercised together against a live account this
session). It cannot be mistaken for an `"Observed"` entry: true `Observed`
entries in this file are distinguished either by the literal word
"Observed" in a bold pitfall/pattern header (e.g. lines 22, 102, 154) or
by showing an actual command transcript with real output (e.g. lines 79,
335, 476), neither of which this block does. This is an honest
presentation of unverified-by-execution status, matching the Work Log's
own explicit disclosure.

Both stages pass. No blocking issues found.