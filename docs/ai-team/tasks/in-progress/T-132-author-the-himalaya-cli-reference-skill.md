---
id: T-132
title: Author the himalaya CLI-reference skill
status: pending  # pending | in-progress | completed | blocked
priority: high  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Author the himalaya CLI-reference skill

## Description

S-010 Component 1: a generic `himalaya` skill that teaches pi-agent how to drive
the himalaya CLI. It carries **no** triage policy — no manager address, no
taxonomy, no worklog discipline — so any pi session sharing the package's working
directory (including an interactive `bob chat` started from there) can use it
without inheriting the email-triage job's rules (S-010 Design Principles).

Write it at the discovery path T-131 verified and recorded in
`the-intern/email-skills/README.md` (expected `.pi/skills/himalaya/`). Follow the
SKILL.md convention pi already uses for its installed skills: frontmatter with
`name`, a trigger-rich `description`, `compatibility`, and `allowed-tools`, a
short body, and detail pushed into `references/` files loaded on demand.

Cover every operation the triage workflow needs: listing and searching envelopes
(including filtering on the unseen flag), reading a message, replying,
forwarding, composing and sending, moving and copying, deleting, adding and
removing flags, handling attachments, and selecting an account.

Every documented command and flag must be checked against the installed
`himalaya` binary's own help output — do not write commands from memory. himalaya
account setup is out of scope (S-010 Exclusions); assume a configured account.

## Acceptance Criteria

AC-1: The system shall document the invocation for each operation the triage
      workflow needs: listing/searching envelopes including an unseen-flag
      filter, reading, replying, forwarding, composing and sending, moving,
      copying, deleting, adding/removing flags, attachments, and account
      selection.
AC-2: The system shall verify every documented command and flag against the
      installed `himalaya` binary's help output and record the verified
      `himalaya --version` in the skill.
AC-3: The skill shall contain no triage policy — no escalation address, no
      category taxonomy, no worklog instruction — so it is usable standalone by
      any pi session sharing this working directory.
AC-4: The skill's frontmatter shall declare `name`, a `description` naming
      himalaya and email-CLI usage as its trigger, and the tools it needs,
      matching the SKILL.md frontmatter convention used by pi's installed skills.
AC-5: IF the `himalaya` binary is not available on PATH THEN THE SYSTEM SHALL
      stop and escalate rather than documenting commands from memory.

## Dependencies

- `T-131` — verified skill-discovery path and package layout

## Files to Touch

- `the-intern/email-skills/.pi/skills/himalaya/SKILL.md` — new: frontmatter,
  health check, operation index
- `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md` —
  new: per-operation command and flag detail

## Verification

```bash
# Prerequisite — escalate if absent (AC-5)
himalaya --version

# For every command block in the skill and its reference file, confirm the
# subcommand and each flag exist in the installed binary's own help output:
himalaya --help
himalaya <subcommand> --help    # repeat per documented subcommand

# Confirm the skill is discovered and carries no triage policy. Use the
# non-interactive invocation form T-131 recorded (pi's default mode is a TTY
# TUI). The answer must come from this skill and must not mention escalation,
# categories, or the worklog.
cd /tmp/email-skills-probe && pi -p "Which himalaya command lists unseen mail? Answer from your available skills only. Do not run any tool."
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-02

Read T-131's README (`the-intern/email-skills/README.md`) and completed task file first, per the tdd skill's Step 0 (Work Log was empty — first session). Confirmed `himalaya` (v1.2.0 +maildir +smtp +wizard +sendmail +pgp-commands +imap, build linux musl x86_64) and `pi` (0.80.3) both on PATH before writing anything, per AC-5 and CLAUDE.md's hard precondition — no escalation needed.

Spent most of the session exhaustively walking `himalaya --help` and every relevant subcommand's own `--help` (`envelope`, `envelope list`, `flag {add,set,remove}`, `message {read,write,reply,forward,move,copy,delete,edit,send,save}`, `template {write,reply,forward,save,send}`, `attachment {download}`, `account {list}`, `folder {list}`), plus `himalaya manual` to confirm the generated man pages carry no additional detail beyond `--help` (checked specifically for MML attachment syntax, since `template`'s description mentions attaching files — none found, so I did not document an MML `<#part>` attach syntax anywhere, since that would be writing from memory rather than from verified `--help` output; "handling attachments" is covered by `attachment download` only, which is the CLI's only attachment subcommand).

Ran a small number of safe, non-mutating live checks against the real configured account (`daneel`) already present on this machine, to resolve behavior that `--help` text alone doesn't settle: confirmed `envelope list flag unseen` silently returns zero results rather than erroring (a real pitfall, since `unseen` isn't a real flag name — the correct query is `not flag seen`); confirmed option flags must precede the free-form query positional (`envelope list not flag seen -s 3` fails to parse, `envelope list -s 3 not flag seen` works); confirmed `-a daneel` account override and `-o json` output work as documented; confirmed via direct execution that `template write` prints a ready MML template to stdout with no `$EDITOR` invocation, in contrast to `message write/reply/forward/edit`'s own `--help` text, which explicitly says those use `$EDITOR`. Deliberately did **not** run any mutating command (delete, move, flag add/remove, non-preview read, or any `send`) against the real mailbox, to avoid altering real mail — noted this explicitly as a "not verified by live execution" caveat in the compose/send section of the reference doc.

Followed a red→green pattern for the discovery-facing scaffold: reproduced T-131's probe setup (`/tmp/email-skills-probe`, copy of `the-intern/email-skills/`), ran `pi -p -a "List the names of every skill available to you. Do not use any tools."` before any himalaya skill file existed (RED — only the three global skills listed), then wrote `SKILL.md` (frontmatter + Health Check + Operation Index table linking every required operation to an anchor in a not-yet-written reference file) and a stub `references/command-reference.md` with matching headers, re-ran the same probe (GREEN — `himalaya` now listed), and committed (`560214e`). Then filled in the full per-operation detail in `references/command-reference.md` (list/search, unseen-flag filter, read, reply, forward, compose+send, move/copy, delete, flags, attachments, account selection), cross-checked every anchor link in `SKILL.md`'s Operation Index against the reference file's actual `##` headers (all match), grepped both files for escalation/manager/taxonomy/worklog/category language (only appears inside the two explicit "this skill does NOT include policy" disclaimers, confirming AC-3), and committed (`2138b82`).

Ran the task's own Verification block end-to-end against a fresh probe copy as the final check. `himalaya --version` and the `--help` transcripts matched what I'd already verified. The discovery check (`pi -p -a "List the names of every skill..."`) correctly listed `himalaya`. The content-correctness check — literally as written in the task file (`pi -p "Which himalaya command lists unseen mail? Answer from your available skills only. Do not run any tool."`, bare `-p`, no `-a`) — did **not** produce a skill-sourced answer: reproducibly across two separate runs it either hallucinated a plausible-but-wrong command (`himalaya envelope list --filter unseen` — not a real flag) or said it had no available skill for himalaya at all. I investigated rather than assuming my content was at fault: rerunning with T-131's recorded `-p -a` form, but keeping "do not run any tool," reproduced the same failure — the bare "no tool" instruction appears to block pi's own on-demand skill-content loading mechanism, not just discovery. When I relaxed the instruction to explicitly permit the `read` tool while still forbidding himalaya/shell execution (`pi -p -a "... You may use the read tool to consult a skill's files, but do not run himalaya or any other shell command."`), the agent answered correctly and skill-sourced, reproducibly across two runs: `` `himalaya envelope list not flag seen` ``, with no mention of escalation, categories, or worklog. I did not edit the task file's Verification block (canonical lifecycle content, out of scope for the task branch) — recorded this as an Obstacle for the loop/reviewer, analogous to T-131's own bare-`-p`-vs-`-p -a` finding, since it looks like the same class of stale/incorrect literal command in a task's Verification block rather than a defect in the skill content itself (which independently checks out correct when the invocation form actually allows the skill to be consulted).

Nothing remains for this task as scoped — both Files to Touch exist, all five acceptance criteria have supporting evidence, and the working tree is clean with exactly two commits on the task branch. The one open item is the Verification-block wording discrepancy noted above, which is a matter for review/task-file correction rather than further implementation work.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
