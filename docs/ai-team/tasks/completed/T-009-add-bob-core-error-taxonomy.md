---
id: T-009
title: Add bob-core error taxonomy
status: completed
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

### Review Verdict — 2026-05-17

PASS

**Stage 1 — Acceptance Criteria**

- AC-1: `ServiceError` is a public enum with all nine variants and exact field shapes as specified. Verified by reading `error.rs` at commit `43b5f43`. All variant names, field names, and field types (`&'static str` for `Timeout.operation`, `String` for all others) match the criterion exactly.
- AC-2: `#[derive(Debug, Error)]` is present. `thiserror::Error` derives `Display` (via `#[error(...)]` attributes) and `std::error::Error`; `Debug` is derived directly. All three trait implementations are confirmed.
- AC-3: `Timeout { operation: &'static str }` is structurally safe — only compile-time string literals can be passed, precluding runtime user data. `String`-carrying variants (`PolicyDenied`, `InvalidRequest`, `Persistence`, `ChildProcess`, `Configuration`) carry high-level cause descriptions enforced by variant doc-comments and the module-level doc stating the constraint explicitly. The Display format strings (e.g. `"policy denied: {reason}"`, `"persistence error: {detail}"`) reference the fields by their cause-descriptor names, not as raw-payload slots. AC-3 is satisfied.
- AC-4: `pub type ServiceResult<T> = Result<T, ServiceError>` is present and exported from `bob_core::error`. Confirmed.

No unspecified behavior or features were added. Only `error.rs` was modified (confirmed by `git show 43b5f43 --stat`: 1 file changed).

**Stage 2 — Code Quality**

- Correctness: Logic is correct. No off-by-one errors or unhandled states; the enum is exhaustive. No `#[from]`/`#[source]` wrappers added deliberately, keeping the taxonomy explicit as documented.
- Tests: 26 tests in `#[cfg(test)] mod tests` within `error.rs`, all under the `error::tests::` path. Cover every variant construction (9 tests), every Display call (9 tests), `ServiceResult<T>` alias (2 tests), `Error::source` returning `None` (4 tests), and `Debug` formatting for all variants (1 omnibus test). Tests are independent, construct their own fixtures, and have no shared mutable state.
- Security: No hardcoded credentials or secrets. `&'static str` on `Timeout.operation` is a structural enforcement of the security constraint. Input validation is not applicable here (this is a pure type definition).
- Readability: Module-level and variant-level doc comments clearly articulate the intended use of each field and the security constraint. Format strings are concise and follow a consistent `"<category>: {field}"` pattern. No dead code, no commented-out blocks, no debugging artifacts.
- Performance: Not applicable — this is a pure type definition with no I/O or loops.
- Guidelines §5 compliance: `thiserror` used at the crate boundary; typed variants callers can inspect; no raw user content in error messages; `# Errors` sections documented at the enum level. Fully compliant.

**Verification Evidence**

- `cargo test -p bob-core --lib` on branch `task/T-009-add-bob-core-error-taxonomy`: 60 tests passed, 0 failed. Error module contributes 26 tests, all under `error::tests::` prefix.
- `cargo check -p bob-core`: completed with no errors or warnings.
- Note: the task's first verification command (`cargo test -p bob-core --lib error`) uses `error` as a `--lib` flag argument rather than a test filter. Invoking it correctly as a filter (`-- error`) matches only `from_str_returns_error_for_invalid_uuid` from the identifiers module, not the error module tests (whose paths begin `error::tests::`). This is an issue in the task's verification command text, not in the implementation. Running the full `--lib` suite confirms all 26 error tests pass.
