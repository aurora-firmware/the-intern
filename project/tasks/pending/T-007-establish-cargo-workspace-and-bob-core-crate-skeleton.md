---
id: T-007
title: Establish Cargo workspace and bob-core crate skeleton
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-16'
spec: S-001
---

# Establish Cargo workspace and bob-core crate skeleton

## Description

Lay the Rust workspace foundation under `the-intern/service/` (created in T-003)
and the runtime-agnostic `bob-core` library crate that S-002 names as the
holder of every domain type and port trait. The workspace declares its members
with the glob `members = ["crates/*"]` so later subsystem crates can be added
without touching the workspace root — eliminating the file-conflict trap that
would otherwise serialize every subsystem task.

`bob-core` is created with its full module skeleton (empty placeholder files
for `types`, `error`, `ports`) and every dependency it will need
(`serde`, `serde_json`, `uuid`, `thiserror`, `async-trait`), so later tasks
fill modules in place without touching `Cargo.toml` or `lib.rs`. The crate
forbids unsafe code and declares no Tokio dependency, per S-002's
runtime-agnostic principle.

A `rust-toolchain.toml` at the workspace root pins the toolchain version.
Workspace-level lints set clippy warnings as errors per Rust coding
guidelines §11.

## Acceptance Criteria

AC-1: The system shall provide `the-intern/service/Cargo.toml` declaring a Cargo workspace whose `members` field is `["crates/*"]`.
AC-2: The system shall provide `the-intern/service/crates/bob-core/` containing a library crate named `bob-core` whose `Cargo.toml` declares `serde`, `serde_json`, `uuid`, `thiserror`, and `async-trait` as dependencies and no Tokio dependency.
AC-3: The `bob-core` crate root (`src/lib.rs`) shall declare `#![forbid(unsafe_code)]` and `pub mod types;`, `pub mod error;`, `pub mod ports;`.
AC-4: WHEN `cargo check --workspace --manifest-path the-intern/service/Cargo.toml` is run THE SYSTEM SHALL exit with code 0.
AC-5: The system shall pin the Rust toolchain via `the-intern/service/rust-toolchain.toml`.

## Dependencies

- None

## Files to Touch

- `the-intern/service/Cargo.toml` — new; workspace root with `members = ["crates/*"]`, workspace-level dependency table, and clippy lint config
- `the-intern/service/rust-toolchain.toml` — new; pins the toolchain channel
- `the-intern/service/crates/bob-core/Cargo.toml` — new; library crate manifest with dependencies listed in AC-2
- `the-intern/service/crates/bob-core/src/lib.rs` — new; `#![forbid(unsafe_code)]` plus the three `pub mod` declarations
- `the-intern/service/crates/bob-core/src/types/mod.rs` — new; empty placeholder (one `// scaffold` comment is fine)
- `the-intern/service/crates/bob-core/src/error.rs` — new; empty placeholder
- `the-intern/service/crates/bob-core/src/ports.rs` — new; empty placeholder

## Verification

```bash
cd the-intern/service && cargo check --workspace
grep -q '^members = \["crates/\*"\]' the-intern/service/Cargo.toml
grep -q 'forbid(unsafe_code)' the-intern/service/crates/bob-core/src/lib.rs
! grep -E '^tokio\b' the-intern/service/crates/bob-core/Cargo.toml
test -f the-intern/service/rust-toolchain.toml
```

## Work Log

## Review
