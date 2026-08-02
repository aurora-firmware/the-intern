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
