---
name: email-triage
description: >
  Runs the scheduled email-triage workflow: on a "Check email" (or an
  equivalent scheduled triage) prompt fired from this package's own working
  directory, detect unseen mail, reconcile the daily worklog on the day's
  first executed run, and for each unseen message either act on it or
  escalate it to the configured manager address — recording a worklog entry
  for every message handled either way. This is the triage-policy skill: it
  carries the reconciliation, confidence-gated act-or-escalate, and diary
  rules. It is not the himalaya CLI reference — load the `himalaya` skill
  for the actual commands and flags, and see `references/worklog.md` and
  `references/escalation.md` for the diary and escalation rules this loop
  follows rather than restating them here.
allowed-tools: Read Bash
---

# Email Triage

This is the policy skill S-010 describes: it decides what to do with a
mailbox, not how to drive `himalaya`. Every run of this loop follows the
same four steps — reconcile (first executed run of the day only), detect
unseen mail, act on or escalate each unseen message, and record a worklog
entry for it — and delegates the CLI mechanics and reference detail to the
`himalaya` skill and this skill's own `references/` files rather than
restating them here.

---

## Tool usage

Every tool call this skill or the `himalaya` skill makes is subject to
bob's S-004 action gate — not only the himalaya invocations. S-004 gates
every pi-agent tool call, so the config read, the worklog reads and
appends, and any on-demand `references/*.md` load are all gated the same
way. This skill keeps that surface uniform and explicit, so one narrow
allow-rule set can admit the whole package (S-010 Configuration
Requirements):

- **`read`** — every read-only load: `config/email-triage.toml`, any
  `worklog/*.md` file's contents (used during reconciliation), and any
  `references/*.md` file — this skill's own references, and the `himalaya`
  skill's own reference file when that skill is in play.
- **`bash`** — every himalaya CLI invocation (per the `himalaya` skill), and
  every worklog filesystem mutation: checking whether `worklog/` or today's
  file exists, creating either if missing, and appending each per-message
  entry (for example `mkdir -p`, `test -f`, and a redirection such as
  `printf ... >>` to append). Keeping every mutation — worklog writes and
  himalaya calls alike — on the same `bash` tool, rather than also reaching
  for the `write`/`edit` tools, keeps this package's entire mutating
  surface behind one tool for a later allow rule to admit by argument
  shape.

If a `read` for the config file or a worklog file, or a `bash` call to
create or append to the worklog, is itself blocked by S-004, that is a
deployment gap in the admitting allow rule (S-010 Configuration
Requirements), not a per-message condition — there is no lower-level record
left to write for that run. Treat it as a run-ending problem for this run,
the same way an unconfigured `himalaya` account is a run-ending problem.

---

## The loop

### 1. Determine whether this is the day's first executed run, and reconcile

Check whether today's worklog file, `worklog/<YYYY-MM-DD>.md` (today's local
calendar date), already exists (`bash`, e.g. `test -f`). Its absence is the
signal that no run has written to today's file yet — reuse that existing
file's presence as "is this the day's first executed run" rather than
adding a second, skill-owned last-run marker file, the same way this loop
avoids a skill-owned last-seen file for detecting new mail (step 2 below).

- **File does not exist yet:** treat this as the day's first executed run.
  Before doing anything else — before listing unseen mail — follow
  `references/worklog.md`'s "First-run reconciliation" section to find the
  most recent worklog file with open items and carry every still-open entry
  forward into today's file, including any pending manager escalation (an
  open item left by a previous low-confidence classification) and any open
  S-004 block, which this is also the point at which to retry.
  `references/worklog.md` defines the full mechanics — which file to walk
  back to, the entry format, how each kind of open item closes; do not
  re-derive or restate them here.
- **File already exists:** some run has already written to today's file
  (whether or not that run needed reconciliation) — skip reconciliation and
  go straight to listing unseen mail. (If an earlier run today reconciled
  nothing and saw no unseen mail, today's file may still be absent; the
  next run repeats this same first-run check, which is harmless —
  reconciliation itself is idempotent when there is nothing open to carry
  forward.)

### 2. List unseen mail

List unseen envelopes using the `himalaya` skill's own documented command
for filtering on the unseen flag (see its Operation Index → "Filter for
unseen mail") — do not restate the command or its syntax here; it belongs
to that skill, not this one. This is a `bash` call like every other
himalaya invocation, gated by S-004 the same way (see "Tool usage" above).
If it is blocked, no message has yet been identified as unseen, so there is
nothing to record a per-message worklog entry against yet — treat the block
as a run-ending problem for this run rather than a per-message open item.

Everything the rest of this loop does operates on the envelopes this
listing returns.
