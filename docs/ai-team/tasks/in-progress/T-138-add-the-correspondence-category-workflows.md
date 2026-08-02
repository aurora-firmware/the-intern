---
id: T-138
title: Add the correspondence category workflows
status: pending  # pending | in-progress | completed | blocked
priority: medium  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Add the correspondence category workflows

## Description

S-010 Component 3, second group: the reference workflows for the two starter
categories that send mail back to a human — `direct-request` and
`meeting-scheduling`. T-136 defines the taxonomy, matching signals, and the
confidence rubric; this task writes what a *confident* match in each does.

One file per category under the `email-triage` skill's
`references/categories/` directory (layout verified by T-131).

These are the categories where S-010's read-and-act scope is exercised: the
skill composes and sends real mail, not just summaries. Each workflow names the
himalaya operation to use (deferring syntax to the `himalaya` skill from T-132),
states what the reply must contain, and states what the worklog entry records
(deferring the format to `references/worklog.md` from T-133).

The confidence gate still applies inside a confident classification: if acting
would require information the run does not have — availability the skill cannot
determine, a decision only the owner can make — the message escalates per
`references/escalation.md` (T-134) instead of the workflow guessing. Blocked
calls likewise follow the rule already stated there; refer to it rather than
re-specifying it.

## Acceptance Criteria

AC-1: WHEN a message is confidently classified as `direct-request` THE SYSTEM
      SHALL draft and send a reply through the `himalaya` skill's reply operation
      and append a worklog entry naming the reply that was sent.
AC-2: WHEN a message is confidently classified as `meeting-scheduling` THE SYSTEM
      SHALL follow the workflow's concrete steps for proposing or confirming a
      time and replying to the sender.
AC-3: IF acting on a confidently-classified message would require information the
      run does not have THEN THE SYSTEM SHALL escalate per
      `references/escalation.md` instead of guessing.
AC-4: Each workflow file shall defer himalaya syntax to the `himalaya` skill and
      the worklog entry format to `references/worklog.md`, restating neither.

## Dependencies

- `T-136` — taxonomy index, matching signals, and confidence rubric

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/categories/direct-request.md`
  — new
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/meeting-scheduling.md`
  — new

## Verification

```bash
# Both workflows exist, defer rather than restate, and name the escalation path.
for f in direct-request meeting-scheduling; do
  rg -n "himalaya|worklog.md|escalation.md" \
    "the-intern/email-skills/.pi/skills/email-triage/references/categories/$f.md"
done

# Behavioural check (read-only — describe, do not execute): present a direct
# question answerable from the message alone, and a meeting request that depends
# on the owner's availability. It must describe drafting and sending a reply for
# the first, and escalate the second rather than inventing availability.
# Use the non-interactive invocation form T-131 recorded; pi's default mode is a
# TTY TUI.
cd /tmp/email-skills-probe && pi -p "For each message, name the workflow file you would follow and describe what you would do. Do not run any tool and do not send mail. 1) From: a.person@example.com Subject: What is the office postal address? 2) From: b.person@example.com Subject: Can we meet Thursday afternoon?"
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-02

Read the Work Log first (empty — first session on this task). Read the task file in full, then T-136's `references/categories/README.md` (taxonomy index, five category signal sections, confidence rubric — especially the "confident" rubric's "nothing about the sender, subject, or body contradicts the matched category" clause), T-137's three completed workflow files (`newsletter-bulk.md`, `automated-notification.md`, `suspected-spam.md`) and its full Work Log/Review — the assigning context explicitly flagged these as the sibling precedent, including T-137's documented resolution of a real tension between its AC-2 and `worklog.md`'s "exactly two causes" open-item closing model, resolved in-file rather than escalated. Also read `references/worklog.md` (entry format, "exactly two causes" closing model, "open items live in the worklog only"), `references/escalation.md` (escalation email content, block-handling, missing-`manager_address` handling), the `himalaya` skill's `SKILL.md` and `references/command-reference.md` (confirmed the "Reply to a message" Operation Index entry — `template reply` + `template send` — and confirmed there is no calendar/availability operation anywhere in the CLI reference), `SKILL.md` for `email-triage` (step 3's confident-match branch), `config/email-triage.example.toml` (confirmed only `manager_address` exists — no calendar/availability config of any kind), and the package `README.md` (layout, invocation form). Also skimmed S-010 in full for the "read-and-act" design principle and Component 3's purpose. Confirmed `pi` (0.80.3) and `himalaya` (v1.2.0) on `PATH` before writing anything.

Wrote the two workflow files in two red→green cycles, one per file/AC pairing, following T-137's established methodology (`rg` pattern absent before writing, present after, commit each individually): (1) AC-1 — `direct-request.md`: drafts and sends a reply via the `himalaya` skill's named "Reply to a message" operation (no restated flags/syntax), states the reply must answer the concrete ask using only information the run actually has, defers escalation for missing information to `references/escalation.md` (AC-3), and defers the worklog entry format to `references/worklog.md`, recording the reply as fully handled (`Left: nothing`) — the same "fully handled" shape T-137's file-without-reply categories use, just reached by replying instead of filing; (2) AC-2 — `meeting-scheduling.md`: same reply mechanism, split into two branches depending on what the message asks for.

The meeting-scheduling split was the one substantive design decision this task required, and it mirrors the shape of T-137's own documented tension. AC-2 requires "concrete steps for proposing or confirming a time and replying to the sender," but this package has no calendar or availability source anywhere — confirmed by re-checking the `himalaya` skill's full Operation Index and the config template. That means the workflow can never actually decide whether a time works for the owner; it can only act on a time the message already states. I resolved this by splitting into: (a) the message doesn't ask the owner to decide anything — it states or confirms a specific time, or reports a cancellation/reschedule — reply acknowledging exactly what was stated, never inventing a new time value or asserting availability; (b) the message does ask the owner to decide something availability-dependent (choose among times, state availability, confirm attendance in a way that commits the calendar) — this is precisely the confidence-gate case the task's own Description calls out ("information the run does not have... a decision only the owner can make"), so it escalates per `references/escalation.md` (AC-3) instead of guessing. I considered instead treating every meeting-scheduling message as requiring escalation (simpler, avoids the ambiguity), but rejected that because AC-2 explicitly requires genuine, non-escalating "propose or confirm and reply" steps to exist — collapsing the whole category into "always escalate" would leave AC-2 unmet. I also considered inventing some form of stand-in availability source (e.g., asking the sender to self-propose times) but rejected that as scope creep beyond what the message and this package's actual tool surface support, and inconsistent with the conservative "escalate when in doubt" design principle already established across every other reference file in this package. Documented the reasoning directly in `meeting-scheduling.md` itself (a short "What this workflow can and cannot decide" section) rather than escalating this as a task-boundary conflict, since it required no change to any canonical file outside this task's `Files to Touch`.

Ran the task's full Verification block against a fresh `/tmp/email-skills-probe` scratch copy of the whole package (removed afterward, mirroring T-131–T-137's own setup). Structural `rg` checks matched as specified for both files (5 and 7 hits respectively); a supplementary `rg` for literal himalaya subcommand syntax found zero leaked detail in either file. The task's exact behavioral probe command correctly named both workflow files and correctly escalated the "Can we meet Thursday afternoon?" message (AC-3) without inventing availability — but its other example message ("What is the office postal address?") also escalated rather than demonstrating AC-1's reply path, because a bare scratch probe has no source for that specific fact anywhere in this package (no FAQ/knowledge-base skill exists) — recorded as an Obstacle, not a defect, since escalating on an unanswerable fact is exactly AC-3's required "do not guess or fabricate" behavior. Ran two supplementary probes to positively demonstrate the remaining paths: a self-contained, answerable question ("What's 15% of 200?") correctly triggered `direct-request.md`'s reply-and-send happy path; a meeting-cancellation notice and a "confirming our call is set for Thursday at 3pm" message both correctly triggered `meeting-scheduling.md`'s no-availability-needed acknowledge branch without inventing new availability. Used the `read`-tool-permitted prompt phrasing T-137's Work Log already recorded as the workaround for pi inventing plausible-but-nonexistent workflow file names when denied all tool use.

Nothing remains for this task as scoped: both `Files to Touch` entries exist, all four acceptance criteria have supporting `rg` and behavioral-probe evidence above, the working tree is clean with two commits on the task branch, and `git diff dev-agent...HEAD -- docs/ai-team/tasks/in-progress/T-138-...md` is empty (task lifecycle file untouched on this branch). This closes out S-010 Component 3's full starter taxonomy (all five category workflow files now exist).

### Session 2 — 2026-08-02

Read the full Work Log (Session 1) and the Reviewer's `### Review Verdict — 2026-08-02` FAIL in full before starting. The FAIL had three findings: AC-1 met, AC-2 met as a defensible reading, AC-4 met — all confirmed correct by the Reviewer's independent checks — but AC-3 "not reliably met" because `meeting-scheduling.md`'s two branches (acknowledge-a-stated-time vs. escalate-for-availability) had no stated tie-breaker for messages that plausibly sit on the boundary between them, e.g. a message that states a time but makes it contingent on the owner's silence ("I'll pencil in Thursday at 3pm — let me know if that's a problem"). Confirmed the gap myself first: `rg` for tie-breaker language (`ambiguous|unclear|unsure|doubt|default|tie-break`) against the file returned zero matches, matching the Reviewer's finding exactly.

Fixed by adding one paragraph to the end of the "What this workflow can and cannot decide" section — the location the Reviewer suggested — stating that when a message does not clearly and unambiguously belong to one branch or the other, it is treated as needing the owner's decision and escalates per `references/escalation.md`, and explicitly walking through the Reviewer's own boundary example to show why it lands on the escalate side. The new paragraph closes with an explicit pointer to `references/categories/README.md`'s confidence-rubric default ("when in doubt between acting and escalating, escalate"), which is the exact mirroring the Reviewer asked for. I considered instead adding a shorter one-line tie-breaker at the top of each branch (the Reviewer's other suggested location) but chose the single consolidated paragraph in the shared section instead, since both branches already open with soft, mirror-image conditions and a single shared default is less likely to drift out of sync between the two branches than two separately-worded sentences would be.

Re-ran the task's full structural Verification block (`rg` for `himalaya|worklog.md|escalation.md` in both category files, plus a check for leaked himalaya subcommand syntax) — unchanged, still passing. Also ran two behavioral probes against a fresh `/tmp/email-skills-probe` scratch copy (removed after use, same setup as Session 1): (1) the Reviewer's exact ambiguous example, using the read-tool-permitted prompt phrasing Session 1 recorded as the workaround for pi inventing filenames — pi correctly quoted the new tie-breaker paragraph and concluded the message must escalate rather than being acknowledged and replied to; (2) a clearly unambiguous "already confirmed" message, to check the new paragraph didn't cause the acknowledge-and-reply branch to over-escalate — it still correctly resolved to that branch. `git diff --stat` against `dev-agent` shows only the one `Files to Touch` file changed (10 lines added, all in the one new paragraph); the task lifecycle file remains untouched on this branch. Committed as a single `docs(email-triage)` commit on `task/T-138-add-the-correspondence-category-workflows`.

Nothing remains for this task as scoped. All four acceptance criteria have supporting evidence (AC-1/AC-2/AC-4 unchanged from Session 1 and reconfirmed by the Reviewer's own independent checks; AC-3 now closed by the new tie-breaker paragraph, positively demonstrated against the Reviewer's own boundary example). Ready for re-review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-02

FAIL

**Stage 1 — Acceptance criteria.**

- AC-1 (direct-request draft/send + worklog entry naming the reply): met.
  `direct-request.md`'s "Draft and send a reply" and "Worklog entry"
  sections satisfy this, and its "If the answer needs information this
  run doesn't have" section correctly yields to AC-3 rather than
  contradicting AC-1.
- AC-2 (meeting-scheduling concrete steps for proposing/confirming a time
  and replying): met as a defensible reading. Independently confirmed the
  Developer's finding that this package has no calendar/availability
  source: the `himalaya` skill's Operation Index and
  `references/command-reference.md` cover mailbox operations only (list,
  read, reply, forward, compose/send, move/copy, delete, flags,
  attachments, account selection) with no calendar or availability
  operation of any kind, and `config/email-triage.example.toml` defines
  only `manager_address` — no calendar/availability key exists anywhere
  in this package. Given that, a workflow branch that autonomously
  "proposes" a brand-new candidate time would necessarily be guessing at
  availability, which AC-3 and the task's own Description already require
  to escalate instead — so mapping all genuine time-proposal/decision
  cases to escalation and reserving direct reply for restating a time the
  message itself already states is a correct, harmonized reading of AC-2
  and AC-3 together, not a gap.
- AC-3 (escalate rather than guess when acting needs unavailable
  information): **not reliably met** by `meeting-scheduling.md` — see
  Stage 2 finding below, which is a Stage 1 failure because it is a
  concrete scenario where the file's own instructions do not force the
  AC-3-required escalation.
- AC-4 (defer himalaya syntax and worklog format, restate neither): met.
  Verified independently with `rg` against both files for himalaya
  subcommand syntax (`template reply`, `template send`, `envelope list`,
  `message read`, `--folder`, etc.) — zero matches in either file. Both
  files point to the `himalaya` skill's Operation Index and to
  `references/worklog.md`/`references/escalation.md` by name without
  restating their content, matching T-137's precedent style.
- No unexpected files were modified (`git diff --stat` against
  `dev-agent` shows only the two `Files to Touch` entries); no
  unspecified functionality was added.

**Stage 2 — Code quality.**

- File and location: `the-intern/email-skills/.pi/skills/email-triage/references/categories/meeting-scheduling.md`,
  the "## What this workflow can and cannot decide" section (the sentence
  "Which of the two sections below applies depends on which the message
  is actually asking for.") together with the two branch sections that
  follow it ("Confirm or acknowledge a stated time, and reply" and "If
  the request needs the owner's availability").
- What is wrong: the file introduces a new, judgment-based split — does
  this message ask the owner to decide something availability-dependent,
  or does it merely state/report a settled time — that determines whether
  the workflow replies directly or escalates. Both branches are correct
  and safe on their own (branch (a) never invents a time value or asserts
  availability; branch (b) escalates whenever a real decision is needed),
  and I confirmed with `rg` that neither branch nor the section between
  them contains any tie-breaking language ("ambiguous", "unclear",
  "unsure", "doubt", "default", etc. — zero matches in the file). Unlike
  `direct-request.md`, whose reply/escalate split is anchored to a
  checkable, factual condition (does the run literally possess the
  answering information — so any doubt about possession already falls to
  "does not have it" → escalate, per that file's "anything not contained
  in the message or otherwise available to the run" catch-all),
  `meeting-scheduling.md`'s two branches are defined by soft, mirror-image
  language with no stated default for messages that do not cleanly
  announce which bucket they belong in. A real message can plausibly sit
  on that boundary — for example an opt-out-style notice such as "I'll
  pencil in Thursday at 3pm for our call — let me know if that's a
  problem," which states a specific time (branch (a) surface shape: "a
  reschedule ... the sender is simply reporting") while functionally
  soliciting an owner decision only on the condition of an objection
  (branch (b)'s substance: a decision that commits the calendar unless the
  owner is heard from). As written, an executing agent resolving that
  ambiguity toward branch (a) would reply and record the message as fully
  handled — nothing left outstanding, no worklog open item — without the
  owner ever actually being asked, which is exactly the "acting on
  information the run does not have" failure AC-3 exists to prevent, and
  the task's own Description explicitly extends the confidence gate's
  "escalate when in doubt" conservatism (already stated as a general
  principle in `references/categories/README.md`'s confidence rubric) to
  decisions made inside an already-confident classification.
- What should change: add one explicit tie-breaker sentence — either in
  the "What this workflow can and cannot decide" section or at the top of
  each branch's opening condition — stating that when it is not clearly
  one or the other, the message is treated as needing the owner's
  decision and escalates per `references/escalation.md`. This mirrors the
  conservative default this package already states elsewhere
  (`references/categories/README.md`: "when in doubt between acting and
  escalating, escalate") and closes the one boundary the two branches
  currently leave undefined, without requiring any change to either
  branch's already-correct core behavior or to any other file.

No other Stage 2 issues found: correctness elsewhere is sound, no tests
apply to this documentation-only task (verified structurally via the
task's own `rg` Verification block, independently re-run against a
worktree checkout of the task branch — matched as claimed), no security
concerns, naming/structure is readable and consistent with T-137's
sibling files, and no dead or unrelated content was added.

Next owner: Development Loop. Developer should add the tie-breaker
sentence described above to `meeting-scheduling.md` and resubmit.
