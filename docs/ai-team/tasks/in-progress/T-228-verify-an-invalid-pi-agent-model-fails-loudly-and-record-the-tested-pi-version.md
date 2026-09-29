---
id: T-228
title: Verify an invalid pi_agent_model fails loudly and record the tested pi 
  version
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-29'
---

# Verify an invalid pi_agent_model fails loudly and record the tested pi version

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

Prove the #104 failure mode is now loud, end to end, and record the pi version
it was verified against (CR-015; S-009 v0.2 cron-tick dispatch step; S-002
v0.2 Component 6 "When a worker never accepts the prompt").

1. **Automated regression test** in `crates/bob/src/serve.rs` tests, for the
   case S-002 names: a **warm** worker (`warm_pool_size >= 1`) whose process
   has already exited before the fire (fake worker such as
   `sh -c 'echo "Error: Model \"x\" not found." >&2; exit 1'`). The fire is
   skipped with a warning, the session is killed (no live session remains),
   and **no audit record of any kind** is appended — unlike the
   `max_processes` skip. Extend or sit beside the existing
   `periodic_dispatcher_does_not_record_dispatched_event_when_prompt_send_fails`
   (~line 3195), which covers only an overflow worker (`warm_pool_size: 0`)
   and only asserts the absence of an `Event` record; do not duplicate it. Wait for the warm worker
   to have exited before firing (poll its status, or a bounded wait) so the
   test is not flaky.
2. **Manual live check with the real `pi`** (hard prerequisite: `pi` on PATH;
   if missing, stop and escalate — no substitutes). Use `scripts/run-bob-dev.sh`
   / `scripts/bob-dev.sh` with the dev config under `.tmp/bob-dev`: (a) unset
   `pi_agent_model` → the startup warning; (b) a non-existent model → pi's
   "not found" line in the service log tagged with a session, and a scheduled
   job that does not run; (c) a valid model from `pi --list-models` → spawned
   worker and `bob chat` command lines carry `--model` (e.g. via `ps`);
   (d) `--model` in `pi_agent_args` → config load error, and confirm with
   `pi --help` that the tested pi has no short aliases for `--model`,
   `--models`, or `--provider` (none at 0.87.1; if any appear, route to the
   Planner as an S-002 amendment); (e) with a valid model, let one scheduled
   fire complete and record whether and how much pi writes to stderr in normal
   RPC operation — this settles CR-015's open stderr-volume question. If
   routine output is noisy, stop and escalate: rate limiting or a lower log
   level would amend S-002. Record commands and observations in the Work Log.
   Run pi with stdin closed (`</dev/null`) for any direct `--print` check,
   or it waits on the inherited stdin.
3. **`README.md`** pi compatibility section: record the pi version actually
   tested in step 2 (`pi --version` reported 0.87.1 at breakdown time; pi
   self-updates, so record what it reports then) **only for what step 2
   checked** — model pinning on all three spawn paths, the fail-fast on an
   unknown `--model`, and the silent fallback from a stale saved model — and
   note that bob now pins the model via `pi_agent_model`. Keep the existing
   0.80.3 record for the extension and `resources_discover` skill-delivery
   checks, which this task does not re-run.

## Acceptance Criteria

AC-1: WHEN a periodic fire is handed a warm worker whose process already
      exited THE SYSTEM SHALL skip the fire with a warning, kill the session,
      and append no audit record of any kind (automated test).
AC-2: WHEN `bob serve` runs with `pi_agent_model` naming a model the real pi
      does not recognize THE SYSTEM SHALL show pi's "not found" error in the
      service log tagged with the worker's session (manual, recorded).
AC-3: WHILE `pi_agent_model` names a valid model THE SYSTEM SHALL start pool
      workers and `bob chat` sessions with `--model <value>` (manual,
      recorded).
AC-4: The system shall record in `README.md` the pi version these behaviours
      were verified against, scoped to what was checked, and that bob pins the
      model via `pi_agent_model`.
AC-5: WHEN one scheduled fire completes with a valid model THE SYSTEM SHALL
      have its pi stderr volume recorded in the Work Log (manual; escalate if
      routine output is noisy).

## Dependencies

- `T-226` — `--model` wiring and startup warning (and `serve.rs` edits)
- `T-227` — stderr forwarding, needed for AC-2

## Files to Touch

- `the-intern/service/crates/bob/src/serve.rs` — regression test only
- `README.md` — pi compatibility section

## Verification

```bash
cd the-intern/service && cargo test -p bob serve::tests && cargo test --workspace
# socket-based suites need a normal local shell (see CLAUDE.md); they may fail
# with "Operation not permitted" or hang in a restricted sandbox
# plus the manual live steps above, recorded in the Work Log
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
