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

### Session 1 — 2026-05-17

**What was done**

Replaced the `// scaffold` one-liner in `the-intern/service/crates/bob-core/src/error.rs` with the full `ServiceError` enum (nine variants per AC-1) and `ServiceResult<T>` alias. Used `thiserror::Error` (already a workspace dependency) to derive `Debug`, `Display`, and `std::error::Error` in a single derive macro.

The `Timeout { operation: &'static str }` variant is structurally safe: only compile-time literals can flow into it. The `String` fields on `PolicyDenied`/`InvalidRequest`/`Persistence`/`ChildProcess`/`Configuration` carry high-level cause descriptions (variant doc-comments + the Rust coding guidelines §5 enforce this convention); they are not for raw payloads.

26 tests cover: every variant constructs, every Display call does not panic, `ServiceResult<T>` alias resolves correctly, `Error::source` returns `None` for leaf variants, and `Debug` formatting works.

**What was tried and rejected**

No source-wrapping (`#[from]`/`#[source]`) was added because none of the variants wrap another error type — keeps the taxonomy intentionally explicit.

**What remains**

Nothing for this task.

**Obstacles Encountered**

- None. `thiserror` was already a workspace dependency from T-007.

**Artifacts**

- Branch `task/T-009-add-bob-core-error-taxonomy`, commit `43b5f43`: `feat(bob-core): add ServiceError enum and ServiceResult type alias`.
