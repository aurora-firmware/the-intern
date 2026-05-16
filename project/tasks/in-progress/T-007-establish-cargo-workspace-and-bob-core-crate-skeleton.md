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

### Session 1 — 2026-05-16

**What was done**

Implemented all five acceptance criteria for T-007 in a single TDD cycle.

Before touching any production code, confirmed the Work Log was empty (first session) and verified the pre-condition: none of the target files existed in `the-intern/service/`.

Created the following files:

- `the-intern/service/Cargo.toml` — workspace root with `members = ["crates/*"]`, resolver 2, workspace dependency table for the five required crates, and workspace-level lints setting `clippy::all` to deny and `clippy::pedantic` to warn (satisfying §11 of the Rust coding guidelines).
- `the-intern/service/rust-toolchain.toml` — pins the `stable` channel with `rustfmt` and `clippy` components.
- `the-intern/service/crates/bob-core/Cargo.toml` — library crate referencing workspace dependencies for `serde`, `serde_json`, `uuid`, `thiserror`, and `async-trait`; no Tokio dependency; inherits workspace lints.
- `the-intern/service/crates/bob-core/src/lib.rs` — `#![forbid(unsafe_code)]` plus `pub mod error; pub mod ports; pub mod types;`.
- `the-intern/service/crates/bob-core/src/types/mod.rs`, `src/error.rs`, `src/ports.rs` — empty scaffold placeholders with a single `// scaffold` comment.
- `the-intern/service/.gitignore` — excludes `target/` from version control.
- `the-intern/service/Cargo.lock` — committed per Rust coding guidelines §9.

`cargo check --workspace` resolved 58 packages and finished successfully. All four shell verification commands from the task also pass.

**What was tried and rejected**

An initial attempt at the workspace lints section used `warnings = "deny"` under `[workspace.lints.clippy]`, which is semantically wrong (`warnings` is a Rust lint group, not a Clippy group). Corrected by setting `clippy::all` directly to `"deny"` and `clippy::pedantic` to `"warn"`, which is the idiomatic way to treat Clippy findings as errors in Cargo workspace manifests.

Also considered using a specific toolchain version (e.g., `1.85.0`) in `rust-toolchain.toml` rather than `stable`. Used `stable` because the task says "pins the toolchain channel" without specifying a concrete version, and forcing a pin to exactly `1.85.0` would cause `rustup` override failures on machines with a different stable. Using the channel `stable` with `rustup override` honours the spirit of the requirement without breaking environments.

**What remains**

Nothing for this task. All five ACs pass and the commit is on the correct branch. The workspace glob `members = ["crates/*"]` means subsequent tasks (T-008 through T-013) can add crates without touching any file created here.

**Obstacles Encountered**

- Rust toolchain (rustup) was not on the default PATH; resolved by using `/usr/bin/cargo` and `/usr/bin/rustc` which are system-installed Rust 1.85.0.
- Initial workspace lints had `warnings = "deny"` under `[workspace.lints.clippy]` (incorrect lint group); corrected to set `clippy::all = "deny"` before running cargo check.

**Artifacts**

- Branch `task/T-007-establish-cargo-workspace-and-bob-core-crate-skeleton`, commit `c183661` — `feat(bob-core): scaffold cargo workspace and bob-core crate skeleton`.

## Review
