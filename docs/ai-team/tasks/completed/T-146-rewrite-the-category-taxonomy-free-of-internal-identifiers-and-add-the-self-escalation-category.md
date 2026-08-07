---
id: T-146
title: Rewrite the category taxonomy free of internal identifiers and add the self-escalation category
status: completed
priority: high
assigned-role: developer
created: '2026-08-07'
---

# Rewrite the category taxonomy free of internal identifiers and add the self-escalation category

## Description

The category taxonomy directory carries 13 ai-team artifact identifiers spread
across its index and five workflow files, presents an extension point that
should not exist, and lacks a category that a new escalation behaviour requires.

Skill consumers have no access to this project's specifications, decision
records, tasks, or bugs, so skill text must be intelligible without them. Remove
every such identifier (`S-0NN`, `T-NNN`, `B-0NN`, `ADR-0NN`, `CR-0NNN`).

**This is a rewrite, not a deletion.** Most references to the action-gate
specification are behaviourally load-bearing: they carry the rule that a tool
call denied by policy is recorded and never worked around. Replace the
identifier with behavioural language — "the action-authorization gate", "denied
by policy" — and keep the surrounding rule intact.

Three changes:

1. **Scrub the 13 identifiers** across `README.md` and the five category
   workflow files.
2. **Delete the "Adding a category" section** from `README.md`. Skill content
   ships with releases, so a user's local edits would be overwritten on
   upgrade; inviting them is misleading. Categories change through releases
   only. Remove the section without replacing it with a "do not edit" notice.
3. **Add a terminal category for the skill's own escalation mail.** Escalations
   sent to the account's own address arrive back in the same mailbox as unseen
   mail and re-enter triage. Without this, a message that does not classify
   confidently escalates to itself indefinitely. The new category must file
   such a message and never escalate it again. Add one workflow file and one
   index entry naming its matching signals.

## Acceptance Criteria

AC-1: The system shall contain no ai-team artifact identifier anywhere under
      `references/categories/`.

AC-2: The system shall present no procedure, invitation, or guidance for adding
      a category.

AC-3: WHEN a message is recognised as the skill's own escalation mail THE
      SYSTEM SHALL file it and take no escalation action on it.

AC-4: The system shall list the new category in the taxonomy index with its
      matching signals, in the same shape as the existing entries.

AC-5: The system shall leave the confidence rubric and the five existing
      categories' matching signals behaviourally unchanged.

## Dependencies

- None. `SKILL.md` consults this index by name and enumerates no categories
  itself, so adding one requires no change to T-144's files.

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/categories/README.md`
  — identifier scrub, remove "Adding a category", add the new index entry
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/`
  (five existing workflow files) — identifier scrub only
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/`
  (one new workflow file) — the terminal self-escalation category

## Verification

```bash
cd the-intern/email-skills/.pi/skills/email-triage/references/categories

# AC-1 — expect no output:
grep -rnE '\b(S-0[0-9]{2}|T-[0-9]{3}|B-0[0-9]{2}|ADR-0[0-9]{2}|CR-0[0-9]{3})\b' .

# AC-2 — expect no output:
grep -rniE 'adding a category|add a category|extend the list' .

# AC-3/AC-4 — expect the new workflow file and its index entry:
ls *.md && grep -niE 'escalation mail|own escalation' README.md
```

## Work Log

### Session 1 — 2026-08-07

Implemented T-146 in three cycles matching the task description's three distinct
changes, each committed separately on `task/T-146-rewrite-category-taxonomy`.

Before writing anything, read the three sibling files the task pointed to —
`references/escalation.md` (T-143), `SKILL.md` (T-144), and `references/worklog.md`
(T-145) — plus the `himalaya` skill's `command-reference.md`, since escalation.md's
missing-configuration fallback leans on `himalaya template write`'s `From:` header
to find the account's own address, and that mechanism needed to be the basis for the
new category's matching signals rather than inventing a separate detection method.

Cycle 1 (scrub identifiers, AC-1/AC-5): established the red baseline with the task's
own grep commands (12 identifier matches across the six files). Replaced each with
behavioural phrasing — "the action-authorization gate", "denied by the
action-authorization gate" for the block-handling headings and one prose reference,
and plain descriptive text (e.g. "exhaustive per-category business logic is
deliberately out of scope", "this skill's read-and-act scope") for the package-spec
mentions. Verified via `git diff` that no `Signals:` bullet or confidence-rubric
line was touched — only identifier-bearing sentences changed, satisfying AC-5.
Re-ran the AC-1 grep to confirm green, then committed.

Cycle 2 (delete "Adding a category", AC-2): removed the section. The forward-pointer
sentence in the intro paragraph that referenced it had already been removed in Cycle
1, since that sentence contained an identifier and was naturally cleaned up in the
same edit — considered keeping that pointer text until Cycle 2 for stricter cycle
boundaries, but since it was already bundled with an identifier removal in the same
paragraph, resolving both together was cleaner than reintroducing then re-removing
text. Re-ran AC-1 and AC-2 greps, both green, committed.

Cycle 3 (add terminal `self-escalation` category, AC-3/AC-4): the main design
decision was where the new category's matching signals come from and how confidently
they discriminate. Since escalation.md's missing-configuration fallback is the only
path that ever addresses an outgoing escalation to the account's own address, the
decisive signal is that the message is self-addressed (`From:` and `To:` both equal
the account's own configured address, obtained the same way that fallback obtains
it), reinforced by the literal `Escalation: ` subject prefix SKILL.md's
escalation-composition step always writes, and by the missing-config body text
escalation.md's fallback always adds.

Placed the new category in its own "## The skill's own escalation mail" section
after "## No confident match", rather than folding it into "## Starter categories
and their matching signals" as a sixth entry — that section's intro text ("Five
starter categories exist...adjustable sketch") describes the extensible, adjustable
business-logic categories the now-deleted "Adding a category" section covered, and
this new category is structurally different: it is fixed, terminal infrastructure
required for the escalation design to close its own loop, not a revisable sketch.
Keeping it in a separate section avoided having to touch or reinterpret the "Five
starter categories exist" sentence and kept AC-5's "behaviourally unchanged" scope
unambiguous (confirmed by `git diff` showing this cycle as a pure addition to
README.md plus one new file). The workflow file itself follows the same shape as the
five existing ones (intro boilerplate, a file-without-reply section, a
worklog-entry section, a blocked-move section) plus one new section, "Never escalate
this message", making the terminal behaviour explicit and covering the edge case of
the filing move itself being blocked — the naive failure mode of escalating instead
is called out and explicitly forbidden there.

**Tried and rejected:** nothing was rejected outright during the session; the one
judgment call (index-entry placement — sixth starter entry vs. separate section) was
decided in favour of the separate section for the reasons above.

**Remaining:** nothing outstanding against T-146's acceptance criteria; all three
Verification block commands pass in the final state. No files outside the task's
Files to Touch list were modified.

Commits on `task/T-146-rewrite-category-taxonomy`:

- `6d12bce` docs(email-triage): scrub identifiers from category taxonomy
- `165f3ee` docs(email-triage): drop the adding-a-category section
- `606e80f` docs(email-triage): add terminal self-escalation category

## Review

### Review Verdict — 2026-08-07

PASS

Both review stages passed. This is review cycle 1 for T-146; no prior verdict
existed (the earlier reviewer session was terminated before recording
anything, so every acceptance criterion below was re-verified from scratch,
including AC-5, which the prior session had only partially checked).

**Stage 1 — Acceptance Criteria** (checked against `task/T-146-rewrite-category-taxonomy`,
commits `6d12bce`, `165f3ee`, `606e80f`, diffed against `dev-agent`):

- **AC-1 (no identifiers under `categories/`):** Ran the task's own verification
  grep from a checked-out worktree of the branch —
  `grep -rnE '\b(S-0[0-9]{2}|T-[0-9]{3}|B-0[0-9]{2}|ADR-0[0-9]{2}|CR-0[0-9]{3})\b' .`
  inside `references/categories/` — no output. Met.
- **AC-2 (no add-a-category procedure/invitation):** Ran
  `grep -rniE 'adding a category|add a category|extend the list' .` — no
  output. Confirmed by reading the diff: the "Adding a category" section in
  `README.md` was deleted outright (18 lines removed in `165f3ee`), with no
  "do not edit" or similar notice added in its place, and no other file
  reintroduces any add-a-category guidance. Met.
- **AC-3 (self-escalation is genuinely terminal):** Read `self-escalation.md`
  in full. Its "Never escalate this message" section states the terminal
  rule explicitly and its "If the move is blocked" section explicitly
  overrides the generic block-handling delegation to
  `references/escalation.md` with "a blocked filing is never a reason to send
  an escalation for this message instead." Verified there is no implicit
  escalation path: checked the five existing categories' own "If the
  move/reply is blocked" sections (`newsletter-bulk.md`,
  `automated-notification.md`, `suspected-spam.md`, `direct-request.md`,
  `meeting-scheduling.md`) — none of them contain the word "escalate" in
  their blocked-handling sections, confirming the generic "block-handling
  rule" they and `self-escalation.md` all delegate to
  (`references/escalation.md`'s "record the denial as an open item... do not
  fall back to acting... a call denied by policy is recorded and never
  worked around") never itself routes to sending an escalation — it only
  ever means "record as an open worklog item, do not treat as handled." So
  neither the explicit text nor the block-handling delegation offers any
  path back to another escalation. Met.
- **AC-3 signal grounding:** Cross-checked each claimed matching signal
  against `SKILL.md` and `references/escalation.md` as currently merged on
  `dev-agent` (T-143/T-144, unmodified by this task):
  - Self-addressed `From:`/`To:` — `escalation.md`'s missing-configuration
    fallback sends to the account's own address (obtained from
    `himalaya template write`'s default `From:` header per the `himalaya`
    skill's "Finding the Account's Own Address" section) via
    `-H 'To:<own address>'`, and `template write` fills `From:` with that
    same account address by default when not overridden — so the resulting
    message is self-addressed on both headers exactly as claimed.
  - `Escalation: ` subject prefix — `SKILL.md`'s escalation-composition
    command is literally
    `-H "Subject:Escalation: $SUBJECT"`, an exact match for the claimed
    literal prefix.
  - Missing-config body text — `escalation.md`'s fallback "additionally
    state[s] that the configuration file was missing... and the directory
    where the file was expected: `<workspace>/config/`", matching the claim
    that the body "names the workspace's `config/` directory." All three
    signals are accurately grounded. Met.
- **AC-4 (index entry, same shape, matching signals):** The new entry
  (`### \`self-escalation\`` — description paragraph — `Signals:` bullet
  list) in `README.md` has the identical internal shape to each of the five
  existing entries. It is placed in its own new `## The skill's own
  escalation mail` H2 section rather than as a sixth `###` entry under `##
  Starter categories and their matching signals`. Judged this satisfies
  AC-4: the criterion's text is "in the same shape as the existing
  entries," which is about entry format, not section placement, and the
  entry format matches exactly. The Dependencies note confirms `SKILL.md`
  "consults this index by name and enumerates no categories itself," so
  placement elsewhere in the same `README.md` index file does not affect
  discoverability — `SKILL.md` step 3.1 reads the whole index file, not a
  specific heading. The separate-section placement is also substantively
  justified: folding it into "Starter categories" would misrepresent a
  fixed, terminal infrastructure category as part of the "adjustable
  sketch" the starter-category intro paragraph describes. Met.
- **AC-5 (five existing categories and confidence rubric unchanged
  behaviourally):** Diffed all five existing workflow files individually —
  every changed line is identifier-scrub-only (dropping `(S-004)` from
  "If the move/reply is blocked" headings, dropping `S-010` prose
  references). No `Signals:` bullet, confidence-rubric line, or any other
  behavioural text was touched in any of the five files or in `README.md`'s
  "Confidence rubric" / "No confident match" sections. Met.
- **Unspecified behaviour / unexpected files:** `git diff --stat`
  `dev-agent`..branch touches exactly the seven files named in the task
  (`README.md`, five existing category files, `self-escalation.md`); the
  task file itself also appears in the raw `dev-agent`-vs-branch diff, but
  confirmed via `git show --stat` on each of the three commits that the
  Developer never touched it — that diff is solely because `dev-agent`
  moved the task to `in-progress/` and appended the work log after the
  branch was cut. No unspecified behaviour added.
- **Commit subjects vs. `git-conventions` 72-char limit:** `6d12bce` (60
  chars), `165f3ee` (54 chars), `606e80f` (57 chars) — all well under the
  limit, correct `docs(email-triage): <description>` format, imperative,
  lowercase, no trailing period.

**Stage 2 — Code Quality** (documentation-only change; applied the checklist
as it maps to reference-doc content):

- **Correctness:** The new category's signals and terminal-loop logic are
  internally consistent and accurately grounded against the actual merged
  `SKILL.md`/`escalation.md` behaviour they describe (see AC-3 signal
  grounding above). The "If the move is blocked" edge case is handled
  explicitly rather than left implicit.
- **Readability:** Prose style, heading shape, and cross-reference
  conventions (`references/escalation.md`, `references/worklog.md`, the
  `himalaya` skill) match the five existing category files throughout;
  `self-escalation.md`'s section structure mirrors
  `newsletter-bulk.md`'s (intro, file-without-reply, worklog entry, blocked
  section) plus the one new "Never escalate this message" section the
  terminal behaviour requires. No dead text or leftover placeholders.
- **Security/Performance:** Not applicable — no code, no external input,
  no secrets.
- **Tests:** Not applicable in the code-test sense; the task's own
  verification block is grep-based and every command was re-run
  independently against the branch with the expected (empty/matching)
  output, as recorded above.

No issues found. No unrelated files were touched.

Next owner: Development Loop.
