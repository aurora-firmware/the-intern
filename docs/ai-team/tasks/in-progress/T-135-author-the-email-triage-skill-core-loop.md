---
id: T-135
title: Author the email-triage skill core loop
status: pending  # pending | in-progress | completed | blocked
priority: high  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Author the email-triage skill core loop

## Description

S-010 Component 2, Phase 2: the `email-triage` SKILL.md that a scheduled firing
discovers from its `--cwd` and runs end to end. This task delivers the core loop
**without** the category taxonomy — a single generic act-or-escalate behaviour;
T-136 wires classification in afterwards.

Write `SKILL.md` in the `email-triage` skill directory (layout verified by
T-131), following pi's SKILL.md convention: `name`, trigger-rich `description`,
`allowed-tools`, a short body, and detail delegated to references.

The loop, per S-010's Workflow:
1. If this is the day's first executed run, reconcile per `references/worklog.md`
   (T-133) — including any pending manager escalation.
2. List unseen envelopes using the `himalaya` skill's documented command (T-132).
   Do not restate himalaya syntax here, and do not introduce a skill-owned
   last-seen state file — the mailbox's `\Seen` flag is the only new-mail signal
   (S-010 rejected a bespoke state file).
3. For each unseen message, act on it or escalate per `references/escalation.md`
   (T-134). The gate is confidence in the classification for that specific
   message — not the action's reversibility, not a sender allowlist.
4. Append a worklog entry per message so a completed run leaves no unseen message
   without an action, an escalation, or a recorded block.

Every himalaya call is a `bash` call gated by S-004; a block is recorded as an
open worklog item and the message is not treated as handled. S-004 is
default-deny over **every** tool call, not just himalaya ones — the config read,
worklog read/append, and on-demand `references/*.md` loads are gated too. Name
the tool each of those uses explicitly and keep that choice uniform, so T-139 can
record one narrow allow-rule set covering the whole package.

## Acceptance Criteria

AC-1: WHEN the skill runs THE SYSTEM SHALL detect new mail by listing envelopes
      carrying the unseen flag through the `himalaya` skill's documented command,
      without maintaining any skill-owned last-seen state file.
AC-2: WHEN the run is the day's first executed run THE SYSTEM SHALL perform the
      reconciliation defined in `references/worklog.md` before processing new
      mail.
AC-3: The system shall, for each unseen message, either act on it or escalate it
      per `references/escalation.md`, gated on confidence in that message's
      classification and not on the action's reversibility or a sender allowlist.
AC-4: WHEN a message has been handled THE SYSTEM SHALL append a worklog entry for
      it, so that a completed run leaves no unseen message without an action, an
      escalation, or a recorded block.
AC-5: The skill's frontmatter shall declare `name`, `description`, and its
      required tools per the pi SKILL.md convention, and the body shall delegate
      himalaya syntax to the `himalaya` skill rather than restating it.

## Dependencies

- `T-132` — `himalaya` skill whose commands this loop invokes
- `T-133` — worklog format and first-run reconciliation reference
- `T-134` — escalation reference and skill-local configuration

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/SKILL.md` — new: frontmatter
  and the detect → reconcile → act-or-escalate → record loop

## Verification

```bash
# The loop delegates rather than restates, and names all four steps.
rg -n "unseen|reconcil|escalat|worklog|himalaya" \
  the-intern/email-skills/.pi/skills/email-triage/SKILL.md

# Behavioural check (read-only — instruct the session to describe, not execute):
# the walkthrough must (a) list unseen envelopes via the himalaya skill,
# (b) reconcile first when it is the day's first run, (c) escalate rather than
# guess when unsure, and (d) append a worklog entry per message.
# Use the non-interactive invocation form T-131 recorded; pi's default mode is a
# TTY TUI.
cd /tmp/email-skills-probe && pi -p "You receive the scheduled prompt 'Check email'. Describe, step by step, exactly what you would do. Do not run any tool and do not send any mail."
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-02

Read the Work Log first (empty — first session), then the full task file, S-010 (Purpose, Design Principles, System Diagram, Responsibility Separation, Workflow, Configuration Requirements, Alternatives Considered), S-004 (confirmed the action gate's Component 5 text — "gate every pi-agent tool call through Policy Control before it runs" — actually does cover every tool call, not just `bash`, which grounds the task's explicit tool-naming instruction), and all four prior artifacts: T-131's `README.md` (discovery path, package layout, `-p -a` invocation form), T-132's `himalaya` skill and `references/command-reference.md` (CLI surface and its Operation Index anchors, especially "Filter for unseen mail"), T-133's `references/worklog.md` (entry format, first-run reconciliation walk-back rule, the two ways an open item closes), and T-134's `references/escalation.md` and `config/email-triage.example.toml` (manager-address config, escalation content requirements, S-004-block and missing-address hard stops). Also read the four completed tasks' own Work Log and Review sections (T-131–T-134) to confirm the established methodology for this docs-only skill package: structural `rg` checks per acceptance criterion as the red→green unit, plus a final behavioral `pi -p`/`pi -p -a` probe against a scratch copy as the acceptance-level check — carried that same pattern forward here rather than inventing a different one.

Confirmed `pi` (0.80.3) and `himalaya` (v1.2.0, same build as prior tasks) both on PATH before writing anything, per CLAUDE.md's hard precondition.

Wrote `the-intern/email-skills/.pi/skills/email-triage/SKILL.md` in five red→green cycles, one per acceptance criterion (ordered to match the loop's own read order rather than the ACs' numeric order): (1) AC-5 — frontmatter (`name`/`description`/`allowed-tools: Read Bash`) plus a "Tool usage" section that explicitly names `read` for every read-only load (config, worklog files, `references/*.md`) and `bash` for every himalaya invocation and every worklog filesystem mutation, as the task's context note required ("name the tool each of those uses explicitly and keep that choice uniform, so T-139 can record one narrow allow-rule set"); (2) AC-2 — the first-run reconciliation step, using today's worklog file's own existence as the "is this the day's first executed run" signal (deliberately reusing the already-required worklog artifact rather than adding a second skill-owned state file, mirroring the same rejected-alternative reasoning S-010 applies to last-seen-message tracking); (3) AC-1 — the unseen-mail-listing step, delegating to the `himalaya` skill's Operation Index entry by name instead of restating the command; (4) AC-3 — the per-message act-or-escalate step, gated purely on confidence in that message's classification (never reversibility or an allowlist), with a forward-compatible placeholder for T-136's taxonomy ("classify against it once it exists; until then, use your own judgment") and S-004-block handling for the acting path (escalation's own S-004/missing-address handling is deferred entirely to `references/escalation.md`, not restated); (5) AC-4 — the per-message worklog-entry step, stating explicitly that a completed run leaves no unseen message without an action, an escalation, or a recorded block. Each cycle: confirmed the relevant `rg` pattern had zero matches before writing (RED — including a literal "file does not exist" RED for cycle 1, since the file didn't exist yet), wrote the section, confirmed the pattern matched after (GREEN), and committed. Also grepped for literal himalaya command strings (`himalaya envelope|message|template|flag|attachment`) after every cycle to confirm zero restated syntax throughout, per AC-5's delegation requirement.

Ran the task's full Verification block as the final check. The structural `rg` check matched all five required terms repeatedly (14–20 hits each). The behavioral check, run against a fresh `/tmp/email-skills-probe` scratch copy: the literal bare `pi -p "..."` form specified in the Verification block reproduced the same class of finding T-131/T-132 already recorded — it never surfaced the project-local skills at all, producing a generic, non-skill-sourced answer (no mention of himalaya, reconciliation, escalation, or worklog). Cross-checking with T-131's recorded `-p -a` invocation form produced a fully skill-sourced, correct walkthrough: load `email-triage` for policy and `himalaya` for the CLI, confirm the working directory, list unseen mail via `himalaya`, reconcile first if this is the day's first run, per-message read → confidence gate → act or escalate to the manager address, worklog entry per message, no message left unaccounted for — matching all four behavioral requirements the Verification block lists. Ran two additional targeted probes beyond the literal block (mirroring T-134's precedent of extra targeted checks): one confirmed an S-004-blocked action is correctly described as "not treated as handled," recorded as an open worklog item, never substituted with another action; the other confirmed the day's-first-run detection is correctly described as keyed off today's worklog file's own presence, with no separate state file. Did not edit the task file's Verification block (canonical, out of scope on the task branch) — recording the bare-`-p` discrepancy as an Obstacle below, consistent with T-131/T-132/T-134's own handling of the same invocation-form issue. Removed the scratch copy afterward.

Nothing remains for this task as scoped: the single Files-to-Touch item exists, all five acceptance criteria have supporting `rg` and behavioral-probe evidence above, and the working tree is clean with five commits on the task branch, none touching the canonical task file (`git diff dev-agent...task/T-135-... -- docs/ai-team/tasks/in-progress/T-135-...md` is empty). T-136 still needs to wire the actual category taxonomy into step 3's classification point — this session left that point as an explicit, named placeholder ("classify against it once it exists; until then, use your own judgment") rather than inventing taxonomy content out of scope.

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

**Stage 1 — Acceptance Criteria.** Reviewed
`the-intern/email-skills/.pi/skills/email-triage/SKILL.md` (the only file the
diff touches, matching Files to Touch — `git diff dev-agent...task/T-135-...
--stat`: 1 file, 152 insertions) against each AC:

- AC-1 (detect new mail via the unseen flag through the `himalaya` skill's
  documented command, no skill-owned last-seen file): met. Step "2. List
  unseen mail" delegates to the `himalaya` skill's Operation Index entry
  "Filter for unseen mail" by name, with no restated command. `rg -n
  "himalaya (envelope|message|template|flag|attachment)"` against the file
  returns zero matches — confirmed no himalaya syntax leaked in. The only
  file-existence check the loop performs is against the worklog (already a
  required artifact per Component 4), not a second, purpose-built last-seen
  file.
- AC-2 (first-run reconciliation before processing new mail): met. Step "1.
  Determine whether this is the day's first executed run, and reconcile"
  precedes step 2 (mail listing) in reading order and in the loop's own
  numbering, and on the file-does-not-exist branch explicitly says "Before
  doing anything else — before listing unseen mail — follow
  `references/worklog.md`'s 'First-run reconciliation' section."
- AC-3 (act or escalate per `references/escalation.md`, gated on
  per-message classification confidence, never reversibility or a sender
  allowlist): met. Step 3 states the gate is "always confidence in that
  judgment for this message — never the action's reversibility, and never a
  sender allowlist (S-010 Design Principles)," and delegates the escalation
  mechanics (email content, S-004-block and missing-address hard stops) to
  `references/escalation.md` without restating them.
- AC-4 (worklog entry per handled message; no unseen message left without
  an action, escalation, or recorded block): met. Step 4 requires an entry
  "whatever the outcome" (acted, escalated, or blocked), and the loop's
  closing sentence states this explicitly: "A completed run leaves no
  unseen message from step 2 without exactly one of: an action taken, an
  escalation sent, or a block recorded as an open item — never silently
  skipped."
- AC-5 (frontmatter declares `name`/`description`/tools per the pi SKILL.md
  convention; body delegates himalaya syntax rather than restating it):
  met. Frontmatter has `name: email-triage`, a trigger-rich `description`,
  and `allowed-tools: Read Bash` — the same shape and casing as pi's own
  installed skills (`~/.pi/agent/skills/{gh-cli,pr-review}/SKILL.md`) and as
  the sibling `himalaya` skill this task depends on. Delegation confirmed by
  the zero-match `rg` check above.

No unspecified behavior was added, and no files outside Files to Touch were
modified.

**Stage 2 — Code Quality, with the extra scrutiny the task called for:**

- **Delegation to T-132/T-133/T-134 (no restating, no contradiction).**
  Cross-read `SKILL.md` against `references/worklog.md` (T-133),
  `references/escalation.md` (T-134), and the `himalaya` skill (T-132)
  line-by-line. Every mechanics-level rule (worklog entry format, first-run
  walk-back algorithm, escalation email content, S-004/missing-address hard
  stops, himalaya command shapes) is delegated by reference, not restated.
  The few places `SKILL.md` repeats a rule in its own words — "never fall
  back to acting on the message autonomously" (step 3) and "creating
  `worklog/` and today's file first if either is still missing" (step 4) —
  are brief outcome-level reminders, not mechanics, and mirror how
  `escalation.md` itself repeats the same "no autonomous fallback" rule
  across its own three subsections; no drift or contradiction found against
  any of the three reference files. The S-004-block handling for the
  *acting* path (step 3.2) is new content this task correctly had to write
  itself, since T-134's `escalation.md` only covers the escalation send's
  block — verified its `Left`/`Next` phrasing ("retried at the next
  first-run reconciliation once an admitting allow rule exists") is
  consistent with `worklog.md`'s own "How an open item closes" section for
  S-004 blocks.
- **Tool-usage naming — uniform and complete.** The "Tool usage" section
  names `read` for every read-only load (config, worklog file contents,
  any `references/*.md` load including the `himalaya` skill's own
  reference) and `bash` for every himalaya invocation and every worklog
  filesystem mutation (existence checks, creation, per-message append),
  with an explicit rationale for keeping all mutation on `bash` rather than
  `write`/`edit`. Checked every inline `` `bash` ``/`` `read` `` mention in
  the loop body against this table — all four loop steps' tool uses fall
  under one of the two named categories; none is left unnamed or
  ambiguous. `allowed-tools: Read Bash` in the frontmatter matches exactly
  the two tools the body ever names — no third tool implied anywhere.
  Independently reproduced the full structural check
  (`rg -n "unseen|reconcil|escalat|worklog|himalaya"`, 14–20 hits per term,
  matching the Work Log's reported counts) and the zero-match himalaya-
  syntax check in a worktree of the task branch.
- **Taxonomy placeholder does not commit to T-136's content.** Step 3.1's
  parenthetical ("A category taxonomy and per-category reference workflows
  live under `references/categories/` once added on top of this loop —
  when that taxonomy exists, classify against it and follow the matched
  category's workflow; until then, use your own judgment") is the only
  taxonomy-related text in the file. `grep -n -i
  "categor|taxonomy|newsletter|spam|notification"` finds only this one
  generic placeholder — no category names, no per-category policy content
  invented ahead of T-136.
- **Behavioral verification, reproduced independently.** Confirmed `pi`
  (0.80.3) and `himalaya` (v1.2.0) on PATH. Ran the task's literal `pi -p
  "..."` Verification-block command from a fresh scratch copy: reproduced
  the same class of non-skill-sourced-answer finding T-131/T-132/T-134
  already recorded for bare `-p` (a known task-file Verification-block
  invocation-form defect, not a defect in this task's content). Cross-
  checked with T-131's recorded `-p -a` form: produced a fully skill-
  sourced walkthrough naming all four loop steps in the correct order
  (load `himalaya` + `email-triage`, list unseen mail via `himalaya`,
  reconcile first on the day's first run, per-message confidence gate →
  act or escalate, worklog entry per message). Ran two additional targeted
  probes: one on the acting-path S-004-block outcome, one on first-run
  detection — an initial attempt with an overly restrictive "do not run
  any tool" instruction produced a hallucinated, incorrect answer for the
  block-outcome probe (the same known invocation-form pitfall T-132's
  review isolated: that phrasing blocks `pi`'s own on-demand `read` of
  skill content), so it was rerun explicitly permitting `read` while still
  forbidding himalaya/shell execution — the corrected run reproduced the
  Work Log's claimed result verbatim, quoting the file's own "stop acting
  on this message... The message is not treated as handled" language
  correctly. The first-run-detection probe correctly named the worklog
  file's presence as the sole signal, with no separate state file.
- **Commit hygiene.** Five commits, each `docs(email-triage): ...`,
  imperative/lowercase/no-period, none touching the canonical task file
  (`git diff dev-agent...task/T-135-... --
  docs/ai-team/tasks/in-progress/T-135-...md` is empty). Minor, non-
  blocking, consistent with T-133's own precedent for the same class of
  issue: two of the five subject lines run over the ≤72-char convention
  (73 and 75 chars) — `docs(email-triage): add unseen-mail detection step
  delegating to himalaya` and `docs(email-triage): add SKILL.md frontmatter
  and explicit tool-usage naming`. Not worth a review cycle on its own.

Both stages pass. No blocking issues.

Next owner: active Development Loop.
