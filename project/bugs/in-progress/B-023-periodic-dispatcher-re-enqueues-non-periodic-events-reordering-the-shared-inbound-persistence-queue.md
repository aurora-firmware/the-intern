---
id: B-023
title: periodic dispatcher re-enqueues non-periodic events, reordering the 
  shared inbound persistence queue
severity: high
status: in-progress
created: '2026-07-17'
---

# periodic dispatcher re-enqueues non-periodic events, reordering the shared inbound persistence queue

## Summary

`start_periodic_dispatcher` in `the-intern/service/crates/bob/src/serve.rs`
became a competing consumer of the shared inbound persistence queue when
per-entry cwd resolution (T-118–T-130) landed. It dequeues the head item
unconditionally; when that item is not `DeliveryKind::Periodic` it pushes the
event back onto the queue with a plain `enqueue`. Because the persistence
queue is FIFO, re-enqueueing pulls every non-periodic item from the head and
re-appends it at the tail, turning the queue into a rotating buffer: sync/async
work gets reordered on every dispatcher tick, and under sustained non-periodic
traffic a periodic item sitting behind it can be pushed back indefinitely,
arbitrarily delaying a scheduled fire. This was flagged in the local PR #38
review (`pr-38-review.md`) and confirmed still present by direct code
inspection against the current `dev-agent` tip — it was not addressed by
commit `82302c2 fix(service): address pr review findings`, which touched
unrelated audit-ordering and cwd-validation code in the same file.

## Reproduction Status

Status: confirmed (static — deterministic behavior of the dequeue/re-enqueue
logic, further confirmed by an existing test that asserts the re-enqueue as
current behavior rather than treating it as a bug).

## Evidence

- `the-intern/service/crates/bob/src/serve.rs:826` (current `dev-agent` tip,
  `57f6506`):
  ```rust
  Ok(Some((event, _job_id))) if event.kind != DeliveryKind::Periodic => {
      // ...
      if let Err(e) = persistence.enqueue(event).await {
  ```
  The periodic dispatcher's poll loop dequeues the head of the shared queue
  via `persistence.dequeue_next_with_job_id()` (or equivalent), and for any
  non-`Periodic` event it calls `persistence.enqueue(event)` to push it back
  — at the tail, not the head, since the persistence queue has no
  head-reinsert operation.
- Existing test `dispatcher_re_enqueues_non_periodic_event_via_plain_enqueue`
  (same file, `mod tests`) exercises and asserts exactly this re-enqueue
  behavior — i.e. the current test suite documents the reordering as
  intentional rather than covering the fix.
- `pr-38-review.md` (local, uncommitted PR review report) finding: "\[warning\]
  Periodic dispatcher reorders the shared inbound queue and can starve
  scheduled fires behind steady sync/async traffic —
  `the-intern/service/crates/bob/src/serve.rs:826`".

## Reproduction Steps

1. Start `bob serve` with at least one periodic schedule entry and an active
   stream of non-periodic (sync/async) inbound events.
2. Enqueue several non-periodic events ahead of a periodic event's natural
   fire window.
3. Observe (via unit test or live queue inspection) that each non-periodic
   event dequeued by the periodic dispatcher is immediately re-appended to
   the tail of the same queue, changing its relative order versus any
   consumer that expects FIFO delivery, and that sustained non-periodic
   traffic can keep re-appending ahead of a periodic item, delaying it
   indefinitely.

## Expected Behavior

The periodic dispatcher should be able to identify and dispatch only
periodic work without mutating the position of unrelated (sync/async) events
in the shared queue — non-periodic events should retain their original FIFO
order and periodic fires should not be arbitrarily delayed by unrelated
traffic.

## Actual Behavior

The periodic dispatcher dequeues every head item regardless of kind and
re-enqueues non-periodic ones at the tail, reordering the queue and risking
unbounded delay of periodic dispatch under sustained non-periodic load.

## Environment

- OS / platform: Linux (not platform-specific — pure queue/control-flow
  logic).
- Language / runtime version: Rust workspace at `the-intern/service`.
- Relevant dependencies: the in-process persistence/inbound-event queue
  (`persistence::dequeue_next_with_job_id` / `persistence::enqueue`) shared
  between the periodic dispatcher and the sync/async connection-handling
  path.
- Branch / commit: `dev-agent` at `57f6506d60581da4c76a18d9a6aa84d6bdf59b4d`
  (PR #38 head); introduced by the per-entry cwd resolution work
  (T-118–T-130) that made the periodic dispatcher a queue consumer.

## Related

- PR: `#38` (`Promote dev-agent → main: scheduler JSON-state persistence,
  reliability fixes, per-entry cwd resolution`).
- Local review report: `pr-38-review.md` (uncommitted, working tree only) —
  originating finding.
- Tasks: T-118–T-130 (per-entry cwd resolution work that made the periodic
  dispatcher share the inbound queue).

## Suspected Area

`the-intern/service/crates/bob/src/serve.rs::start_periodic_dispatcher` and
the persistence-queue API it uses (`crates/bob/src/persistence.rs` or
equivalent) — the dispatcher needs either a way to peek/dequeue only
periodic-kind entries without disturbing others, or a separate queue for
periodic work.

## Fix Verification

```bash
# A regression test should assert that non-periodic events dequeued ahead of
# a periodic event retain their original relative order (e.g. are not moved
# to the tail behind later-arriving events), and/or that a periodic event is
# not starved by sustained non-periodic traffic:
cd the-intern/service && cargo test -p bob serve::tests
cd the-intern/service && cargo test --workspace
```

## Diagnosis Log

### Diagnosis 1 — 2026-07-17

Reproduction status: confirmed (deterministic, reproduced twice via temporary diagnostic tests
against the real `persistence::Handle`/`InboundQueue`, run 3x each with no flakiness; artifacts
removed afterward, `serve.rs` restored to the `dev-agent` tip).

Evidence captured:
- Read `start_periodic_dispatcher` (`the-intern/service/crates/bob/src/serve.rs:780-981`, current
  tip). Confirmed the exact defect location at lines 826-836:
  `Ok(Some((event, _job_id))) if event.kind != DeliveryKind::Periodic =>` dequeues the FIFO head
  unconditionally, then on any non-`Periodic` kind calls `persistence.enqueue(event)` (plain,
  tail-append) before backing off `PERIODIC_DISPATCH_POLL_INTERVAL` (100ms, `serve.rs:18`).
- Traced the `PersistenceStore` trait (`crates/bob-core/src/ports.rs:57-95`), its
  `persistence::Handle` implementation (`crates/persistence/src/lib.rs`), and the underlying
  `InboundQueue` (`crates/persistence/src/inbound.rs:18-74`, a `VecDeque`-backed ring buffer).
  Confirmed: only `enqueue`/`enqueue_with_job_id` (push-back) and
  `dequeue_next`/`dequeue_next_with_job_id` (pop-front) exist — no peek, scan, or periodic-only
  lookup API exists anywhere in the workspace (`grep` for `peek`/`Peek`/`dequeue_periodic`/`scan(`
  across `crates/` returned no hits).
- Confirmed the queue is genuinely shared/contended: sync/async events reach it via
  `requests_handler::run_preflight`'s `store.enqueue(event)` (`crates/requests-handler/src/handler.rs:40`),
  and periodic events reach it via `admit_periodic_event`'s `enqueue_with_job_id`
  (`serve.rs:134-149`), both wired from the same closure in `try_start_subsystems` (`serve.rs:217-251`).
  `start_periodic_dispatcher` is currently the only production consumer that drains this queue at all.
- Confirmed the existing test `dispatcher_re_enqueues_non_periodic_event_via_plain_enqueue`
  (`serve.rs:2339`) only asserts that a plain `enqueue` call happens (via a single-item
  `SpyPersistence` double) — it does not exercise the real multi-item FIFO queue, so it documents
  but does not prove the reordering effect end-to-end.
- Added two temporary diagnostic tests (reverted afterward, confirmed via empty `git diff HEAD`):
  - `b023_diagnostic_reordering_via_real_persistence_queue`: seeded the real `persistence::Handle`
    with `[sync-1, sync-2, periodic-1]`, replayed the exact production sequence
    (`dequeue_next_with_job_id` → `enqueue`) for the head item, and asserted the resulting order.
    Result: PASS — final order was `[sync-2, periodic-1, sync-1]`, proving `sync-1` (originally at
    the head) is moved behind both `sync-2` and `periodic-1`.
  - `b023_diagnostic_periodic_delay_scales_with_non_periodic_backlog`: ran the real
    `start_periodic_dispatcher` with 3 non-periodic events queued ahead of 1 periodic event and a
    supervisor whose `acquire_session` always fails. Result: PASS across 3 consecutive runs — the
    periodic item was dequeued 4th, ~303-304ms after start (3 × the 100ms
    `PERIODIC_DISPATCH_POLL_INTERVAL`, one full back-off per non-periodic item ahead of it).

Isolated fault: `start_periodic_dispatcher`'s non-periodic branch,
`the-intern/service/crates/bob/src/serve.rs:826-836` — it destructively dequeues the FIFO head via
`persistence.dequeue_next_with_job_id()` regardless of `DeliveryKind`, and re-inserts non-`Periodic`
items at the tail via the plain `enqueue`, because the `PersistenceStore` API it depends on offers
no non-destructive peek and no periodic-only lookup — a destructive pop is the only way to inspect
an item's `kind`.

Root cause: the periodic dispatcher was made a second, competing consumer of the shared inbound
`persistence` queue by the per-entry cwd resolution work (T-118–T-130), but the
`PersistenceStore`/`InboundQueue` API was never extended with a way to identify or dispatch only
`Periodic`-kind entries without disturbing the rest of the queue. Given the FIFO-only API,
"put back anything I didn't want" is implemented as "pop, then push to tail" — which necessarily
reorders every non-periodic item behind whatever was originally after it (confirmed by diagnostic
test 1), and couples periodic dispatch latency to the depth of non-periodic backlog ahead of the
periodic item, at a rate of one `PERIODIC_DISPATCH_POLL_INTERVAL` per non-periodic item (confirmed
by diagnostic test 2). Refinement of the bug report's "indefinitely"/"no bound" framing: per FIFO
semantics an already-enqueued periodic item's position can only monotonically decrease over time
(new arrivals always land at the tail, strictly behind it), so the delay is bounded by the
non-periodic backlog depth at the periodic item's enqueue time (itself capped by
`persistence_inbound_capacity`, default 1024), not literal infinite growth — but it is uncapped
relative to the periodic schedule's own fire interval and scales with unrelated traffic volume.
This refinement does not change severity or the fix approach.

Planned fix: give the periodic dispatcher a way to reach `Periodic` work without perturbing the
position of other queued items. Preferred approach: add a dedicated periodic queue/channel (e.g. a
second `VecDeque` in the persistence actor, or a separate lightweight channel) that
`admit_periodic_event` enqueues into directly (it already knows the event is `Periodic` at enqueue
time), and have `start_periodic_dispatcher` poll/consume only from that dedicated queue. This
removes the periodic dispatcher as a consumer of the shared inbound queue entirely, so non-periodic
FIFO order is never touched, and periodic dispatch latency is decoupled from non-periodic backlog.
(Alternative considered and rejected as the primary approach: a non-destructive periodic-only
peek/scan on the existing shared queue — still requires either an O(n) scan on every tick or new
bookkeeping to remove an arbitrary non-head element without shifting others.) Concrete API and
call-site changes are for the TDD implementation cycle to design against the fix-verification tests
it writes first.

Planned verification:
```bash
cd the-intern/service && cargo test -p bob serve::tests
cd the-intern/service && cargo test --workspace
```
Plus new regression test(s), written first per TDD, asserting: (a) non-periodic events dequeued
by/around the periodic dispatcher retain their original relative FIFO order, and (b) a periodic
item's dispatch latency is bounded by the periodic dispatcher's own poll cadence, independent of
concurrent non-periodic queue depth. The existing
`dispatcher_re_enqueues_non_periodic_event_via_plain_enqueue` test documents the bug as prior
behavior and must be updated or replaced by the fix cycle, since its assertion is no longer the
desired contract.

## Work Log

### Session 1 — 2026-07-17

Implemented the B-023 fix using the Diagnosis Log's fix contract as the implementation target: gave the periodic dispatcher a dedicated periodic queue, entirely decoupled from the shared inbound persistence queue that non-periodic (sync/async) traffic uses.

**What was done.** Extended `PersistenceStore` (`bob-core/src/ports.rs`) with two new methods, `enqueue_periodic_with_job_id` and `dequeue_next_periodic_with_job_id`, each with a safe default (delegate to the general-queue equivalents / report empty) so existing implementors keep compiling. In `persistence/src/lib.rs`, backed these with a second `InboundQueue` instance (`Actor.periodic`) guarded by the same actor and command-channel model as the existing `inbound` queue, using the same `persistence_inbound_capacity` config value — no new config surface was introduced. In `bob/src/serve.rs`, `admit_periodic_event` now calls `enqueue_periodic_with_job_id` instead of `enqueue_with_job_id`, and `start_periodic_dispatcher`'s poll loop now calls `dequeue_next_periodic_with_job_id` instead of `dequeue_next_with_job_id`; the entire non-periodic branch (the destructive dequeue-and-requeue at `serve.rs:826-836` in the pre-fix code) was deleted, since every item the dispatcher now sees is Periodic by construction (the only producer of the periodic queue is `admit_periodic_event`, which is only invoked for `DeliveryKind::Periodic` events).

Per the tdd skill, wrote the required regression tests first: (a) `non_periodic_events_retain_fifo_order_while_periodic_dispatcher_runs_concurrently` — seeds the general queue with 7 Sync events, admits a real periodic event via `admit_periodic_event`, runs the real dispatcher concurrently for several poll cycles, then drains the general queue and asserts exact original order; and (b) `periodic_dispatch_latency_is_independent_of_non_periodic_backlog_depth` — seeds 10 unrelated Sync events ahead of one periodic admission, then asserts the periodic dispatch (observed via a real worker script writing a marker file) completes within `PERIODIC_DISPATCH_POLL_INTERVAL * 5` (500ms), well under the ~1s the pre-fix code took. Both were designed to compile and fail against the *current* (pre-fix) code using only pre-existing `PersistenceStore` API, confirmed failing (latency test measured `1.02s`; FIFO test showed the periodic item leaking into the rotated general-queue order), then confirmed passing after the fix.

Also replaced `dispatcher_re_enqueues_non_periodic_event_via_plain_enqueue` (which asserted the bug's re-enqueue behavior as the desired contract) with `dispatcher_never_calls_plain_enqueue_on_the_shared_queue`, and renamed/rewrote `periodic_dispatcher_calls_dequeue_next_with_job_id` → `periodic_dispatcher_calls_dequeue_next_periodic_with_job_id` to assert the dispatcher exclusively uses the dedicated periodic-queue methods and never touches the general queue's `enqueue`/`enqueue_with_job_id`/`dequeue_next`/`dequeue_next_with_job_id`. `SpyPersistence` was updated so its `pending` seed is served only via the new periodic dequeue method (general-queue methods now just track calls and return empty). Updated the two `admit_periodic_event_enqueues_with_*` tests and ~13 other test call sites (T-127/T-128 cwd-resolution tests, B-017 regression tests, error-resilience test) that previously seeded periodic events through the general queue's `enqueue`/`enqueue_with_job_id`, switching them to `enqueue_periodic_with_job_id` — otherwise the fixed dispatcher would never see them.

Added unit-level coverage for the new persistence-crate building block itself (round-trip through the periodic queue, cross-queue isolation in both directions, independent FIFO/capacity) and for the new `PersistenceStore` trait defaults in `bob-core`, following the existing AC-numbered test conventions in each file.

**What was tried and rejected.** Considered making the shared `InboundQueue.enqueue`/`enqueue_with_job_id` transparently route `Periodic`-kind events into a separate internal bucket based on `event.kind`, keeping the trait surface unchanged. Rejected this because it bakes `DeliveryKind` business semantics into the low-level generic persistence queue (poor layering) and would have broken existing generic FIFO tests in `persistence/src/lib.rs` that use `DeliveryKind::Periodic` sample events incidentally, not because they're testing periodic-specific behavior. Also considered bypassing `PersistenceStore` entirely for periodic events via a private `mpsc` channel wired directly between `admit_periodic_event`'s call site and `start_periodic_dispatcher` in `serve.rs` only (no `bob-core`/`persistence` changes). Rejected this because roughly a dozen existing tests seed periodic events directly onto `runtime._persistence` / a standalone `persistence::Handle` to drive `start_periodic_dispatcher` in isolation from `admit_periodic_event`; an `mpsc`-only design with no `PersistenceStore`-level periodic API would have made those seed points structurally unreachable from tests. The chosen design (explicit new trait methods on `PersistenceStore`, backed by a second `InboundQueue` in the same actor) keeps `start_periodic_dispatcher`'s and `admit_periodic_event`'s exposed signatures unchanged, preserves the existing actor/concurrency model, and requires only mechanical method-name updates at test seed sites.

**What remains.** Nothing outstanding for this bug — all planned verification commands pass cleanly (`cargo test -p bob serve::tests`, `cargo test --workspace`, `cargo fmt --all -- --check`), and the `serve::tests::periodic` subset was run 5 times to rule out timing flakiness in the new latency/FIFO-order tests. Full-workspace `cargo clippy` was not run to a clean state because `pi-agent-supervisor` has a pre-existing, unrelated clippy error (CLAUDE.md notes clippy isn't yet a clean gate for this workspace); a targeted `cargo clippy -p persistence -p bob-core --tests` showed no new errors, only pre-existing pedantic warnings.

**Obstacles Encountered:** The fix requires new `PersistenceStore` trait methods that don't exist pre-fix, which made a literal "regression tests use the new API" ordering impossible for TDD's red step — resolved by designing regression tests around pre-existing API surface so they compile and fail meaningfully pre-fix, then implementing the new trait methods in the green phase. The fix's correct scope turned out broader than `serve.rs` alone (~13 existing tests needed their periodic-event seed calls switched to the new method), anticipated by the Diagnosis Log's "Suspected Area" note.

### Session 2 — 2026-07-17

Addressed the Reviewer's FAIL finding: `the-intern/service/crates/bob/tests/scheduler_execution_e2e.rs`
had not been updated as part of the B-023 fix, even though its `start_inline_dispatcher` helper and
its doc comments explicitly claimed behavioral parity with the (now-fixed) production `serve.rs`
dispatcher/admission functions.

In `start_inline_dispatcher`, replaced the `persistence.dequeue_next_with_job_id()` call with
`persistence.dequeue_next_periodic_with_job_id()` and deleted the destructive non-periodic branch
(`Ok(Some((event, _job_id))) if event.kind != DeliveryKind::Periodic => { persistence.enqueue(event).await; ... }`)
— the exact same branch removed from `start_periodic_dispatcher` in `serve.rs` during Session 1. All
4 admission call sites were switched from `enqueue_with_job_id` to `enqueue_periodic_with_job_id`,
matching the production `admit_periodic_event`. Updated the doc comments the review flagged to
describe the dedicated-periodic-queue architecture instead of asserting blanket "identical"/
"replicates" behavioral parity, and added short B-023 comments at each call site noting the routing
is now onto the dedicated periodic queue, not the shared one.

Verification: `cargo build -p bob --tests` clean, 0 warnings. `cargo test -p bob --test
scheduler_execution_e2e` — 4 passed, run 6 times total with no flakiness. `cargo test --workspace` —
all suites green, 0 failed, re-run twice with identical results. `cargo fmt --all -- --check` exits
0. `git diff --stat` confirms only the one intended file changed (30 insertions, 20 deletions) —
no production code touched this session.

**Obstacles Encountered:** None blocking. The change was mechanical and matched the review's
required-change description exactly.

## Review

### Review Verdict — 2026-07-17

FAIL

**Stage 1 — Diagnosis/fix evidence chain: PASS.** The Diagnosis Log (Diagnosis 1) is evidence-backed, not speculative: it cites concrete line numbers for the isolated fault (`serve.rs:826-836`), traces the full `PersistenceStore`/`InboundQueue` API to confirm no peek/scan/periodic-only lookup exists, and reports two temporary diagnostic tests run against the real `persistence::Handle`/`start_periodic_dispatcher` (reordering: `[sync-1, sync-2, periodic-1]` → `[sync-2, periodic-1, sync-1]`; latency: periodic item dequeued 4th, ~303-304ms, 3× the 100ms poll interval) with results reproduced 3× each, then reverted (confirmed via empty `git diff`). Root cause correctly ties the destructive pop-then-tail-push pattern to the FIFO-only API. The "indefinitely" framing in the original bug report is correctly refined (bounded by backlog depth, not literal infinity) without changing severity or fix approach — a legitimate, well-reasoned refinement.

**Stage 1 — Fix addresses the isolated fault: PASS (production code).** Confirmed by direct inspection of `bug/B-023-periodic-dispatcher-queue-reordering` (commits `b8188e0`, `5d70b0d`):
- `start_periodic_dispatcher` (`the-intern/service/crates/bob/src/serve.rs`) no longer calls any shared/general-queue method anywhere in its poll loop — only `dequeue_next_periodic_with_job_id`. The destructive `Ok(Some((event, _job_id))) if event.kind != DeliveryKind::Periodic` branch and its `persistence.enqueue(event)` re-enqueue are deleted entirely (verified: no `enqueue`/`enqueue_with_job_id`/`dequeue_next`/`dequeue_next_with_job_id` call sites remain in the function).
- `admit_periodic_event` now calls `enqueue_periodic_with_job_id` exclusively.
- The dedicated periodic queue is genuinely isolated, not a shared-state wrapper: `Actor` (`crates/persistence/src/lib.rs`) holds two independent `InboundQueue` instances (`inbound` and `periodic`), each its own `VecDeque`; `Command::EnqueuePeriodic`/`DequeueNextPeriodic` operate only on `self.periodic`, `Command::Enqueue`/`DequeueNext` only on `self.inbound`. Cross-isolation is asserted by dedicated tests (`periodic_queue_events_are_not_visible_via_the_general_dequeue`, `general_queue_events_are_not_visible_via_the_periodic_dequeue`, `periodic_and_general_queues_have_independent_fifo_order_and_capacity`), all passing.
- Layering sanity check: `InboundQueue` (`crates/persistence/src/inbound.rs`) remains fully generic — no `DeliveryKind` awareness at all. The periodic/general distinction lives at the `Command`/`PersistenceStore`-method level (application routing), not baked into the low-level queue type. This does not reproduce the layering problem the Work Log says was rejected (routing by `event.kind` inside `InboundQueue.enqueue`).
- I independently reverted `admit_periodic_event`/`start_periodic_dispatcher` to their pre-fix bodies in a scratch working-tree edit (discarded afterward) and re-ran the two new regression tests: both failed against the reinstated buggy code — `non_periodic_events_retain_fifo_order_while_periodic_dispatcher_runs_concurrently` showed the exact rotation pattern (`sync-4,5,6` moved ahead of `sync-0..3`), and `periodic_dispatch_latency_is_independent_of_non_periodic_backlog_depth` measured ~1.015s against the 500ms bound (matching the Work Log's claimed pre-fix "1.02s" almost exactly). This confirms both regression tests are genuine, not tautological, and genuinely exercise the real production functions. The old `dispatcher_re_enqueues_non_periodic_event_via_plain_enqueue` test (which asserted the bug as intended behavior) is confirmed gone — only referenced in a comment explaining its replacement by `dispatcher_never_calls_plain_enqueue_on_the_shared_queue`.
- The ~13 updated test call sites (`enqueue`/`enqueue_with_job_id` → `enqueue_periodic_with_job_id`) in `serve.rs` are legitimate: each seeds a `DeliveryKind::Periodic` event that the fixed dispatcher must now see via the dedicated queue; without the switch these tests would hang/timeout, not silently weaken. `SpyPersistence`'s general-queue methods now correctly return `Ok(None)`/track-only, matching the "dispatcher must never touch the general queue" contract the new/renamed tests assert.
- No unrelated production files touched: `git diff --name-only` shows only `bob-core/src/ports.rs`, `bob/src/serve.rs`, `persistence/src/lib.rs`. The general queue's existing `Command::Enqueue`/`Command::DequeueNext` handling and the `PersistenceStore` trait's pre-existing methods are unchanged (diff is purely additive there); `requests_handler::run_preflight`'s use of the general queue for non-periodic traffic is untouched.
- Re-ran all three Fix Verification / Work Log commands on the bug branch myself: `cargo test -p bob serve::tests` → 56 passed, 0 failed. `cargo test --workspace` → all suites green, 0 failed anywhere. `cargo fmt --all -- --check` → exit 0. Also re-ran `serve::tests::periodic` 3× with no flakiness, and a targeted `cargo clippy -p persistence -p bob-core --tests` → only pre-existing pedantic warnings, no errors, consistent with the Work Log's claim.

**Stage 2 — Code quality gap found (FAIL reason).**

- **File and location**: `the-intern/service/crates/bob/tests/scheduler_execution_e2e.rs` — `start_inline_dispatcher` (lines 174-265, specifically the `dequeue_next_with_job_id` call at line 187 and the non-`Periodic` re-enqueue branch at lines 200-207 calling `persistence.enqueue(event)`), and its 4 call sites' periodic-admission closures (lines ~396, ~619, ~781, ~978) which still call `store.enqueue_with_job_id(event, context.context_id.clone())`.
- **What is wrong**: This integration-test file is a hand-maintained duplicate of `admit_periodic_event`/`start_periodic_dispatcher`, built specifically because those functions are private to the `bob` crate. Its own doc comments explicitly claim behavioral parity with production: "Replicates the production closure from `serve.rs`" (line 367) and "This inline version is identical in behaviour [to `serve::start_periodic_dispatcher`]" (line 166). That claim is now false. All 4 of this file's tests (`schedule_entry_from_json_store_is_delivered_when_admitted_users_is_empty`, `scheduled_entry_with_per_entry_cwd_runs_pi_session_in_that_directory_honouring_precedence`, `scheduled_entry_with_missing_per_entry_cwd_at_fire_time_skips_the_fire_and_leaves_the_entry_present`, `scheduled_entry_firing_records_the_resolved_cwd_on_the_audit_record`) still route periodic admission through the general/shared inbound queue and still contain the exact destructive dequeue-and-requeue-via-plain-`enqueue` pattern for non-`Periodic` events that this bug fix deletes from real production code. They pass (verified: `cargo test -p bob --test scheduler_execution_e2e` → 4 passed) only because they are internally self-consistent with the pre-fix pattern — they no longer exercise, or provide any regression protection for, the actual fixed dispatch pipeline. This is the same class of gap the Work Log says it hunted down "~13" other times (test call sites that "previously seeded periodic events through the general queue's `enqueue`/`enqueue_with_job_id`... otherwise the fixed dispatcher would never see them") — this file was missed because it lives in a separate integration-test crate directory (`crates/bob/tests/`) rather than inside `serve.rs`'s `mod tests`.
- **What should change**: Update `start_inline_dispatcher` to call `dequeue_next_periodic_with_job_id` and remove the non-periodic re-enqueue branch, mirroring the real (now-fixed) `start_periodic_dispatcher`. Update all 4 admission closures to call `enqueue_periodic_with_job_id` instead of `enqueue_with_job_id`. Refresh the doc comments (lines 163-173, 279-280, 365-369) that assert byte-for-byte behavioral parity with the production functions so they accurately describe the dedicated-periodic-queue architecture. This is a mechanical, same-shape change to the ~13 call-site updates already done elsewhere in the fix; both `enqueue_periodic_with_job_id` and `dequeue_next_periodic_with_job_id` are already public `PersistenceStore` trait methods importable from this file (`bob_core::ports::PersistenceStore`), so no new API surface is needed.

**Next step**: Developer applies the above change to `scheduler_execution_e2e.rs` and resubmits. No other issues found; Stage 1 and the rest of Stage 2 (correctness, readability, security, performance, minimality of the production-code fix) all pass.
