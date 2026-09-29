---
id: T-230
title: Teach the bob-companion skills to set and verify pi_agent_model
status: completed
priority: medium
assigned-role: developer
created: '2026-09-29'
---

# Teach the bob-companion skills to set and verify pi_agent_model

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

Teach the bob-companion Claude Code plugin's agent where the model is set and
how to verify it (CR-015 item 6; S-002 v0.2 "Operator documentation").

- `bob-setup/SKILL.md` (§6 "Config file", "Notable keys", ~line 102): add
  `pi_agent_model` as the one place to set the pi model for every session bob
  starts; note that `--model`, `--models`, or `--provider` in `pi_agent_args`
  are rejected at load. Instruct the agent, whenever it sets or changes the
  key, to confirm the value first: `pi --list-models <search>` to see the
  model's exact `provider/id`, and `pi auth check --provider <p> --json` to
  confirm the provider's credentials are `ready`. Also state that a changed
  `pi_agent_model` takes effect only after restarting `bob serve`, so an agent
  checking spawned command lines (e.g. with `ps`) right after editing will
  not see `--model` yet.
- `bob-troubleshooting/SKILL.md` and `references/symptom-table.md`: map the
  symptoms — the startup warning about an unset `pi_agent_model`; a
  `Model "…" not found` line in the service log; a scheduled job that ran but
  did nothing; a config-load error about model flags in `pi_agent_args` — to
  those checks and the fix.
- Both skills state the checks' limits as observed pi behaviour, not a stable
  contract: `--list-models` fuzzy-matches and exits 0 when nothing matches;
  `auth check` validates provider credentials only (an unknown model under a
  configured provider still reports `ready`), so pass the model as
  `provider/id` with `--provider` set.

Follow `docs/ai-team/docs/coding-guidelines-skills.md` §1–2: no internal
task/bug/spec/ADR/issue IDs, no pi version, placeholder model/provider names.

## Acceptance Criteria

AC-1: The `bob-setup` skill shall list `pi_agent_model` among the notable keys
      as the one place to set the model, and state that model flags in
      `pi_agent_args` are rejected.
AC-2: WHEN the agent sets or changes `pi_agent_model`, THE `bob-setup` skill
      SHALL instruct it to confirm the value with `pi --list-models` and
      `pi auth check --provider <p> --json` before relying on it, and state
      that the change takes effect only after restarting `bob serve`.
AC-3: The `bob-troubleshooting` skill and its symptom table shall map the four
      symptoms above to those checks and the fix.
AC-4: Both skills shall describe the checks' limits as observed pi behaviour.
AC-5: IF the added text names a model or provider THEN it shall be a clearly
      placeholder value, with no internal IDs and no pi version.

## Dependencies

- `T-226` — final warning wording
- `T-227` — stderr forwarding the troubleshooting text relies on

## Files to Touch

- `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md`
- `the-intern/bob-companion/claude/skills/bob-troubleshooting/SKILL.md`
- `the-intern/bob-companion/claude/skills/bob-troubleshooting/references/symptom-table.md`

## Verification

```bash
S=the-intern/bob-companion/claude/skills
grep -n "pi_agent_model" $S/bob-setup/SKILL.md $S/bob-troubleshooting/SKILL.md $S/bob-troubleshooting/references/symptom-table.md
grep -n "list-models\|auth check" $S/bob-setup/SKILL.md $S/bob-troubleshooting/SKILL.md
# only the lines this task adds must be free of internal IDs and versions
! git diff -U0 "$(git merge-base dev-agent HEAD)" -- $S/bob-setup/SKILL.md $S/bob-troubleshooting/SKILL.md $S/bob-troubleshooting/references/symptom-table.md | grep '^+[^+]' | grep -nE "\b(T|B|S|CR)-[0-9]{3}\b|ADR-[0-9]{3}|#[0-9]{2,}|\b[0-9]+\.[0-9]+\.[0-9]+\b"
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-29

Implemented T-230 in a single session. Read the canonical task file, the already-reviewed `pi_agent_model` section of the operator guide (`the-intern/docs/src/operator-guide/index.md`), and the ground-truth Rust sources (`serve.rs`'s `warn_if_pi_agent_model_unset`, `config.rs`'s `validate()`/`model_selecting_flag_in`, and `pi-agent-supervisor/src/process.rs`'s stderr forwarding) to get exact runtime strings rather than re-deriving them. Also found a completed task file that recorded pi's real `Model "<x>" not found. Use --list-models to see available models.` error text from a live run, which was placeholder-ized as `Model "<value>" not found...` for the skill content.

Edited `bob-setup/SKILL.md` §6: added `pi_agent_model` to the notable-keys list, then a new block stating it's the only place to set the model, that model flags in `pi_agent_args` are rejected at load, the two confirmation commands (`pi --list-models <search>`, `pi auth check --provider <p> --json`) with their observed-behavior limits, and the restart-required caveat (a `ps` check right after editing won't show `--model` yet).

Edited `bob-troubleshooting/SKILL.md`: added a new `pi_agent_model symptoms` section listing all four symptoms from the task (unset-model startup warning, `Model "<value>" not found` log line, a scheduled job that fired but left no audit trace, and the `pi_agent_args` config-load rejection), each with its check and fix, plus the same list-models/auth-check limits paragraph.

Edited `references/symptom-table.md`: appended four rows mapping the same four symptoms to cause and fix, reusing the exact warning/error strings from the Rust source rather than paraphrasing them.

Considered folding the symptom list into the existing "False alarm" sections in `bob-troubleshooting/SKILL.md` but rejected that — these aren't false alarms (the underlying config problem is real), so a dedicated section reads more accurately.

Ran all three verification commands from the task file exactly as written, including the ID/version-leak scan, which produced no output — confirming no internal task/bug/spec/ADR IDs, GitHub issue numbers, or pi version numbers were introduced. Confirmed only the three files in "Files to Touch" were modified. Committed the change as a single cycle (`edab123`) on `task/T-230-bob-companion-pi-agent-model-skills`.

Nothing remains for this task — all five acceptance criteria are covered and the verification block passes clean.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-29

PASS

Reviewed `task/T-230-bob-companion-pi-agent-model-skills` at `edab123` (merge-base
`dca70ac`) via an isolated `git worktree`, against the diff in
`the-intern/bob-companion/claude/skills/bob-setup/SKILL.md`,
`the-intern/bob-companion/claude/skills/bob-troubleshooting/SKILL.md`, and
`the-intern/bob-companion/claude/skills/bob-troubleshooting/references/symptom-table.md`,
cross-checked against `the-intern/service/crates/bob/src/serve.rs`
(`warn_if_pi_agent_model_unset`, the periodic dispatcher's `send_prompt_and_drain`
error branch), `crates/bob/src/config.rs` (`validate()`, `model_selecting_flag_in`,
`pi_agent_shared_args`), and `crates/pi-agent-supervisor/src/process.rs`
(`spawn_stderr_forwarder`).

**T-229 pitfall check (restart-required framing).** T-229 cycle-1 FAILed for
falsely implying `pi_agent_model` was uniquely exempt from `bob policy reload`,
when `pi_agent_cwd`/`skill_install_path` share the same startup-only, restart-required
behavior. This diff does not repeat that pattern: `bob-setup/SKILL.md`'s new
restart paragraph ("A changed `pi_agent_model` only takes effect after the next
`bob serve` restart...") states the requirement for this key alone and makes no
comparison to, or exemption from, any other key or command — `bob policy reload`
is never mentioned anywhere in this diff, and neither skill file has pre-existing
restart-behavior claims for `pi_agent_cwd`/`skill_install_path` that this text
could contradict. No false-uniqueness claim present.

**Stage 1 (acceptance criteria):**
- AC-1 (notable keys + rejected flags): met. `pi_agent_model` added to the
  `bob-setup` notable-keys list; new block states it is the "**only**" place to
  set the model and that `--model`/`--models`/`--provider` in `pi_agent_args`
  are rejected at load — matches `config.rs`'s `MODEL_SELECTING_FLAGS` and
  `model_selecting_flag_in`.
- AC-2 (confirm before relying, restart requirement): met. New `bob-setup` text
  instructs confirming with `pi --list-models <search>` and
  `pi auth check --provider <p> --json` before relying on the value, and states
  the restart requirement clearly (see pitfall check above).
- AC-3 (four symptoms mapped): met in both `bob-troubleshooting/SKILL.md`'s new
  "`pi_agent_model` symptoms" section and the four new `symptom-table.md` rows —
  unset-model startup warning, `Model "<value>" not found` log line, a scheduled
  job that fired but left no trace, and the `pi_agent_args` config-load
  rejection. Runtime strings verified verbatim against source:
  - Warning text matches `warn_if_pi_agent_model_unset` exactly, character for
    character.
  - Config-load error matches `config.rs`'s
    `"pi_agent_args must not select a model ({flag} found); set the model with
    pi_agent_model instead"` exactly.
  - `Error: Model "<value>" not found. Use --list-models to see available
    models.` is pi's own error (not bob's), correctly forwarded per
    `spawn_stderr_forwarder`'s "pool worker stderr: {line}" behavior and
    placeholder-ized from the real transcript recorded in T-228's Work Log
    (`Error: Model "definitely-not-a-real-model-t228" not found. ...`).
  - The "scheduled job ran but did nothing" claim (no `verdict`/`event`/`report`
    audit record, `bob audit tail` shows nothing) matches `serve.rs`'s
    `send_prompt_and_drain` error branch, which only logs
    `"periodic dispatcher: prompt send failed; continuing"` and never calls
    `record_periodic_fire_dispatched` or any other audit-recording function on
    that path.
- AC-4 (limits stated as observed behavior, not contract): met in both files —
  `bob-setup` uses explicit "**Observed limits:**" labels for both commands;
  `bob-troubleshooting` states both "reflect observed pi behavior rather than a
  documented guarantee."
- AC-5 (placeholders, no internal IDs/version): met. Reran the task's own
  verification block from scratch in the worktree (not just trusting the
  reported "no output"):
  - `grep -n "pi_agent_model" ...` across all three files — all expected new
    lines present.
  - `grep -n "list-models\|auth check" ...` across both `SKILL.md` files — all
    expected new lines present.
  - The ID/version grep gate (`git diff -U0 "$(git merge-base dev-agent HEAD)"
    ... | grep '^+[^+]' | grep -nE "..."`) against the actual merge-base
    (`dca70ac`) on branch tip (`edab123`) — no output, grep exit 1, gate
    passes.
  - Additional sweep for real provider/model names
    (`claude|anthropic|openai|gpt-|opus|sonnet|gemini|llama`) over the added
    lines — no output; only `<provider>/<model-id>`/`<p>`/`<value>`/`<search>`
    placeholders appear.

**Stage 2 (code quality, applied to docs):** accurate against the real
implementation (see runtime-string checks above), clearly written, and
consistent with each file's existing structure and tone — the new
`bob-troubleshooting` section sits appropriately between the two existing
false-alarm sections and "When to stop and escalate" (correctly *not* filed as
a third false alarm, since the underlying config problem is real), and the new
`symptom-table.md` rows match the table's existing column format exactly. Diff
scope confirmed tight: `git diff --stat` against the merge-base touches only
the three files in "Files to Touch," no unrelated or drive-by changes.

No issues found. This task is complete.
