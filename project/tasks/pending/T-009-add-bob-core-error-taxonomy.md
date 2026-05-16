---
id: T-009
title: Add bob-core error taxonomy
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Add bob-core error taxonomy

## Description

Add the typed service error taxonomy that every subsystem returns at its
boundaries, per Rust coding guidelines §5. Defines `bob_core::error::ServiceError`
using `thiserror`. Variants match the stable taxonomy named in the guidelines
plus a `NotImplemented` variant used by scaffold placeholders.

Error messages must never include raw user content, credentials, tokens, or
sensitive payloads — only identifiers and safe metadata. Each variant takes
fields chosen to make this constraint structural (e.g. `Timeout { operation:
&'static str }`, `Configuration { detail: String }` where `detail` is meant
for cause descriptions, not values).

A `ServiceResult<T>` type alias is provided for convenience and consistency
across subsystems.

## Acceptance Criteria

AC-1: The system shall expose `bob_core::error::ServiceError` as a public enum with variants `PolicyDenied { reason: String }`, `InvalidRequest { detail: String }`, `ServiceDown`, `Timeout { operation: &'static str }`, `Shutdown`, `Persistence { detail: String }`, `ChildProcess { detail: String }`, `Configuration { detail: String }`, and `NotImplemented`.
AC-2: The `ServiceError` type shall implement `std::error::Error`, `std::fmt::Debug`, and `std::fmt::Display` via `thiserror::Error`.
AC-3: IF a `ServiceError` instance is formatted with `Display` THEN THE SYSTEM SHALL NOT include any field that holds raw user content, credentials, or tokens.
AC-4: The system shall provide a public type alias `bob_core::error::ServiceResult<T> = Result<T, ServiceError>`.

## Dependencies

- `T-007` — `bob-core` crate skeleton and `error.rs` placeholder must exist

## Files to Touch

- `the-intern/service/crates/bob-core/src/error.rs` — replace placeholder; full `ServiceError` enum + `ServiceResult` alias

## Verification

```bash
cd the-intern/service && cargo test -p bob-core --lib error
cd the-intern/service && cargo check -p bob-core
```

## Work Log

## Review
