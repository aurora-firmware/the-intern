---
id: T-229
title: Document pi_agent_model in the user manual
status: in-progress
priority: medium
assigned-role: developer
created: '2026-09-29'
---

# Document pi_agent_model in the user manual

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

Document `pi_agent_model` in the user manual (CR-015 item 6 and Potential
Impact; S-002 v0.2 "Operator documentation"). Operators need to know the model
is now set in bob's config, not in pi's saved settings.

- `the-intern/docs/src/operator-guide/index.md`: a new section near "Working
  directory for pi-agent sessions" introducing the pi-agent process settings
  with one compact table mirroring S-002's (which keys reach pool workers and
  which reach `bob chat`), including `pi_agent_command` (default `pi`) and
  `pi_agent_args` (pool workers only, default `--mode rpc`, never applied to
  `bob chat`, model flags rejected), neither documented in the manual today.
  Then explain `pi_agent_model` — a top-level
  key passed verbatim as `--model` to every pi bob starts (pool workers and
  `bob chat`); why to set it (pi's saved choice changes whenever a model is
  picked in any session, and silently falls back when stale); unset →
  one startup warning; invalid → pi's error in the service log (or the
  `bob chat` terminal) and the job does not run until fixed; and how to
  confirm a value by hand with `pi --list-models <search>` and
  `pi auth check --provider <p> --json`, with their observed limits
  (fuzzy matching and exit 0 on no match; provider credentials only).
  Add a migration note under "Upgrading a running install": configs with
  `--model`, `--models`, or `--provider` in `pi_agent_args` now fail to load —
  move the value to `pi_agent_model`. Under "Observability for scheduled
  jobs", note that a fire whose worker never accepts the prompt appears in the
  service log only, not in `bob audit tail`.
- `the-intern/docs/src/quickstart/index.md` (~line 167): recommend setting
  `pi_agent_model` alongside `pi_agent_cwd`, and say that changing it needs a
  restart of `bob serve` (config is read and warm workers start at service
  start) — the nearby text (~line 172) says `bob policy reload` applies config
  edits, which is not true for this key.

Follow `docs/ai-team/docs/coding-guidelines-skills.md` §1–2: placeholder model
and provider names only, no internal task/bug/spec/ADR/issue IDs, no pi
version. Match the warning and error wording implemented in T-226/T-227.

## Acceptance Criteria

AC-1: The operator guide shall document the pi-agent process settings —
      a table of `pi_agent_command`, `pi_agent_args`, `pi_agent_model`, and
      the related keys by process kind — and `pi_agent_model`'s unset and
      invalid behaviour.
AC-2: The operator guide shall carry a migration note for configurations that
      put `--model`, `--models`, or `--provider` in `pi_agent_args`.
AC-3: The operator guide shall describe confirming a model with both pi
      commands, including their observed limits.
AC-4: The quickstart shall recommend setting `pi_agent_model` and state that
      changing it requires restarting `bob serve`.
AC-5: IF the added text names a model or provider THEN THE SYSTEM SHALL use a
      clearly placeholder value, and the text shall contain no internal IDs
      and no pi version.

## Dependencies

- `T-226` — final warning wording and spawn behaviour
- `T-227` — stderr forwarding the guide describes

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — new section, migration note,
  observability note
- `the-intern/docs/src/quickstart/index.md` — recommendation

## Verification

```bash
mdbook build the-intern/docs
grep -n "pi_agent_model" the-intern/docs/src/operator-guide/index.md the-intern/docs/src/quickstart/index.md
# only the lines this task adds must be free of internal IDs and versions
! git diff -U0 "$(git merge-base dev-agent HEAD)" -- the-intern/docs/src/operator-guide/index.md the-intern/docs/src/quickstart/index.md | grep '^+[^+]' | grep -nE "\b(T|B|S|CR)-[0-9]{3}\b|ADR-[0-9]{3}|#[0-9]{2,}|\b[0-9]+\.[0-9]+\.[0-9]+\b"
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
