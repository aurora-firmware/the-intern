---
id: T-110
title: Add end-to-end scheduled prompt execution coverage
status: pending
priority: high
assigned-role: developer
created: '2026-06-27'
spec: S-009
---

# Add end-to-end scheduled prompt execution coverage

## Description

S-009 success is confirmed when a configured cron entry causes a periodic
request to reach pi-agent on schedule. Unit coverage currently proves the
scheduler can submit to a mock intake, but there is no service-level test for
the complete path from `[[schedule]]` config through pre-flight admission and
pi-agent prompt dispatch.

Add an end-to-end Rust test that starts the real `bob serve` subsystem wiring
with a configured scheduled job, a policy entry admitting that job's deterministic
`UserId`, and a fake pi-agent RPC worker. The test must prove that the prompt
configured in `[[schedule]]` is delivered to the fake worker after the cron tick.

## Acceptance Criteria

AC-1: WHEN `bob serve` starts with a valid due `[[schedule]]` entry and an
      admitted scheduler-derived `UserId` THE SYSTEM SHALL deliver the entry's
      prompt to a pi-agent RPC worker.

AC-2: WHEN the same test observes the delivered prompt THE SYSTEM SHALL prove
      the value equals the `[[schedule]].prompt` string byte-for-byte.

AC-3: IF the scheduler-derived `UserId` is not admitted by policy THEN THE
      SYSTEM SHALL record a denied pre-flight verdict and shall not deliver the
      prompt to the fake pi-agent worker.

AC-4: The system shall run the new end-to-end coverage without requiring a real
      external `pi` binary.

## Dependencies

- `T-109` — admitted periodic events must be dispatched to pi-agent.

## Files to Touch

- `the-intern/service/crates/bob/tests/scheduler_execution_e2e.rs` — add the
  end-to-end scheduler execution coverage.
- `the-intern/service/crates/bob/Cargo.toml` — add any test-only dependency
  needed by the fake worker test, if existing dependencies are insufficient.

## Verification

```bash
cd the-intern/service
cargo test -p bob --test scheduler_execution_e2e -- --nocapture
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-27

Implemented the full set of acceptance criteria for T-110. The integration test `the-intern/service/crates/bob/tests/scheduler_execution_e2e.rs` was written from scratch, assembling the complete scheduled-prompt pipeline using only public crate APIs (no edits to `serve.rs`):

- `scheduler-adapter` → `requests-handler` (pre-flight) → `persistence` → inline periodic dispatcher → `pi-agent-supervisor` (fake `sh` RPC worker).
- A `start_inline_dispatcher()` helper replicates `serve::start_periodic_dispatcher` (private) for test use.
- `tokio::time::pause()` + `advance(61s)` triggers the `* * * * *` cron tick without real wall-clock waiting.
- A fake `sh` script worker reads JSON-RPC from stdin, writes the `message` field to a temp file, and responds with a success reply — no real `pi` binary required (AC-4).

**Key design decision:** After `advance(200ms)` wakes the dispatcher and enough `yield_now()` slices let it reach `send_prompt()`, the test calls `tokio::time::resume()` before the result-polling loop. With time paused, `tokio::time::advance()` runs in zero wall-clock time, the tokio IO reactor never gets an idle cycle via `epoll_wait`, and the OS does not schedule the sh child process. The advance-based tight loop exhausted 100 iterations before the child responded — causing a reliable failure in the full workspace run (isolated run passed only because of less OS load). After `resume()`, `tokio::time::sleep(50ms).await` uses real time, the runtime parks in `epoll_wait`, the child gets CPU and writes the file within milliseconds, and the test resolves in ≈50ms real time.

**Cargo.toml change:** Added `tokio = { version = "1", features = ["test-util"] }` to `bob`'s `[dev-dependencies]` so the integration test binary can call `pause()`/`advance()`/`resume()`.

All four acceptance criteria are covered by two test functions:
- `schedule_entry_prompt_is_delivered_to_pi_agent_when_scheduler_user_is_admitted` — AC-1, AC-2, AC-4.
- `schedule_entry_prompt_is_not_delivered_when_scheduler_user_is_not_admitted` — AC-3, AC-4.

Both pass in isolation and in the full workspace suite (`cargo test --workspace`).

### Session 2 — 2026-06-27

The reviewer confirmed AC-3 (`schedule_entry_prompt_is_not_delivered_when_scheduler_user_is_not_admitted`) was flaky, failing the denied-verdict assertion in approximately 2 of 10 runs. The root cause was the same issue already diagnosed and fixed for AC-1 in Session 1: with `tokio::time` paused, a bounded `yield_now()` loop gives the actor chain no real wall-clock time budget. The monitoring publish chain (scheduler → requests-handler → pre-flight closure → monitoring actor → subscriber channel) crosses at least five async message hops. Under workspace-level OS load those tasks may not get CPU within 30+20 bounded yields, leaving `verdict_rx` empty when checked.

The fix exactly mirrors the AC-1 pattern: after `advance(61s)` and a small number of initial yields (10, enough to kick off the scheduler tick), call `tokio::time::resume()`. Then replace the nested `yield_now()` + `try_recv()` retry block with a single `while std::time::Instant::now() < deadline` loop that drains `verdict_rx` and sleeps `tokio::time::sleep(50ms)` per iteration. The 50ms sleep is a real wall-clock sleep (time is resumed); it parks the runtime in `epoll_wait`, giving every actor task a scheduled turn. For the second assertion (file-not-delivered), the `advance(500ms)` + 20 yields was replaced with a single `tokio::time::sleep(200ms)` (real time) to let the dispatcher cycle through persistence (empty after denial) before checking.

Robustness verified: 20/20 consecutive focused runs passed (`cargo test -p bob --test scheduler_execution_e2e`). `cargo test --workspace` run once — all test binaries pass, scheduler_execution_e2e shows 2 passed, 0 failed, 0.26s. Fix committed as `619b5cd`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-06-27

FAIL

**Stage 1 — Acceptance Criteria**

- AC-1 (PASS): The admitted-user test correctly delivers the prompt to the fake `sh` worker and asserts it at the assertion site.
- AC-2 (PASS): Byte-for-byte equality assertion is present (`assert_eq!(delivered_prompt, expected_prompt, ...)`) after the polling loop confirms delivery.
- AC-3 (FAIL — confirmed flaky): The denied-verdict observation in `schedule_entry_prompt_is_not_delivered_when_scheduler_user_is_not_admitted` is non-deterministic. The async event chain (scheduler → requests-handler → pre-flight → monitoring publish) involves multiple message-passing steps across tokio actors. The observation relies on a bounded `yield_now()` loop (30 yields before the drain attempt, 20 more if still empty) with no real-time fallback. Time remains paused throughout the entire assertion phase. Under OS load this is insufficient: 2 of 10 consecutive focused runs failed at line 475 with `"a denied pre-flight verdict must be recorded in monitoring when user is not admitted"`.
- AC-4 (PASS): Both test functions use a `sh` script as the fake RPC worker; no real `pi` binary is required.

**Stage 2 — Code Quality**

- The inline dispatcher (`start_inline_dispatcher`) faithfully replicates `serve::start_periodic_dispatcher`: same cancel-check loop structure, same dequeue/re-enqueue logic for non-periodic events, same acquire-then-send-prompt path for periodic events. Behaviorally equivalent to the production function.
- The AC-1/AC-2 test handles the IO-driven observation correctly: `tokio::time::resume()` is called before the file-polling loop so the runtime parks in `epoll_wait` and the OS can schedule the `sh` child. This is the correct pattern.
- The AC-3 test does not apply the same pattern to the monitoring observation step. The fix is straightforward: call `tokio::time::resume()` after the advance+yield block, then poll `verdict_rx` with real `tokio::time::sleep(Duration::from_millis(50))` sleeps inside a deadline loop (matching the AC-1 pattern), rather than bounded `yield_now()` only.
- Scope is clean: only the two specified files were changed (`tests/scheduler_execution_e2e.rs` and `Cargo.toml`).

**What should change:**

- **File:** `the-intern/service/crates/bob/tests/scheduler_execution_e2e.rs`
- **Location:** `schedule_entry_prompt_is_not_delivered_when_scheduler_user_is_not_admitted`, after `tokio::time::advance(Duration::from_secs(61)).await` and the 30 `yield_now()` calls (approximately lines 425–473).
- **What is wrong:** After `advance(61s)` the test drains and re-polls `verdict_rx` using only bounded `yield_now()` loops while `tokio::time` remains paused. The monitoring actor, requests-handler, and pre-flight chain require more than 30+20 `yield_now()` calls to propagate the verdict under OS load. This causes intermittent assertion failure (≈20% failure rate observed).
- **What should change:** Call `tokio::time::resume()` immediately after the 30 `yield_now()` block (before the `try_recv` drain). Then replace the bounded inner `for _ in 0..20` fallback loop with a real-time deadline poll that uses `tokio::time::sleep(Duration::from_millis(50)).await` per iteration and a `std::time::Instant` deadline of 5 seconds — the same pattern used by the AC-1 test for prompt-delivery observation. This allows the runtime to park and OS-schedule the actors until the verdict arrives.
