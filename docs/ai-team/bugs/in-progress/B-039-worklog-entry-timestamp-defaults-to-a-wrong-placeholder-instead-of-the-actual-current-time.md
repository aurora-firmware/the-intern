---
id: B-039
title: worklog entry timestamp defaults to a wrong placeholder instead of the 
  actual current time
severity: medium
status: in-progress
created: '2026-08-10'
task: T-164
---

# worklog entry timestamp defaults to a wrong placeholder instead of the actual current time

## Summary

The `worklog` skill's `references/entry-format.md` shows the per-item entry
header as `## <HH:MM> — <item-identifier>` but never instructs the
consuming skill (here, `email-triage`) to determine the real current time
with a `bash` call before substituting it in. During a live scheduled-job
run of `email-triage` under T-164's install-path re-validation, the agent
wrote a worklog entry with the literal placeholder `00:00` instead of the
actual local time the run executed at (~22:24, the same session), then
tried to correct the mistake after the fact using tools (`edit`, and a
`bash` call running an ad hoc Python heredoc) that this skill's own "Tool
usage" section explicitly says it should never need — both correction
attempts were correctly denied by the S-004 action-authorization gate, so
the wrong timestamp was never fixed and still sits in the worklog file.

## Reproduction Status

Status: confirmed

Evidence-backed: reproduced once, live, during T-164's scheduled-job
validation run (single observation so far; not yet tested for how often
this recurs across repeated runs/models).

## Evidence

- Live session transcript (JSONL), first `toolCall`/`toolResult` pair
  showing the entry being written with a literal `00:00` header, then two
  denied attempts to correct it:
  `~/.pi/agent/sessions/--tmp-...-t164-job-workspace--/2026-08-10T20-24-00-685Z_019fed58-b1ad-7fe3-9c32-fc8899a83362.jsonl`
  — the assistant's `bash` tool call that appended the entry used
  `## 00:00 — You have been invited to join Holded`, followed later by a
  denied `bash` call running:
  ```
  python3 - <<'PY'
  from pathlib import Path
  p=Path('worklog/2026-08-10.md')
  s=p.read_text()
  s=s.replace('## 00:00 — You have been invited to join Holded', '## 22:25 — You have been invited to join Holded', 1)
  p.write_text(s)
  PY
  ```
  and a denied `edit` tool call with the same old/new text substitution.
- bob's own audit trail (`audit.jsonl` in the isolated T-164 validation
  runtime) records both denials as
  `{"allow": false, "reason": "no action rule permits tool 'edit' with the supplied arguments"}`
  and the equivalent `'bash'` denial for the Python heredoc, at
  `2026-08-10T20:25:06Z` and `2026-08-10T20:25:11Z` UTC — roughly a minute
  after the entry was first written at `2026-08-10T20:24:58Z` UTC (local
  time ~22:24/22:25, matching the interactive session's independently
  observed local clock at ~22:13–22:18 the same evening; see T-164's Work
  Log Session 1 for the corroborating interactive-session evidence).
- Final worklog file (job workspace) content:
  ```
  ## 00:00 — You have been invited to join Holded (from Holded <no-reply@mail.holded.com>)

  - Done: Classified as a routine automated notification (no-reply service invite) and moved from INBOX to INBOX.Notifications.
  - Left: nothing
  - Next: Nothing further for this message.
  ```
- By contrast, a same-evening *interactive* `bob chat` session asked to
  record a worklog entry (T-164's AC-3 validation, after the S-004 rule set
  was broadened to admit a standalone `date +%H:%M*` lookup) correctly
  computed and used the real local time (`22:13`, then `22:18` on a second
  run) by embedding a `NOW=$(date +%H:%M)` assignment inside its combined
  `mkdir -p worklog; ...; cat >> worklog/$TODAY.md <<EOF` append command —
  proving the skill *can* get this right when the model chooses to look up
  the time, but nothing in `entry-format.md` requires it to.

## Reproduction Steps

1. Deploy the `email-triage`/`worklog`/`himalaya` skill package at any
   `skill_install_path`, with the S-004 action-rule set documented in
   `the-intern/email-skills/README.md`'s "Verified S-004 action rules for
   the install-path model" section (this bug reproduced even with that
   set's `date +%H:%M*` rule present, since the run never called it).
2. Feed a scheduled `email-triage` job (`--cwd` holding only
   `config/email-triage.toml` and no prior `worklog/`) exactly one unseen
   message that confidently classifies as `automated-notification`.
3. Let the job fire and inspect the resulting `worklog/<today>.md` entry's
   `## <HH:MM> — ...` header against the actual wall-clock time the tool
   call ran at (compare the entry's timestamp to the audit trail's or
   session transcript's own timestamps for the same call).

## Expected Behavior

The worklog entry's `<HH:MM>` header reflects the actual local time the
entry was recorded, the same way the interactive session in this same
evidence set correctly did.

## Actual Behavior

The scheduled-job run wrote the literal placeholder `00:00` instead of the
real time, then — on apparently noticing the mistake — tried to fix it
using `edit` and an ad hoc `bash`-run Python script, both denied by the
S-004 action-authorization gate (correctly, since this skill's own
documented tool-usage contract in `SKILL.md`/`entry-format.md` only ever
calls for `bash`-driven `mkdir`/`cat >>` operations on the worklog file,
never `edit` or arbitrary scripts). The wrong `00:00` entry was never
corrected and still sits in the deployed worklog file as the permanent
record of when this item was handled.

## Environment

- OS / platform: Linux (dev sandbox), same as the rest of this repository's
  live validation work.
- Language / runtime version: `pi` 0.80.3 (npm `@earendil-works/pi-coding-agent`),
  model `gpt-5.5` (medium thinking), `bob` built from `dev-agent` at the
  time of T-164.
- Relevant dependencies: `the-intern/email-skills/skills/worklog/references/entry-format.md`,
  `the-intern/email-skills/skills/email-triage/references/worklog.md`.
- Branch / commit: observed on `task/T-164-revalidate-skill-install-path-e2e`,
  based on `dev-agent` at the point T-164 was picked up (S-011 chain,
  T-150–T-163 already merged).

## Related

- Task: `T-164` (discovered during this task's live end-to-end
  re-validation; out of T-164's own Files-to-Touch scope to fix, since
  fixing it requires editing skill files, not the docs T-164 is scoped to)
- Specification: `S-011-vendor-neutral-skills-package-and-bob-side-skill-loading.md`

## Suspected Area

`the-intern/email-skills/skills/worklog/references/entry-format.md` (the
canonical diary-mechanics reference that defines the entry format but never
instructs a `bash date` lookup for `<HH:MM>`) and/or
`the-intern/email-skills/skills/email-triage/references/worklog.md` (the
consuming skill's own email-specific worklog notes).

## Fix Verification

```bash
# Manual, live (matches this bug's own reproduction steps): re-run a
# scheduled email-triage job against one confidently-classifiable unseen
# test message and confirm the resulting worklog entry's <HH:MM> header
# matches the real wall-clock time the entry was appended at, within a
# one-minute tolerance, with no denied edit/bash-correction attempt in the
# session transcript or bob's audit trail.
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-08-11

Reproduction status: Confirmed. Not re-triggered live in this session (would require a live pi + mailbox run, out of scope for diagnosis), but directly verified against the primary artifacts preserved from T-164's original live run rather than relying solely on the bug report's paraphrase:
- Session transcript: `~/.pi/agent/sessions/--tmp-claude-1000--home-daneel-projects-the-intern-6f9a0df4-ea74-452b-b6da-adbff69974d1-scratchpad-t164-job-workspace--/2026-08-10T20-24-00-685Z_019fed58-b1ad-7fe3-9c32-fc8899a83362.jsonl`
- Job workspace final worklog file: `/tmp/claude-1000/-home-daneel-projects-the-intern/6f9a0df4-ea74-452b-b6da-adbff69974d1/scratchpad/t164/job-workspace/worklog/2026-08-10.md`
- Job's audit trail: `/tmp/claude-1000/-home-daneel-projects-the-intern/6f9a0df4-ea74-452b-b6da-adbff69974d1/scratchpad/t164/bob-dev/state/bob/audit.jsonl`
- Comparison interactive-session transcript: `~/.pi/agent/sessions/--tmp-claude-1000--home-daneel-projects-the-intern-6f9a0df4-ea74-452b-b6da-adbff69974d1-scratchpad-t164-chat-cwd--/2026-08-10T20-13-01-950Z_019fed4e-a47e-7b4b-b333-e2a1f0e7ce13.jsonl`

Evidence captured:
1. In the job-workspace session, the ordered bash tool-call commands were (extracted with `grep -o '"command":"[^"]*"'` from the JSONL): the `himalaya` classify/move sequence, then `TODAY=$(date +%F)\nmkdir -p worklog\ncat >> worklog/$TODAY.md <<'EOF'\n## 00:00 — You have been invited to join Holded ...` — this call ran BEFORE any `date +%H:%M` call. Only afterward did the model run `date +%H:%M` (presumably realizing the mistake), followed by the two denied correction attempts (`python3` heredoc rewriting the file, then an `edit` call with the same substitution).
2. `worklog/2026-08-10.md` in the job workspace contains the literal, uncorrected header `## 00:00 — You have been invited to join Holded (from Holded <no-reply@mail.holded.com>)`.
3. The job's `audit.jsonl` records exactly two denials matching the bug report's cited evidence, confirmed independently via `grep '"allow":false'`: `2026-08-10T20:25:06.501969305+00:00 no action rule permits tool 'bash' with the supplied arguments` (the python heredoc) and `2026-08-10T20:25:11.749159142+00:00 no action rule permits tool 'edit' with the supplied arguments` (the edit call) — matching the bug report's cited `20:25:06Z`/`20:25:11Z` exactly.
4. By contrast, the same-evening interactive session (`t164-chat-cwd`) shows the model spontaneously composing `NOW=$(date +%H:%M)\nTODAY=$(date +%F)\nmkdir -p worklog\ncat >> worklog/$TODAY.md <<EOF\n## $NOW — T-164-interactive-validation\n...` — i.e. it computed a real `NOW` variable symmetric to `TODAY` and used it correctly, without ever writing a literal placeholder.
5. `diff` confirms `skills/worklog/references/entry-format.md`, `.pi/skills/worklog/references/entry-format.md`, and `claude/skills/worklog/references/entry-format.md` are byte-identical (as the package's build contract requires), so the fault is present in all three deployed/packaged copies, not just the canonical source.
6. `skills/email-triage/references/worklog.md` (the other file named in the bug's "Suspected Area") was read and contains no timestamp-related content at all — it only covers `<item-identifier>` and closing conditions — so it is not part of the isolated fault; the fault is confined to `entry-format.md`.

Isolated fault: `the-intern/email-skills/skills/worklog/references/entry-format.md`, "Creating the worklog file" section (the shown append-command code block, current lines 20-31, and its accompanying prose, current lines 33-46). The code block explicitly assigns `TODAY=$(date +%F)` as a bash lookup feeding the append target, but the same heredoc's `## <HH:MM> — <item-identifier>` header line carries no equivalent computed variable for the time — it is shown only as a bare template placeholder. The prose after the block says only "substitute the actual time, item identifier, and outcome text into its body before running the command," which never instructs a `bash date` lookup for the time value the way the command block visibly does for the date value.

Root cause or fault hypothesis: This is a confirmed root cause, not a hypothesis — directly evidenced by comparing the two live sessions above. The consuming model followed the entry-format.md code block literally: it saw one bash-computed value (`TODAY`) and one bare placeholder (`<HH:MM>`) in the same shown command, and treated the placeholder as a template slot to fill with a default/generic value (`00:00`) rather than as something requiring its own `date` lookup — because nothing in the reference told it to compute one. The interactive session, given the identical reference document, only got it right because the model spontaneously chose to compute `NOW` on its own initiative; nothing in the skill's instructions required or even suggested that step, so the outcome is not reliably reproducible across runs/models, matching the bug's own framing.

Planned fix: Edit `the-intern/email-skills/skills/worklog/references/entry-format.md`'s "Creating the worklog file" section so the shown command block computes the current time the same explicit way it computes `TODAY`, e.g. adding `NOW=$(date +%H:%M)` alongside `TODAY=$(date +%F)` and using `$NOW` in the heredoc header instead of the bare `<HH:MM>` placeholder, plus tightening the surrounding prose to state explicitly that the time must come from this `date` lookup, not be estimated or left as a placeholder. After editing the canonical source, regenerate and commit the two packaging targets per the package's own build contract (`./package-pi-skills.sh` and `./package-claude-skills.sh` from `the-intern/email-skills/`) so `.pi/skills/worklog/references/entry-format.md` and `claude/skills/worklog/references/entry-format.md` stay byte-identical to the canonical source, exactly as `skills/worklog/SKILL.md` and the README's "Regenerating the ... package" sections require. No source/production Rust code is implicated — this is a skill-reference-content fix only.

Planned verification:
- Automated: `the-intern/email-skills/test_package_pi_skills.sh` and `test_package_claude_skills.sh` already assert the two generated targets stay in sync with `skills/`; re-run both after regenerating to confirm no drift. Add a new automated content assertion (exact mechanism left to the tdd cycle) that `skills/worklog/references/entry-format.md`'s shown append-command block contains an explicit `date`-derived time lookup (e.g. a `NOW=$(date +%H:%M)`-shaped assignment) used in the `<HH:MM>` header position, so this asymmetry with `TODAY=$(date +%F)` cannot regress silently.
- Manual/live, per the bug's own documented Fix Verification: re-run a scheduled `email-triage` job against one confidently-classifiable unseen test message and confirm the resulting worklog entry's `<HH:MM>` header matches the real wall-clock time within a one-minute tolerance, with no denied `edit`/`bash`-correction attempt in the session transcript or bob's audit trail.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-11

Read the full Diagnosis Log (Diagnosis 1) from `dev-agent` before starting; the Work Log section was empty, so this is the first implementation session. Followed the tdd skill's red→green→refactor cycle for the fix contract.

Wrote a new regression test, `the-intern/email-skills/test_worklog_entry_format_timestamp.sh`, following the house style of the existing `test_package_pi_skills.sh` (`set -euo pipefail`, `run_test` helper, PASS/FAIL output, non-zero exit on any failure). It extracts the shown `bash` command block from the "Creating the worklog file" section of `skills/worklog/references/entry-format.md` and asserts (1) the block contains a `date +%H:%M`-shaped variable assignment, and (2) the heredoc's entry header uses that computed variable rather than a bare `<HH:MM>` placeholder. Confirmed it failed against the pre-fix file (`FAIL: shown append-command block computes the current time via a date +%H:%M lookup`).

Implemented the fix in the canonical source exactly per the fix contract: added `NOW=$(date +%H:%M)` alongside the existing `TODAY=$(date +%F)` in the shown command block, and replaced the bare `## <HH:MM> — <item-identifier>` header with `## $NOW — <item-identifier>`.

While writing the prose update, I noticed and tested (via a throwaway shell run) that because the heredoc delimiter is intentionally quoted (`<<'EOF'`, to keep untrusted item content inert), `$NOW` does not shell-expand inside the heredoc body — running the block as literally shown would write the literal string `$NOW` into the worklog file, a different but equally wrong defect that would fail the bug's own Fix Verification criterion (the header must match real wall-clock time). I considered restructuring the append into a `printf`-plus-heredoc combination that would let `$NOW` expand safely outside the quoted section, but rejected this as exceeding the fix contract's minimal-change scope and introducing new risk (item-identifier text would then sit in an unquoted `printf` argument, which is not obviously safer). Instead I tightened the prose to explicitly instruct: because the delimiter is quoted, `$NOW` will not auto-expand — before running the command, replace the literal `$NOW` text with the actual `HH:MM` value the `NOW=$(date +%H:%M)` lookup returned, the same way `<item-identifier>` and the `Done`/`Left`/`Next` text are already substituted before running. This stays within "tighten the surrounding prose to explicitly require this date lookup for the time value" from the fix contract, but is worth reviewer attention since it goes slightly beyond the contract's literal wording ("use `$NOW` in the header") to ensure the fix is actually behaviorally correct rather than just textually matching the instruction.

Re-ran the new test — both assertions pass. Regenerated the two packaging targets via `./package-pi-skills.sh` and `./package-claude-skills.sh` from `the-intern/email-skills/`, confirmed all three copies (canonical, `.pi/skills/`, `claude/skills/`) are byte-identical for this file via `diff`. Re-ran the two pre-existing packaging test suites (`test_package_pi_skills.sh`, `test_package_claude_skills.sh`) — both pass (5/5 each), confirming no drift.

Committed the full cycle in one commit on `bug/B-039-worklog-timestamp-placeholder` (`cadd135`, `fix(email-skills): compute worklog entry time via date, not placeholder`) covering the canonical source edit, both regenerated packaging targets, and the new test script — did not split into separate red/green commits since the implementation was a single small, cohesive prose-and-template change with no intermediate stable state worth a separate commit.

Nothing else was touched: `skills/email-triage/references/worklog.md` was re-confirmed (per the Diagnosis Log) to contain no timestamp content, so it was correctly left out of scope. No production Rust/TS code was touched. The bug lifecycle file's stale in-tree copy on this branch was read for context only, never edited or committed, per the loop's instructions.

What remains: the bug's own manual/live Fix Verification step — re-running a real scheduled `email-triage` job against a live mailbox and confirming the resulting worklog entry's `<HH:MM>` header matches real wall-clock time within one minute, with no denied correction attempt in the transcript or audit trail — is out of scope for this session (requires external resources) and remains for a human or a later live-validation task, matching T-164's own pattern for this kind of live-only verification step.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-11

FAIL

Reviewed `bug/B-039-worklog-timestamp-placeholder` at `cadd135` (based on `dev-agent` `08a97e3`) against the Diagnosis Log (Diagnosis 1 — 2026-08-11) and Work Log (Session 1) on `dev-agent`.

**Diagnosis→fix evidence chain (Stage 1 gate): present and adequate.** Diagnosis 1 records confirmed reproduction status (verified directly against the preserved T-164 session transcript, job worklog file, and audit trail rather than trusting the bug report's paraphrase), evidence captured (ordered tool-call extraction, the literal `00:00` entry, the two `audit.jsonl` denials, and the contrasting interactive session that correctly computed `NOW`), an isolated fault scoped to `entry-format.md`'s "Creating the worklog file" section, and a confirmed (not hypothesized) root cause. This satisfies Step 1 of the code-review skill; proceeded to Stage 1/Stage 2.

**Stage 1 — bug criteria, mostly met:**
- Fix touches exactly the isolated fault's file and section: confirmed via `git show --stat cadd135` (4 files: canonical `entry-format.md`, the two regenerated packaging copies, and the new test script — no other files, no bug lifecycle file changes on the branch, confirmed via `git diff --stat 08a97e3 cadd135 -- docs/ai-team/bugs/` returning nothing).
- Canonical source now computes `NOW=$(date +%H:%M)` alongside `TODAY=$(date +%F)` and uses `$NOW` in the header, exactly as items 1–2 of the review brief describe.
- The two packaging targets (`.pi/skills/worklog/references/entry-format.md`, `claude/skills/worklog/references/entry-format.md`) are byte-identical to the canonical source: verified via `diff` and `md5sum` in a scratch worktree, and by re-running `./package-pi-skills.sh` and `./package-claude-skills.sh` fresh in that worktree and confirming `git status --porcelain` showed zero drift afterward.
- New regression test `test_worklog_entry_format_timestamp.sh` is real (not a stub): confirmed red against `cadd135~1`'s `entry-format.md` (`FAIL: shown append-command block computes the current time via a date +%H:%M lookup`, exit 1) and green against the committed version (2/2 pass, exit 0), by swapping the file content in the scratch worktree. Full suite on the branch as committed passes: `test_worklog_entry_format_timestamp.sh` (2/2), `test_package_pi_skills.sh` (5/5), `test_package_claude_skills.sh` (5/5).
- Bug's Fix Verification automated-verifiable portion is satisfied by the above; the manual/live re-run-against-a-real-mailbox portion is explicitly and correctly out of scope per the Work Log, matching the T-164 precedent for live-only verification — not a review blocker on its own.

- **One bug-criteria check does not pass**, per item 3 of the review brief: the fix does not reliably resolve the isolated fault's actual behavioral consequence (a wrong, non-time value landing in the worklog header) — see Stage 2 finding below, which is severe enough to fail Stage 1 too since it means the fix does not actually make the header "reflect the actual local time" (the bug's own Expected Behavior) under a plausible, natural execution path.

**Stage 2 — code quality: one blocking issue, one non-blocking observation.**

1. **Blocking — `the-intern/email-skills/skills/worklog/references/entry-format.md`, "Creating the worklog file" section** (and both regenerated packaging copies, which must stay in sync with whatever fix is applied here). I independently tested the Developer's claim from Work Log Session 1 that `$NOW` does not auto-expand inside the `<<'EOF'`-quoted heredoc — **confirmed true** (throwaway shell test: a quoted heredoc containing `$NOW` in its body writes the literal text `$NOW`, not the variable's value). But the prose-instruction mitigation the Developer chose in place of restructuring is not an acceptable resolution: I ran the entire shown append-command block **exactly as displayed**, as a single literal bash execution (the most natural way to satisfy the new prose's own requirement that "`NOW` must come from this ... `date` lookup" — running the block live performs a real lookup, so it is a plausible, easy path for a model to take, and is exactly analogous to how the original bug's evidence shows the model performing the equivalent block as a single tool call). The result:
   ```
   ## $NOW — You have been invited to join Holded
   ```
   — the literal text `$NOW`, not a real time value, landed in the worklog file. This is the same class of defect the bug reports (a wrong non-time string in the `<HH:MM>` header position) with a different literal payload (`$NOW` instead of `00:00`). The added prose (telling the model to manually pre-substitute `$NOW` with the `date`-lookup result before running the command) is dense, arrives only after the code block, and asks the model to override the natural reading of `$NOW` as auto-expanding shell syntax — especially confusing since `$TODAY` two lines above it in the *same block* **does** auto-expand (it sits outside the quoted heredoc, in the redirect target). This is a materially worse placeholder design than the pre-existing, angle-bracket `<item-identifier>` convention already used successfully in the same heredoc body, precisely because `<item-identifier>` cannot be mistaken for live-expanding code. Given the original bug arose from a model not reliably following prose substitution instructions under non-interactive/scheduled conditions, reintroducing a new prose-reliant substitution requirement — dressed in syntax that actively suggests it needs no manual intervention — is a real, reproducible gap, not merely a theoretical one; it is not a "minimal and safe" execution of the fix contract's intent (the Diagnosis Log's own root-cause language cares about the model reliably getting a *real* time value into the file, not just about the reference file mentioning `date` somewhere).
   **What should change:** Do not use real shell-variable syntax (`$NOW`) as a manual-substitution marker inside the quoted heredoc body. Replace it with a template-style token that cannot be mistaken for auto-expanding shell syntax, consistent with the existing `<item-identifier>` convention — for example `## <NOW> — <item-identifier>` (or keep `<HH:MM>` and instruct substitution with the `NOW` lookup's result) — while keeping the `NOW=$(date +%H:%M)` line so the "must be a real `date` lookup, never guessed" requirement is preserved. This is a small, same-scope rename, not a restructuring of the heredoc or its quoting (the quoted delimiter should stay, for the injection-safety reason already documented). Re-run the new regression test and packaging tests after the change, and regenerate both packaging targets again.

2. **Non-blocking observation — same file, "Per-item entry format" section** (currently lines 61–72, unchanged by this fix): this section still shows the bare, unqualified `## <HH:MM> — <item-identifier>` header with no note that `<HH:MM>` must come from a `date` lookup rather than a guess. It documents the general per-item entry shape ("Append one entry to today's file for every item a run handles"), separately from the exact copy-run command in "Creating the worklog file," so a model could plausibly treat it as its own template source for later items in a multi-item run — reproducing the original defect via this second, unfixed occurrence of the same placeholder pattern. Not required to resolve this FAIL (it was correctly outside the Diagnosis Log's isolated-fault line range), but worth tightening in the same pass since the file is already being touched — e.g. a one-line cross-reference back to the "Creating the worklog file" section, or the same non-shell-syntax token used consistently.

Everything else in the fix contract was correctly followed: no unrelated files touched, no unrelated refactoring, `skills/email-triage/references/worklog.md` correctly left alone (re-confirmed to contain no timestamp content), and the Diagnosis Log's planned automated verification was implemented as specified. The blocking issue is a targeted, same-scope revision (rename one token, no architectural change), so this stays a FAIL for the Developer to address, not an escalation.

Next owner: Bug-Fix Loop → Developer.
