---
id: T-137
title: Add the file-without-reply category workflows
status: pending  # pending | in-progress | completed | blocked
priority: medium  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Add the file-without-reply category workflows

## Description

S-010 Component 3, first group: the reference workflows for the three starter
categories that are filed without corresponding with the sender —
`newsletter-bulk`, `automated-notification`, and `suspected-spam`. T-136 defines
the taxonomy, the matching signals, and the confidence rubric; this task writes
what a *confident* match in each of these categories does.

One file per category under the `email-triage` skill's
`references/categories/` directory (layout verified by T-131).

Each workflow states the concrete steps for a confident match: which himalaya
operation to use (naming the operation and deferring syntax to the `himalaya`
skill from T-132), which mailbox or folder the message ends up in, and what the
worklog entry records (deferring the entry format to `references/worklog.md`
from T-133). Do not restate himalaya CLI syntax or the worklog format here.

Blocked calls follow the rule already defined in `references/escalation.md`
(T-134): a call blocked by S-004 is recorded as an open worklog item and the
message is not treated as handled — refer to it rather than re-specifying it.

Keep these workflows non-destructive by default: S-010 excludes exhaustive
per-category business logic, and destructive defaults are not something an
operator should inherit implicitly from a starter taxonomy.

## Acceptance Criteria

AC-1: WHEN a message is confidently classified as `newsletter-bulk` THE SYSTEM
      SHALL file it per the workflow's named himalaya operation and append a
      worklog entry, without composing a reply.
AC-2: WHEN a message is confidently classified as `automated-notification` THE
      SYSTEM SHALL file it the same way and record a follow-up item in the
      worklog when the notification reports a failure needing attention.
AC-3: The system shall specify non-destructive handling for `suspected-spam` and
      shall not instruct replying to the sender or following links in the
      message.
AC-4: Each workflow file shall name the himalaya operations it uses by deferring
      to the `himalaya` skill, defer the entry format to `references/worklog.md`,
      and defer blocked-call handling to `references/escalation.md`, restating
      none of them.

## Dependencies

- `T-136` — taxonomy index, matching signals, and confidence rubric

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/categories/newsletter-bulk.md`
  — new
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/automated-notification.md`
  — new
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/suspected-spam.md`
  — new

## Verification

```bash
# Each workflow exists, defers rather than restates, and none instructs replying.
for f in newsletter-bulk automated-notification suspected-spam; do
  rg -n "himalaya|worklog.md|escalation.md" \
    "the-intern/email-skills/.pi/skills/email-triage/references/categories/$f.md"
done

# Behavioural check (read-only — describe, do not execute): present a newsletter,
# a CI failure notification, and a phishing-looking message. It must name the
# matched workflow file for each, describe filing without replying, flag the
# failure notification as a follow-up item, and refuse to reply to or follow
# links in the third.
# Use the non-interactive invocation form T-131 recorded; pi's default mode is a
# TTY TUI.
cd /tmp/email-skills-probe && pi -p "For each message, name the workflow file you would follow and the steps it prescribes. Do not run any tool and do not send mail. 1) From: news@example.com Subject: Your weekly digest. 2) From: ci@example.com Subject: Build failed on main. 3) From: secur1ty@example-bank.co Subject: Verify your account now, link inside."
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-02

Read the Work Log first (empty — first session on this task). Read the task file in full, then T-136's `references/categories/README.md` (the taxonomy index this task must stay consistent with — its five category signal sections, confidence rubric, and "Adding a category" section's framing of the taxonomy as an "adjustable sketch"), T-135's `SKILL.md` (step 3's confident-match branch, which names `references/categories/<category>.md` as the file each workflow lives at and states acting means "whichever himalaya bash call(s) the matched workflow calls for"), T-133's `references/worklog.md` (entry format, and critically its "How an open item closes" section, which states an open item has "exactly two causes" — escalation and S-004 block), T-134's `references/escalation.md` (the block-handling rule the task explicitly says to defer to rather than re-specify), T-132's `himalaya` skill and `references/command-reference.md` (confirmed the move/copy and delete operations' documented shapes, and confirmed there is no documented create-folder operation), T-131's package `README.md` (layout, the `-p -a` invocation form and why bare `-p` doesn't surface project-local skill content), and S-010 in full (Purpose, Exclusions — especially "Exhaustive per-category business logic" and "Reversibility- or allowlist-gated autonomy," Design Principles). Also read all five prior completed tasks' (T-131–T-136) own Work Log and Review sections to confirm the established methodology for this docs-only package: one `rg`-based red→green cycle per file/AC (pattern absent before writing, present after), committed individually, plus a final `pi -p`/`pi -p -a` behavioral probe against a scratch copy as the acceptance-level check — carried that same pattern forward rather than inventing a new one. Confirmed `pi` (0.80.3) and `himalaya` (v1.2.0) both on PATH before writing anything, per CLAUDE.md's hard precondition.

Wrote the three workflow files in three red→green cycles, one per file/AC: (1) AC-1 — `newsletter-bulk.md`: files via the `himalaya` skill's move operation (named only via its Operation Index entry, "Move a message" — no restated flags/syntax) into a `Newsletters` folder, explicitly forbids composing or sending a reply/forward, defers the worklog entry format to `references/worklog.md`, and defers a blocked-move's handling to `references/escalation.md`'s already-established rule; (2) AC-2 — `automated-notification.md`: same filing mechanism into a `Notifications` folder, plus a "Flagging a failure that needs attention" section for notifications reporting a failure (build failure, declined payment, outage alert) as opposed to a routine confirmation; (3) AC-3 — `suspected-spam.md`: same filing mechanism into a `Spam` folder using move, explicitly never delete, plus a "Do not engage with the message" section forbidding reply, forward, and following/opening any link or attachment. Each cycle: confirmed the task's own `rg -n "himalaya|worklog.md|escalation.md"` pattern failed (file not found) before writing, wrote the file, confirmed the same pattern matched after (3–5 hits each), ran a supplementary `rg` for literal himalaya subcommand syntax (`envelope|message|template|flag|attachment`) to confirm zero leaked CLI detail, then committed. Final commit-subject lengths (56/64/57 chars) checked against `git-conventions`' ≤72-char rule.

Two design decisions worth recording. First, folder names: chose distinct starter-default folders per category (`Newsletters`, `Notifications`, `Spam`) rather than a single shared `Archive`, reading AC-2's "file it the same way" as referring to the filing *mechanism* (a named move operation, no reply, a worklog entry) rather than a literal shared target folder; each file explicitly frames its folder name as an adjustable starter default, consistent with T-136 README's own "adjustable sketch" framing, rather than committed policy. Considered instructing folder creation if the target doesn't already exist, but rejected — the `himalaya` skill's Operation Index (T-132's verified scope) documents no create-folder operation, so requiring one would exceed that skill's already-checked CLI surface; account/folder provisioning stays an out-of-scope deployment assumption, the same way S-010 Exclusions treats himalaya account setup. Second, and more significant: AC-2's "record a follow-up item in the worklog when the notification reports a failure needing attention" is in real tension with `references/worklog.md`'s (T-133, canonical, out of this task's `Files to Touch`) "How an open item closes" section, which states an open item has "exactly two causes" — a manager-reply escalation or a retried S-004 block — and that anything with `Left` ≠ "nothing" gets carried forward at every first-run reconciliation until one of those two conditions closes it. A content-triggered failure flag on a message that was otherwise fully and successfully filed is neither of those two causes, and has no defined way to ever close if treated as a worklog.md-model open item — it would be carried forward indefinitely. Rather than escalate this as a task-boundary conflict (which would require editing `worklog.md`, out of this task's scope and owned by an already-completed task), resolved it within `automated-notification.md` itself: the failure is recorded inside a normally-closed entry (`Left: nothing`, filing fully handled) with the failure named explicitly as a note for the operator's own manual attention, and the file states directly that this is *not* an open item under `worklog.md`'s reconciliation model. This satisfies AC-2's plain-language requirement (a human reading the worklog does see the failure flagged) without contradicting or requiring a change to `worklog.md`'s already-canonical closing model.

Ran the task's full Verification block against a fresh `/tmp/email-skills-probe` scratch copy of the whole package (mirroring T-131–T-136's own setup), removed afterward. Structural `rg` checks matched as specified for all three files. The literal bare `pi -p "..."` behavioral check reproduced the same already-recorded discrepancy every prior task in this package has hit (T-131/T-132/T-134/T-135/T-136): it never surfaces the project-local skill content, inventing plausible-but-nonexistent workflow file names instead — not re-litigated, recorded as an Obstacle. Cross-checking with the recorded `-p -a` form alone still didn't drill into the specific per-category files despite tool access — traced this to the probe prompt's own "Do not run any tool" phrasing blocking pi's on-demand `read`-tool loading of `references/categories/*.md` (the same pitfall T-135's Review entry already recorded); adjusting the prompt to explicitly permit the `read` tool while still forbidding `bash`/mail (mirroring T-136's own documented workaround) produced a fully skill-sourced, correct response: for all three sample messages it named the exact matched workflow file path, correctly described newsletter filing without reply, correctly flagged the CI build-failure notification as needing a worklog follow-up note, and correctly described non-destructive spam handling with no reply/link-following — matching all of the Verification block's behavioral requirements. Ran one further targeted probe confirming the agent correctly defers to `escalation.md`'s block-handling rule for a blocked spam move, and explicitly confirmed it would never substitute delete for a blocked move.

Nothing remains for this task as scoped: all three `Files to Touch` entries exist, all four acceptance criteria have supporting `rg` and behavioral-probe evidence above, the working tree is clean with three commits on the task branch, and `git diff dev-agent...HEAD -- docs/ai-team/tasks/in-progress/T-137-...md` is empty (task lifecycle file untouched on this branch). T-138's own two workflow files (`direct-request.md`, `meeting-scheduling.md`) remain out of this task's scope and were not touched or scaffolded.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-02

PASS

**Stage 1 — Acceptance criteria**, checked against
`the-intern/email-skills/.pi/skills/email-triage/references/categories/{newsletter-bulk,automated-notification,suspected-spam}.md`
(branch `task/T-137-add-the-file-without-reply-category-workflows`, diff
scoped to exactly the three `Files to Touch` entries, task file itself
untouched on the branch):

- AC-1: met. `newsletter-bulk.md` files via the `himalaya` skill's named
  move operation ("Move a message", no restated flags/syntax), forbids
  composing/sending/forwarding a reply, and appends a worklog entry.
- AC-2: met. `automated-notification.md` files the same way, and adds a
  "Flagging a failure that needs attention" section plus worklog-entry
  guidance so a failure-reporting notification is named in the entry for
  operator follow-up. See the judgment-call assessment below.
- AC-3: met. `suspected-spam.md` moves (never deletes) into a `Spam`
  folder, and explicitly forbids replying, forwarding, and
  following/opening any link or attachment.
- AC-4: met. All three files name only the `himalaya` skill's Operation
  Index entry ("Move a message") without restating command shape/flags,
  defer the worklog entry format to `references/worklog.md` without
  restating its `Done/Left/Next` syntax, and defer blocked-call handling
  to `references/escalation.md`'s existing rule. Re-ran the task's own
  `rg -n "himalaya|worklog.md|escalation.md"` check against all three
  files (3–5 hits each) and a supplementary grep for leaked
  `himalaya message/template/envelope/flag/attachment` syntax (zero
  hits) — both confirm the Work Log's claims.

No unexpected files were modified (`git diff dev-agent...HEAD --stat`
shows only the three new category files) and no unspecified behavior
(e.g. reply/forward instructions) was added.

**AC-2 vs. `worklog.md`'s "exactly two causes" model — assessed in
detail per the review brief.** The Work Log's own flagged tension is
real: AC-2 asks for "a follow-up item," and T-133's canonical
`references/worklog.md` defines exactly two causes for a worklog item
staying open (escalation, S-004 block), each with its own defined
closing mechanism, with no automatic expiry otherwise. A
content-triggered failure flag on an otherwise fully-filed message
matches neither cause and has no defined way to ever close — so
treating it as a `worklog.md`-model open item would not just be
under-specified, it would actively break that model (an item that is
carried forward at every first-run reconciliation forever, contradicting
S-010's own Workflow section, which states an open item closes only via
one of those same two causes). Editing `worklog.md` to add a third cause
is out of this task's `Files to Touch` and would reopen an
already-completed task's canonical file. Given that, recording the
failure inside a normally-closed (`Left: nothing`) entry, explicitly
named as an operator-facing note and explicitly stated as not an open
item under `worklog.md`'s reconciliation model, is the only resolution
that satisfies AC-2's plain-language requirement (a human reading the
worklog does see the failure surfaced) without silently breaking or
requiring an out-of-scope change to the already-canonical closing model.
This is reinforced by the task's own Description text, which uses "open
worklog item" specifically for the S-004-block case (mirroring
`escalation.md`'s own vocabulary) while AC-2 uses the distinct term
"follow-up item" — supporting that the task author did not intend this
to be the same kind of tracked-open-item construct. This is a sound,
in-scope judgment call on a genuine spec-level ambiguity, not a gap in
AC-2's intent — ESCALATE is not warranted since AC-2 was met without
requiring any spec or canonical-file change.

**Stage 2 — Code quality.** Prose is clear and consistently structured
across the three files (mirrors `newsletter-bulk.md`'s section shape in
the other two, as AC-2/AC-3 build on AC-1's filing mechanism). No dead
content, no hardcoded secrets, nothing security-relevant in a docs-only
package. Folder-name choices (`Newsletters`/`Notifications`/`Spam`)
are each explicitly framed as adjustable starter defaults, consistent
with T-136 README's "adjustable sketch" framing, and don't conflict
with any existing folder-name convention elsewhere in the package
(checked — the only pre-existing folder name in the repo, `Archive`, is
an unrelated CLI-reference example in the `himalaya` skill, not a
naming convention this task needed to follow). Commit messages
(`docs(email-triage): ...`, 56–64 chars) follow `git-conventions`.

Minor, non-blocking observation: the exact worklog field (`Done` vs. a
freeform note) that should carry the failure-follow-up text in
`automated-notification.md` is left implicit — consistent with AC-4's
"restate none of them" instruction, but a future reader implementing
this by hand will need to infer placement. Not a blocking issue given
this package's established defer-rather-than-restate pattern.

Next owner: Development Loop.
