---
id: T-012
title: Scaffold core subsystem actor crates requests-handler policy-control monitoring
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Scaffold core subsystem actor crates requests-handler policy-control monitoring

## Description

Create the three core subsystem actor crates named in S-001 §Components and
S-002 §Component 6: `requests-handler`, `policy-control`, `monitoring`. Same
scaffold pattern as T-011: each exposes `Handle` (clonable, mpsc-backed),
`Actor`, and `start() -> (Handle, JoinHandle<()>)`. Every command method
returns `Err(ServiceError::NotImplemented)` for now.

These crates have no direct dependencies on each other in this task — the
wiring that connects them (e.g., requests-handler→monitoring for audit
records) happens in the `bob serve` runtime (T-017). Dependencies: `tokio`,
`bob-core`, `tracing`, `async-trait`. All forbid unsafe code.

## Acceptance Criteria

AC-1: The system shall provide library crates `requests-handler`, `policy-control`, and `monitoring` under `the-intern/service/crates/`, each exposing a public `Handle` and `start`.
AC-2: WHEN any `Handle` command method on these three crates is called THE SYSTEM SHALL return `Err(ServiceError::NotImplemented)`.
AC-3: WHEN `cargo check --workspace --manifest-path the-intern/service/Cargo.toml` is run THE SYSTEM SHALL exit with code 0.
AC-4: The system shall NOT declare any direct dependency between the three crates in their `Cargo.toml` files.
AC-5: The system shall declare `#![forbid(unsafe_code)]` in each crate's `lib.rs`.

## Dependencies

- `T-007` — workspace and `bob-core` skeleton
- `T-009` — `ServiceError`

## Files to Touch

- `the-intern/service/crates/requests-handler/Cargo.toml` — new
- `the-intern/service/crates/requests-handler/src/lib.rs` — new; scaffold
- `the-intern/service/crates/policy-control/Cargo.toml` — new
- `the-intern/service/crates/policy-control/src/lib.rs` — new; scaffold
- `the-intern/service/crates/monitoring/Cargo.toml` — new
- `the-intern/service/crates/monitoring/src/lib.rs` — new; scaffold

## Verification

```bash
cd the-intern/service && cargo check --workspace
for c in requests-handler policy-control monitoring; do
  test -f the-intern/service/crates/$c/Cargo.toml
  grep -q 'forbid(unsafe_code)' the-intern/service/crates/$c/src/lib.rs
done
```

## Work Log

## Review
