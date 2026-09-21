---
id: T-219
title: Add message-identity, retrieval-pointer, and body-excerpt content 
  requirements to email-triage's task and escalation instructions
status: pending
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Add message-identity, retrieval-pointer, and body-excerpt content requirements to email-triage's task and escalation instructions

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

`S-010`'s new Design Principle (`CR-014`, v0.4) requires every task
`email-triage` files, and the escalation email itself, to carry the
message's `Message-ID`-derived identity, a retrieval pointer (folder,
envelope id, date, sender, subject), and a bounded, quoted, attributed body
excerpt loaded via shell variable, never a literal argument. Define this
"message content" bar once in `references/escalation.md` (which already
states the escalation email's own content requirement) as a single,
cross-referenced subsection, and reference it — rather than restate it —
from `SKILL.md` step 3's `todo`-task instruction (escalation awaiting
reply) and its `blocked`-task instructions (action refused, escalation send
refused). Depends on `T-218` because both edit `SKILL.md`.

## Acceptance Criteria

AC-1: WHERE `references/escalation.md` states the escalation email's
content requirement THE SYSTEM SHALL also state the message's
`Message-ID`-derived identity and a folder/envelope-id/date/sender/subject
retrieval pointer as part of the same requirement.

AC-2: The system shall state that a body excerpt included in a task or
escalation must be quoted, attributed as message content, bounded in
length, and never treated as authoritative over the mailbox.

AC-3: The system shall state that a body excerpt is loaded into the
`bash`/`bob task new` call via a shell variable, never typed as a literal
quoted argument.

AC-4: WHEN `SKILL.md` step 3 files a `todo` or `blocked` task THE SYSTEM
SHALL direct including the content defined in `references/escalation.md`
by reference, not by restating it.

## Dependencies

- `T-218` — establishes the rewritten `SKILL.md` baseline this task edits
  further

## Files to Touch

- `the-intern/bob-skills/skills/email-triage/references/escalation.md`
- `the-intern/bob-skills/skills/email-triage/SKILL.md`

## Verification

```bash
grep -n "Message-ID" the-intern/bob-skills/skills/email-triage/references/escalation.md
# expect at least one match
grep -c "quoted\|attributed\|bounded" the-intern/bob-skills/skills/email-triage/references/escalation.md
# expect > 0
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-21

Picked up T-219 fresh (empty Work Log, first session). Read T-218's post-merge state of `SKILL.md` and `references/worklog.md` directly rather than assuming their pre-T-218 shape, per the task's own instruction, and read `CR-014` in full (including its Architecture Consistency Review findings and Resolution) to pin down exactly what "message content bar" needed to contain and where it was allowed to live, since the task's own Description is a compressed summary of that CR.

Confirmed red for both of the task's Verification greps against the untouched `references/escalation.md` before making any change (`Message-ID`: no match; `quoted|attributed|bounded`: 0 matches), and confirmed `SKILL.md` had zero "Message content requirement" references, before starting.

Did the work as three TDD cycles, each ending in a commit on `task/T-219-...`:
1. Added a new "## Message content requirement" subsection to `escalation.md` (inserted between "When to escalate" and "If an action is blocked") stating the message's stable identity (`Message-ID:` header, fetched the same way `references/worklog.md`'s "Item identifier" section already does) and a retrieval pointer (folder, envelope `id`, date, sender, subject) — verified the `Message-ID` grep flips green while the quoted/attributed/bounded grep is still legitimately 0, confirming this cycle only touched AC-1's target.
2. Extended that same subsection with a body-excerpt bullet (bounded, quoted, attributed as message content, never authoritative over the mailbox — `Message-ID` is the re-fetch pointer if anything is in doubt) plus a paragraph requiring the excerpt to be loaded into a shell variable (reusing the `himalaya` skill's existing "Embedding message-derived text safely" heredoc pattern) rather than typed as a literal argument, explicitly naming both the escalation's `himalaya template write` call and a `bob task new` call as covered. Also rewrote the existing "What the message is" escalation-email bullet to cross-reference the new subsection instead of restating a shorter version of the same bar, closing the loop CR-014 asked for ("as part of the same requirement"). Verified the quoted/attributed/bounded grep flips green (count 3).
3. Rewrote the three places `SKILL.md` step 3 files a task with message-specific content — the confident-match action-refused `blocked` branch, the no-confident-match `todo` branch, and the escalation-send-refused `blocked` branch — to say "including this message's content per `references/escalation.md`'s 'Message content requirement' (do not restate that content here)" plus whatever branch-specific fact remains (the refused action, the question asked, the refused send), replacing the old bare "naming the message" phrasing in all three. Verified via a multiline-aware count (a naive line-based grep undercounted one instance because the phrase happened to wrap across two lines — not a content bug, just a checking artifact) and by confirming no "naming the message" text survived in `SKILL.md`.

Deliberately left two other "naming the message" spots inside `escalation.md` itself untouched: the generic "If an action is blocked" bullet (shared by every category workflow's own blocked action, not just message-content specifics) and the "No synchronous reply is expected" paragraph. The task's Description explicitly scopes the reference-not-restate treatment to "`SKILL.md` step 3's `todo`-task instruction ... and its `blocked`-task instructions" only; expanding into `escalation.md`'s own generic procedural sections would have gone beyond the stated Files-to-Touch/AC boundary, so I held the line there rather than doing an unrequested wider cleanup.

Nothing remains open on this task as far as I can tell — all four ACs have concrete, verified textual support, both official Verification greps pass, and only the two listed files were touched across three commits. Flagging for the Reviewer: worth double-checking the deliberate scope boundary above (the two untouched "naming the message" spots in `escalation.md`) against the Architect's intent, in case a future task is expected to pick that up rather than leaving it as a known residual duplication.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
