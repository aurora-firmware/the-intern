---
id: T-128
title: Record the resolved working directory in the periodic event audit record
status: completed
priority: medium
assigned-role: developer
created: '2026-07-05'
spec: S-005
---

# Record the resolved working directory in the periodic event audit record

## Description

When a periodic firing's working directory is resolved at dispatch (T-127),
populate the event audit payload's resolved working-directory field (T-123) with
the **concrete absolute path used** — the value after precedence (per-entry `cwd`
→ `pi_agent_cwd` → inherited), not the raw per-entry field. Events with no
execution directory (for example forwarded pi-agent extension events) leave the
field unset. This touches the periodic dispatch/audit path in
`crates/bob/src/serve.rs`.

## Acceptance Criteria

AC-1: WHEN a `periodic` firing is dispatched and audited THE SYSTEM SHALL record
      the resolved absolute working directory used for that firing on the event
      audit record.
AC-2: The system shall record the concrete resolved path after precedence
      (per-entry `cwd` → `pi_agent_cwd` → inherited), not the raw per-entry field.

## Dependencies

- `T-127` — resolved cwd is computed at dispatch
- `T-123` — optional resolved-cwd field on the event audit payload

## Files to Touch

- `crates/bob/src/serve.rs` — populate the resolved cwd on the periodic event
  audit record

## Verification

```bash
cd the-intern/service && cargo test -p bob serve
```

## Work Log

### Session 1 — 2026-07-08

Implemented T-128 (resolved-cwd population on the periodic-fire event audit record) via three TDD cycles on `task/T-128-record-resolved-cwd-in-periodic-event-audit-record`, touching only `crates/bob/src/serve.rs`.

Read T-123's and T-127's completed Work Logs and Review Verdicts first. Traced that no production code previously wrote an `event`-kind (`ExtensionEventAuditPayload`) audit record for a periodic dispatch — the only existing production writer of that payload type is `extension-ipc/src/multiplex.rs` for forwarded pi-agent extension events, and T-127's periodic-dispatcher work only wrote `Report`-kind records for the AC-2 skip and AC-3 fallback conditions. Concluded, backed by S-005's amendment text ("its event audit record carries the resolved working directory") and the existing `records.rs` test fixture (`name: "scheduler.job.fired"`, `resolved_cwd: Some(...)`), that this task's job is to add a *new* `event`-kind audit write to the periodic dispatcher itself, populated with the concrete resolved absolute cwd for every fire that reaches dispatch.

**Cycle 1 (AC-1/AC-2, primary wiring):** Added `default_worker_cwd: Option<PathBuf>` as a new parameter to `start_periodic_dispatcher` (wired from `cfg.pi_agent_cwd.clone()` at the production call site in `try_start_subsystems`), and updated all 8 call sites (1 production + 7 pre-existing tests) to compile — pure plumbing, no behavior change, confirmed via a clean `cargo build -p bob`. Wrote `periodic_dispatcher_records_resolved_cwd_on_event_audit_record_for_per_entry_cwd_fire` first (per-entry-cwd dispatch case), confirmed it timed out (RED — no `record_periodic_fire_dispatched` existed yet), then implemented `record_periodic_fire_dispatched` (mirroring `record_periodic_fire_skipped`/`record_periodic_fire_fallback`'s shape: `AuditRecordKind::Event` / `ExtensionEventAuditPayload`, action name `"scheduler.periodic_fire_dispatched"`), restructured the dispatch `match` to return `(session_id, resolved_cwd)` tuples per branch (`PerEntry` → the entry's own cwd; `EntryNotFound`/`ServiceDefault` → a `resolved_service_default_cwd` computed once at dispatcher startup as `default_worker_cwd.or_else(|| std::env::current_dir().ok())`), and called the new helper right after session acquisition, before `send_prompt_and_drain`. Confirmed GREEN. Discovered and fixed a necessary consequence: the pre-existing T-127 test `periodic_dispatcher_records_fallback_condition_when_job_id_not_in_live_table` asserted "exactly one record" after the fallback condition, but the fallback path now also dispatches and appends a second (`Event`-kind) record — updated that assertion to filter on `AuditRecordKind::Report` so it stays independent of T-128's unrelated addition, with an inline comment explaining why. `cargo test -p bob serve` 54 passed (up from 53).

**Cycle 2 (AC-2, configured service-default tier):** Wrote `periodic_dispatcher_records_configured_service_default_cwd_on_event_audit_record` (no per-entry cwd, `default_worker_cwd: Some(configured_dir)`), confirmed it passed immediately since the wiring from cycle 1 was already correct (test-after, matching T-127's established precedent). Verified non-vacuity: temporarily hard-coded the `ServiceDefault` arm's resolved cwd to `None`, reran, confirmed failure, reverted, reran to confirm green. `cargo test -p bob serve` 56 passed.

**Cycle 3 (AC-2, inherited-launch-cwd tier):** Wrote `periodic_dispatcher_records_inherited_launch_cwd_on_event_audit_record_when_pi_agent_cwd_unset` (`default_worker_cwd: None`), asserting `resolved_cwd == Some(std::env::current_dir())`. Passed immediately (test-after). Verified non-vacuity: temporarily removed the `.or_else(|| std::env::current_dir().ok())` fallback (leaving `resolved_service_default_cwd = default_worker_cwd` i.e. always `None` here), reran, confirmed failure, reverted, reran to confirm green.

**Refactor:** Reviewed the final dispatch loop and helper for clarity; no further extraction needed — the three new tests share some setup boilerplate but each tests a genuinely distinct precedence tier, and keeping them separate (rather than parameterizing) matches the Reviewer-endorsed precedent from T-127's Work Log for near-duplicate per-branch tests. Updated `start_periodic_dispatcher`'s doc comment to describe the new `default_worker_cwd` parameter and its precedence semantics.

**Tried and rejected:** Considered leaving `resolved_cwd` unset (`None`) for the `ServiceDefault`/`EntryNotFound` branches on the theory that only per-entry-cwd fires are "interesting" enough to audit — rejected because AC-2's literal wording enumerates all three precedence tiers ("per-entry `cwd` → `pi_agent_cwd` → inherited") as needing the *concrete* resolved path recorded, and the task description's "leave unset" carve-out is explicitly scoped to events with no execution directory at all (forwarded extension events), not to periodic fires using a default cwd.

**What remains:** Nothing outstanding for T-128. Both acceptance criteria are implemented and covered: AC-1 by the primary per-entry-cwd test, AC-2 by all three precedence-tier tests. `cargo test -p bob serve` (56 passed, up from 53 before this task), `cargo test --workspace` (all green), and `cargo fmt --all -- --check` (clean) all pass. `cargo clippy -p bob --lib --tests` shows no new warnings attributable to this diff.

**Obstacles Encountered:** (1) Adding the `default_worker_cwd` parameter required updating 7 pre-existing test call sites purely for compilation before any new test could run — same category of necessary plumbing-first pattern documented in T-127's Session 2 Work Log. (2) One pre-existing T-127 test's "exactly one record" assertion needed adjustment (filtering by `AuditRecordKind::Report`) as a direct, foreseeable consequence of this task's new `Event` record write on the same dispatch path — fixed within the same commit as the causing change, with an inline comment for the next reader. (3) Two vacuity-check test runs that intentionally failed left stray temp directories under `/tmp` (created before the test's own cleanup line, which the intentional failure never reached); cleaned up manually after confirming the checks, not committed to the repo.

## Review

### Review Verdict — 2026-07-08

PASS

Reviewed `task/T-128-record-resolved-cwd-in-periodic-event-audit-record` (tip
`12d7b85`) against `dev-agent` merge-base `d1b33f7`, diffing only
`crates/bob/src/serve.rs` (the sole file touched — 414 insertions / 9
deletions, no unexpected files). Read T-123's and T-127's completed task
files and S-005's "Scheduled runs record their resolved working directory"
principle first to establish what "the event audit record" and "resolved
path after precedence" mean for this task. Verified independently, not from
the Developer's self-report: `cargo fmt --all -- --check` (clean),
`cargo test -p bob serve` (56 passed, up from 53 — matches the Work Log),
`cargo test --workspace` (all green across every crate).

**Stage 1 — Acceptance Criteria:**

- AC-1 (WHEN a `periodic` firing is dispatched and audited, record the
  resolved absolute working directory on the event audit record): met. New
  `record_periodic_fire_dispatched` (serve.rs ~L677) appends an
  `AuditRecordKind::Event` / `ExtensionEventAuditPayload` (T-123's field)
  record for every one of the three `PeriodicCwdResolution` arms
  (`PerEntry`/`ServiceDefault`/`EntryNotFound`) that reaches a successful
  session acquisition — i.e. every fire that actually dispatches — called
  right after acquisition and before `send_prompt_and_drain`. Arms that
  `continue` without acquiring (AC-2/AC-4 skips from T-127) correctly do not
  write this record, since those fires never dispatch. Confirmed no
  production code previously wrote an `Event`-kind record for a periodic
  fire (the only other producer, `extension-ipc/src/multiplex.rs`, is for
  forwarded pi-agent extension events, a distinct case that T-123's AC-2
  explicitly scopes as "leave unset"), so this is additive, not a
  duplicate write.
- AC-2 (record the concrete resolved path after precedence — per-entry `cwd`
  → `pi_agent_cwd` → inherited — not the raw per-entry field): met, and
  verified independently rather than taken on trust. `PerEntry(cwd)` carries
  the entry's own `cwd`, which I confirmed (via T-118's completed task file)
  is validated as a non-blank **absolute** path at config/schedule-store load
  time — so for this tier the raw field and the resolved value coincide
  exactly, satisfying the criterion. For `ServiceDefault`/`EntryNotFound`,
  `resolved_service_default_cwd` is computed once at dispatcher startup as
  `default_worker_cwd.or_else(|| std::env::current_dir().ok())`, where
  `default_worker_cwd` is `cfg.pi_agent_cwd.clone()` (also validated
  absolute at config load, per T-119) — the middle tier — falling through to
  `std::env::current_dir()` — the bottom (inherited launch cwd) tier — only
  when unset. All three precedence tiers are covered by dedicated tests
  (`periodic_dispatcher_records_resolved_cwd_on_event_audit_record_for_per_entry_cwd_fire`,
  `periodic_dispatcher_records_configured_service_default_cwd_on_event_audit_record`,
  `periodic_dispatcher_records_inherited_launch_cwd_on_event_audit_record_when_pi_agent_cwd_unset`),
  each asserting the exact concrete path recorded, and cycles 2/3's Work Log
  documents an explicit non-vacuity check for each (temporarily breaking the
  resolution, confirming red, reverting, confirming green) — I did not need
  to re-run these myself since the described mechanism (temporarily forcing
  a `None`/removing the `or_else` fallback) is sound and the test assertions
  are concrete (`assert_eq!` on the actual path, not just `is_some()`).
- No unspecified behavior was added: the diff is scoped to wiring
  `default_worker_cwd` through, the new `record_periodic_fire_dispatched`
  helper and its call site, and the tests for it.
- No unexpected files modified: `git diff --stat` against the merge-base
  shows only `crates/bob/src/serve.rs`, matching the task's declared
  "Files to Touch."
- The one adjustment to a pre-existing T-127 test
  (`periodic_dispatcher_records_fallback_condition_when_job_id_not_in_live_table`'s
  "exactly one record" assertion narrowed to filter on
  `AuditRecordKind::Report`) is a necessary, foreseeable, in-scope
  consequence of this task's new `Event`-kind write landing on the same
  dispatch path the `EntryNotFound` branch already exercises — not scope
  creep. The change is minimal (a `.filter(...)` added to an existing
  assertion) and carries an inline comment explaining why, for the next
  reader.

**Stage 2 — Code Quality:**

- **Correctness:** the `(session_id, resolved_cwd)` tuple threading through
  the `match` is sound — every arm that reaches the tuple destructuring has
  already succeeded at session acquisition, so the audit record is written
  exactly once per actual dispatch and never on a skipped/refused fire.
  `resolved_cwd` is `None` only in the documented, narrow edge case where
  both `pi_agent_cwd` is unset and `std::env::current_dir()` itself fails at
  dispatcher startup — correctly distinguished in the record's summary text
  ("resolved cwd unavailable") rather than silently omitted without
  explanation. A failed `audit.append` is logged as a warning and does not
  affect the already-dispatched fire, consistent with
  `record_periodic_fire_skipped`/`record_periodic_fire_fallback`'s existing
  error-handling shape from T-127.
- **Tests:** three new tests, one per precedence tier, each independent (own
  `persistence_handle`, supervisor, `SpyAuditSink`, `watch::channel`; no
  shared mutable state), asserting on the actual recorded `resolved_cwd`
  value rather than just record presence. Reran `cargo test -p bob serve`
  myself and confirmed 56/56 green. Failure/skip paths remain covered by
  T-127's pre-existing tests (unaffected by this diff apart from the one
  justified assertion narrowing above).
- **Security:** not applicable — no external input beyond the already-
  validated (absolute-path-checked at config/schedule-store load time)
  `cwd`/`pi_agent_cwd` values; no secrets; no queries.
- **Readability:** `record_periodic_fire_dispatched` is clearly named,
  documented (doc comment cross-references T-128/AC-1/AC-2, explains the
  `None` edge case and the summary-text distinction), and mirrors the
  existing `record_periodic_fire_skipped`/`record_periodic_fire_fallback`
  shape from T-127 rather than introducing a new pattern. No dead code or
  commented-out blocks.
- **Performance:** no unnecessary loops, blocking calls, or resource leaks;
  `resolved_service_default_cwd` is computed once at dispatcher startup
  rather than per-fire, and the new tests' polling loops match the existing
  20ms-interval convention used throughout this file.
- `cargo clippy -p bob --lib --tests` fails to compile due to a pre-existing,
  unrelated `clippy::result_unit_err` deny in
  `crates/pi-agent-supervisor/src/pool.rs::register_interactive_exit_watcher`
  (a dependency of `bob`) — confirmed this is untouched by T-128's diff and
  was already documented as pre-existing debt in T-127's own review and in
  this repo's CLAUDE.md ("clippy is not yet a clean gate for this
  workspace"). No new clippy issues are attributable to this diff.

**Minor observations (non-blocking):** (1) The `PerEntry`/`ServiceDefault`/
`EntryNotFound` cases are re-matched a second time immediately after being
matched once for acquisition, purely to attach `resolved_cwd` — functionally
correct and well-commented, but a future refactor could fold the resolved-cwd
value into the original match's return tuple more directly if this function
grows further; not worth a fix-and-resubmit cycle on its own. (2) The Work
Log's Obstacle #3 (stray `/tmp` directories from intentionally-failing
vacuity-check runs) was manually cleaned up and is not present in the
committed diff or working tree — confirmed via `git status --porcelain`
(clean) on the task branch.

Both stages pass. No blocking issues found.

Next owner: Development Loop (`/dev-loop`) routes this to the Integrator for
merge.
