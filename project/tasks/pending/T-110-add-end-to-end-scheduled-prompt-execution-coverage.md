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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
