---
id: T-219
title: Add message-identity, retrieval-pointer, and body-excerpt content 
  requirements to email-triage's task and escalation instructions
status: completed
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

### Review Verdict — 2026-09-21

PASS

Reviewed `task/T-219-add-message-identity-retrieval-pointer-and-body-excerpt-content-requirements-to-email-triage-s-task-and-escalation-instructions` against the canonical task file by reading both files' full content on the task branch (`git show <branch>:<path>`) and running the task's own Verification commands against that content directly — not by trusting the Developer's Work Log report. `git diff --stat dev-agent...task/T-219-...` confirms only the two Files to Touch were modified (`SKILL.md` +35/-18 lines net across the diff stat, `references/escalation.md` +40/-2 lines), no unexpected files touched.

**Stage 1 — Acceptance criteria:**

- AC-1 — PASS. `references/escalation.md`'s escalation-email "What the message is" bullet now reads "this message's identity, retrieval pointer, and body excerpt, per 'Message content requirement' below" and the new "## Message content requirement" subsection immediately below spells out the Message-ID-derived identity and the folder/envelope-id/date/sender/subject retrieval pointer verbatim, forming one cross-referenced requirement exactly as the Description asks ("a single, cross-referenced subsection"). Ran the task's own Verification command — `grep -n "Message-ID" references/escalation.md` against the task-branch content — 4 matches.
- AC-2 — PASS. The "Body excerpt" bullet states the excerpt must be "quoted and attributed as message content ... and never treated as authoritative over the mailbox itself," and is introduced as "a bounded excerpt." Ran `grep -c "quoted\|attributed\|bounded" references/escalation.md` against the task-branch content — 3 (task expects > 0).
- AC-3 — PASS. The paragraph following the three bullets requires the body excerpt be loaded into a shell variable via the `himalaya` skill's "Embedding message-derived text safely" heredoc pattern (confirmed that section exists at `the-intern/bob-skills/skills/himalaya/references/command-reference.md:182`, not a dangling reference) and explicitly extends the rule to a `bob task new` call filing a `todo`/`blocked` task, not just the escalation's own `himalaya template write` call.
- AC-4 — PASS. All three `SKILL.md` step 3 call sites (confident-match blocked-action-refused, no-confident-match todo, escalation-send-refused blocked) now read "including this message's content per `references/escalation.md`'s 'Message content requirement' (do not restate that content here)" plus their own branch-specific fact (refused action, question asked, refused send). Confirmed 3 occurrences of the phrase in the task-branch `SKILL.md` via a whitespace-squeezed check (`tr -s ' \n' ' ' | grep -o "Message content requirement" | wc -l` → 3; a naive line-based `grep -n` undercounts because the phrase wraps across lines at two of the three sites — matches the Developer's own Work Log note, verified independently) and 0 remaining occurrences of the old "naming the message" phrasing anywhere in `SKILL.md`.

**Scope call on the two deliberately-untouched "naming the message" spots** (the Developer flagged this in the Work Log for review): I read the Description and every AC specifically to settle this. The Description names the reference targets exhaustively — "`SKILL.md` step 3's `todo`-task instruction (escalation awaiting reply) and its `blocked`-task instructions (action refused, escalation send refused)" — and AC-4's WHEN clause is scoped identically ("WHEN `SKILL.md` step 3 files a `todo` or `blocked` task"). Neither the Description nor any AC asks for a sweep of every "naming the message" occurrence inside `escalation.md` itself. The two untouched spots are: (1) the generic "If an action is blocked" bullet, which the file's own prose explicitly documents as "the block-handling rule every category workflow file (`references/categories/*.md`) cross-references for its own action being blocked" — i.e. shared infrastructure for every category workflow's own blocked action, not a message-content-specific site scoped to this task; and (2) the "No synchronous reply is expected" paragraph, which is `escalation.md`'s own narrative restatement of the same todo-task-filing event `SKILL.md` step 3 already governs, not a second `SKILL.md`-step-3 instruction. Both are legitimately out of scope for T-219 as written. The Developer drew the line correctly, and holding it (rather than doing an unrequested wider cleanup) is the right call.

That said, this is a real, pre-existing residual now sitting in the same file as the newly authoritative "Message content requirement" subsection: both untouched spots still say "naming the message" with no cross-reference, alongside a subsection right above them that defines message content precisely. This should be picked up as a follow-on task (a candidate for `T-221` or later) rather than re-litigated as a T-219 gap — recording that here so it isn't re-opened as a surprise.

**Stage 2 — Code quality:** markdown/skill-content only, no Rust touched (confirmed via `git diff --stat`), so no compiler/test gates apply. Content checks: no internal task/bug/spec/ADR IDs leaked into the shipped skill text (`grep -nE "T-[0-9]{3}|CR-[0-9]{3}|B-[0-9]{3}|ADR-[0-9]{3}"` against both files' task-branch content — no matches), consistent with `coding-guidelines-skills.md`. Cross-references are accurate, not dangling: the `Message-ID` fetch bullet matches `references/worklog.md`'s existing "Item identifier" section verbatim (`himalaya message read -H Message-ID <id>`); the heredoc pattern reference resolves to a real, existing section; `bob task new` terminology matches existing usage elsewhere in `SKILL.md`. No dead prose, no unrelated edits, no scope creep beyond the two listed files. Commit messages (`a055db9`, `1903702`, `8918cc7`) follow `docs(email-triage): ...` convention, imperative, under 72 chars.

Both stages pass.
