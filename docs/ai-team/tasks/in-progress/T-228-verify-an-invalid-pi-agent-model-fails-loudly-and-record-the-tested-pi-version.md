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

### Session 1 — 2026-09-29

**Part 1 — automated regression test (AC-1).** Added `periodic_dispatcher_skips_fire_and_appends_no_audit_record_when_warm_worker_already_exited` in `the-intern/service/crates/bob/src/serve.rs`, right after the existing `periodic_dispatcher_does_not_record_dispatched_event_when_prompt_send_fails` (which only covers an overflow worker, `warm_pool_size: 0`, and only asserts the absence of an `Event`-kind record). The new test uses `warm_pool_size: 1` and a fake worker script (`sh -c 'printf pid > file; echo "Error: Model \"x\" not found." >&2; exit 1'`). To avoid "sleep and hope," the test polls the pid file the worker writes, then polls `/proc/<pid>/stat`'s state field until it reads `Z` (zombie) or the entry disappears entirely — a naive `/proc/<pid>` existence check hangs forever on a zombie child, which is what led to the state-field approach. Only after confirming the worker is dead does the test enqueue a periodic event, start the dispatcher, and after a bounded wait assert `list_sessions()` is empty (no live session) and `audit_sink.records()` is empty with no kind filter (unlike the sibling test, which only filters for `Event`; a missing-cwd skip elsewhere in this file does append a `Report`-kind record, so asserting on the full record list is the point of this new test). Ran it 8x back-to-back with no flakes (~0.31s each), then `cargo test -p bob serve::tests` (64 passed, 1 pre-existing unrelated `#[ignore]`, 0 failed) and `cargo fmt --all -- --check` clean. Per CLAUDE.md's documented sandbox limitation, did not attempt the socket-based suites or the full `cargo test --workspace`. Committed as `a4f0151`.

**Part 2 — manual live check with real pi 0.87.1.** Backed up the pre-existing `.tmp/bob-dev/config/bob/config.toml` and `.tmp/bob-dev/state/bob/schedules.json` (this shared dev environment already had months of accumulated state — two live cron jobs and a 40k-line `audit.jsonl`). Temporarily swapped in a single controlled schedule entry to get a clean, fast, observable signal, then restored both files exactly at the end (verified byte-identical restoration). `pi --version` reports **0.87.1**; `pi --help` (stdin from `/dev/null`) confirms no short aliases for `--model`, `--models`, or `--provider` — no S-002 amendment needed.

- **(a) unset `pi_agent_model`** — the pre-existing dev config already had no `pi_agent_model` set. `WARN bob::serve: pi_agent_model is not set; pi will choose the model from its own saved settings...` confirmed on startup.
- **(b) non-existent model** — set `pi_agent_model = "definitely-not-a-real-model-t228"`. Warm worker immediately produced `WARN pi_agent_supervisor::process: pool worker stderr: Error: Model "definitely-not-a-real-model-t228" not found. Use --list-models to see available models. session=78961867-6ffd-492a-b79a-c1fe1c1d34e2` — tagged with the session id (AC-2). At the next minute boundary the scheduled job fired against the now-dead warm worker: `WARN bob::serve: periodic dispatcher: prompt send failed; continuing error=child process error: failed to write RPC command to child stdin (Broken pipe (os error 32))` — the exact code path Part 1's test encodes, now observed live. The marker file the job was supposed to write was never created, confirming the scheduled job did not run.
- **(c) valid model** — set `pi_agent_model = "openai-codex/gpt-5.3-codex-spark"` (confirmed `pi auth check --provider openai-codex` → ready). `ps`/`/proc` inspection needed a workaround: pi 0.87.1 rewrites its own process title to bare `pi` within single-digit milliseconds of starting, erasing `--model` from any snapshot taken after that window — worked around with a tight polling loop reading `/proc/<pid>/cmdline` racing the spawn. Captured concretely: pool worker — `node .../pi --mode rpc --model openai-codex/gpt-5.3-codex-spark --extension .../bob.ts`; `bob chat` — `node .../pi --model openai-codex/gpt-5.3-codex-spark --extension .../bob.ts`. Both spawn paths confirmed carrying `--model <value>` (AC-3).
- **(d) `--model` in `pi_agent_args`** — set `pi_agent_args = ["--mode", "rpc", "--model", "some-model"]` alongside a valid `pi_agent_model`. `bob serve` exited immediately (exit code 1) with `configuration error: Configuration: pi_agent_args must not select a model (--model found); set the model with pi_agent_model instead` — no process ever started.
- **(e) stderr volume during normal RPC operation** — with the valid model set, three separate scheduled fires completed full turns at `:45:00`, `:46:00`, `:47:00`. `grep -i stderr` over the entire service log across all three fires returned **zero matches** — pi wrote nothing to stderr during normal RPC operation. This answers CR-015's open stderr-volume question: routine RPC operation is silent, not noisy — no escalation for rate limiting or a lower log level warranted (AC-5). Side note: the test model never actually invoked the bash tool across the three fires despite an explicit directive prompt — a model/prompt-engineering quirk, not a bob defect (the scheduler's own audit trail shows `scheduler.periodic_fire_dispatched` Event records appended correctly each time); out of scope for T-228, no bug filed.

**Part 3 — README.** Added a bullet under "pi-agent Version Compatibility" recording pi 0.87.1 as the version verified against, scoped to what Part 2 checked (model pinning on all three spawn paths, the fail-fast on an unknown `--model` tagged with session id, and the config-load rejection of `--model`/`--models`/`--provider` in `pi_agent_args`) — the existing 0.80.3 record for extension/`resources_discover` skill-delivery checks is left untouched. Committed as `43ad764`.

**Cleanup.** No `bob serve`/`pi`/node process left running (verified via `ps`/`pgrep`). `.tmp/bob-dev/run/` sockets cleanly removed on graceful shutdown. Config/schedule files restored byte-for-byte. The test marker file was removed. `.tmp/bob-dev/state/bob/audit.jsonl` gained ~40-50 append-only lines from this session's test runs on top of its ~40,400 pre-existing lines — an append-only log by design, left in place rather than truncating other sessions' history.

**Remaining.** Nothing outstanding for T-228's acceptance criteria. Worth flagging for future `ps`-based automation against pi: this pi build rewrites its own process title to bare `pi` within milliseconds of starting, so post-hoc `ps`/`/proc` inspection will never show its real argv — only a startup-window race can catch it.

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

**Stage 1 — Acceptance criteria.** All five ACs are met, checked against the
actual diff (`git diff dev-agent...task/T-228-verify-invalid-pi-agent-model`,
touching only `the-intern/service/crates/bob/src/serve.rs` and `README.md`,
matching "Files to Touch" exactly).

- AC-1: `periodic_dispatcher_skips_fire_and_appends_no_audit_record_when_warm_worker_already_exited`
  genuinely exercises the warm-worker path, not overflow: `warm_pool_size: 1,
  max_processes: 1` means `SessionPool::new` pre-spawns the fake worker into
  `warm_workers`, and `acquire_session` always pops from `warm_workers` first
  (`pool.rs:203`) — the overflow branch (spawn-on-demand) is unreachable here
  since `total_process_count()` already equals `max_processes`. Confirmed via
  `PeriodicCwdResolution::ServiceDefault` → `acquire_default_session_or_warn`
  → `send_prompt_and_drain` fails (broken pipe against the dead worker) →
  `serve.rs`'s `Err` branch only warns and calls `kill_session`, with no
  `record_periodic_fire_*` call on that path — matches "no audit record of
  any kind." The test waits deterministically (pid-file write, then
  `/proc/<pid>/stat` state-field poll for `Z` or disappearance) rather than
  sleeping, correctly distinguishing zombie-but-exited from still-running.
  The final assertion checks the unfiltered `audit_sink.records()`, not just
  `Event`-kind, unlike the sibling `warm_pool_size: 0` overflow test it sits
  beside without duplicating. Ran the test 10/10 in an isolated worktree
  checkout of the exact committed code (`a4f0151`) — no flakes, ~0.31s each
  — and `cargo test -p bob serve::tests` reproduced the Developer's reported
  64 passed / 1 ignored / 0 failed. `cargo fmt --all -- --check` is clean.
- AC-2/AC-3/AC-5: the Work Log's Session 1, Part 2 entries are specific and
  independently corroborated against the real `pi` 0.87.1 on PATH and the
  code: `pi --help </dev/null` confirms no short aliases for `--model`,
  `--models`, or `--provider` (spot-checked directly — other flags like
  `--name`/`-n` do have short forms, these three do not); `pi --model
  <bogus> --print ... </dev/null` reproduces the exact error string quoted
  in the Work Log ("Error: Model \"...\" not found. Use --list-models to see
  available models."), which matches the `pool worker stderr: {line}
  session=%session_id` format at `process.rs:377` verbatim (AC-2). Both the
  pool-worker path (`build_pi_agent_supervisor_config` /
  `pi_agent_shared_args()`) and the interactive `bob chat` path
  (`build_interactive_session_config`) append `--model <value>` from the
  same shared-args helper when `pi_agent_model` is set, consistent with the
  "all three spawn paths" claim in AC-3. The config-load rejection message
  quoted for step (d) matches `config.rs:333` verbatim. The live dev
  environment's `.tmp/bob-dev/config/bob/config.toml` has no
  `pi_agent_model` set (matches "already had no pi_agent_model set") and
  `.tmp/bob-dev/state/bob/schedules.json` still has exactly the two
  pre-existing cron entries the Work Log names, confirming the claimed
  backup/restore. AC-5's "zero stderr matches across three fires" claim is
  plausible and consistent with the code (pi only writes to stderr on
  genuine errors, per the process.rs forwarder) and is properly treated as
  primary evidence in the Work Log rather than inferred.
- AC-4: `README.md` diff adds one new bullet under "pi-agent Version
  Compatibility" recording pi 0.87.1, explicitly scoped to what T-228
  checked (model pinning on all three spawn paths, fail-fast on an unknown
  model, and the `pi_agent_args` model-flag rejection), and explicitly
  disclaims re-running the `resources_discover`/skill-delivery checks. The
  existing 0.80.3 bullet immediately above is untouched (`git diff` shows
  only additions, 0 deletions in `README.md`).

No unspecified behavior or functionality was added; no files outside scope
were touched.

**Stage 2 — Code quality.** The new test is focused, uses a bounded
`Duration::from_secs(5)` timeout for both polling loops (no possibility of
an unbounded hang), and cleans up its own pid file, dispatcher, and
supervisor at the end — verified this cleanup fires reliably across 10
consecutive runs of the exact committed code. Naming
(`periodic_dispatcher_skips_fire_and_appends_no_audit_record_when_warm_worker_already_exited`)
is descriptive and consistent with sibling test names in this file. No dead
code, no unrelated refactoring, no secrets. The README addition is prose,
correctly scoped, and consistent with existing entries in that section's
style.

**Minor, non-blocking observation.** Found one stray 7-byte temp file
(`/tmp/bob-serve-t228-warm-worker-pid-<uuid>`) with a timestamp preceding
commit `a4f0151`, almost certainly left over from an earlier/interrupted
manual run during the Developer's own iterative testing (not reproduced in
10/10 clean runs of the final committed code from an isolated worktree, so
this is not a defect in the shipped test's cleanup logic). Removed it during
this review; no action needed from the Developer.

Both stages pass. Verdict: PASS.
