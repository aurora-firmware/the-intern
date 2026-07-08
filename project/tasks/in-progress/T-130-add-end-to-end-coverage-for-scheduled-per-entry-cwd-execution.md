---
id: T-130
title: Add end-to-end coverage for scheduled per-entry cwd execution
status: pending
priority: medium
assigned-role: developer
created: '2026-07-05'
spec: S-009
---

# Add end-to-end coverage for scheduled per-entry cwd execution

## Description

Extend the scheduler e2e suite
(`crates/bob/tests/scheduler_execution_e2e.rs`) to cover the per-entry cwd path
end to end: a scheduled entry with a `cwd` runs its pi session in that directory
(precedence honoured); a per-entry `cwd` that is absent at fire time causes the
fire to be skipped with a warning and the entry to remain; and the audit record
for a firing carries the resolved cwd. These tests use Unix domain sockets and
may require a normal (non-sandboxed) shell to pass locally; CI runs them on the
self-hosted runners.

## Acceptance Criteria

AC-1: WHEN a scheduled entry with a per-entry `cwd` fires THE SYSTEM SHALL run the
      pi session with that directory as its working directory, asserted by the
      test.
AC-2: IF a scheduled entry's per-entry `cwd` does not exist at fire time THEN THE
      SYSTEM SHALL skip the fire with a warning and leave the entry present,
      asserted by the test.
AC-3: WHEN a scheduled entry fires THE SYSTEM SHALL record the resolved cwd on the
      audit record, asserted by the test.

## Dependencies

- `T-127` — dispatch-time cwd resolution and fire-time skip
- `T-128` — resolved cwd recorded on the audit record

## Files to Touch

- `crates/bob/tests/scheduler_execution_e2e.rs` — add per-entry cwd e2e cases

## Verification

```bash
cd the-intern/service && cargo test -p bob --test scheduler_execution_e2e
```

## Work Log

## Review
