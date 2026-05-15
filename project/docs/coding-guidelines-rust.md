# Rust Coding Guidelines

These conventions apply to the Rust service that forms the core of the Intern.
They are prose only — no tool configs are checked in as part of this document.

---

## 1. Source Layout and Module Naming

Organise code as a single Cargo workspace. Each logical subsystem (channel
adapters, requests handler, policy control, monitoring, process pool) lives in
its own crate inside `crates/`. Binary entry points go in `src/main.rs`; library
code exposed to other crates goes in `src/lib.rs`.

Module names are `snake_case` and describe a single responsibility. Avoid generic
names such as `utils` or `helpers`; prefer `audit_log`, `pool_supervisor`, or
`verdict`. A module that has grown beyond ~300 lines is a signal to split it.
File structure mirrors the module hierarchy: `policy/control.rs` holds
`mod policy::control`.

## 2. Identifier Naming Conventions

Follow the standard Rust naming rules (enforced by `rustfmt` and `clippy`):

| Kind | Convention | Example |
|---|---|---|
| Types, traits, enums | `UpperCamelCase` | `SessionEvent`, `PolicyVerdict` |
| Functions, methods, variables | `snake_case` | `spawn_agent`, `idle_timeout` |
| Constants, statics | `SCREAMING_SNAKE_CASE` | `MAX_POOL_SIZE` |
| Lifetimes | short lowercase | `'a`, `'conn` |

Prefer full words over abbreviations unless the abbreviation is universally
understood (`rpc`, `id`, `url`). A name should read as a phrase: `is_authorized`,
`handle_inbound_event`, `send_verdict`.

## 3. Error Handling

Use `Result<T, E>` throughout. Panics are reserved for programmer errors
(invariant violations that should never occur in correct code); do not use
`unwrap` or `expect` on values that can legitimately be `None` or `Err` at
runtime.

At crate boundaries, define a dedicated error enum with `thiserror`. Internal
helpers may use a boxed error (`Box<dyn std::error::Error + Send + Sync>`) only
when the concrete type is never inspected by the caller. Propagate errors with
`?`; add context with `.map_err` or `.context` (via `anyhow` at application
crate level) so that the error message names the operation that failed and the
input that caused it.

Never swallow errors silently. If a recoverable failure is expected and the
caller needs no further information, model it as `Option<T>`, not a suppressed
`Err`.

## 4. Logging Conventions

Use `tracing` for structured, levelled logging throughout the service. Emit spans
for every significant unit of work (request handling, process spawn, policy
decision). Fields are key-value pairs; keys are `snake_case` nouns
(`session_id`, `action`, `verdict`, `duration_ms`).

Level guidance:

| Level | When to use |
|---|---|
| `ERROR` | A condition the service cannot recover from automatically |
| `WARN` | A recoverable problem that degrades correctness or performance |
| `INFO` | Significant state transitions (service start, session open/close, policy decision) |
| `DEBUG` | Detailed operational data useful during development |
| `TRACE` | High-frequency internal data; disabled in production |

Never log credential values, raw user message content, or data classified as
sensitive by Policy Control. Log the shape of a payload (field names, byte
counts) rather than its contents when you need to trace a data flow.

## 5. Testing Conventions

Tests live alongside the code they test in `#[cfg(test)]` modules within the
same file. Integration tests that exercise multiple crates live in a top-level
`tests/` directory.

A good test:

- Has a descriptive name that states the condition and the expected outcome:
  `returns_block_verdict_when_user_lacks_permission`.
- Arranges the minimum state needed for the scenario, acts on the unit under
  test, and asserts the result — nothing more.
- Does not share mutable state with other tests; each test constructs its own
  fixtures.
- Does not depend on network, filesystem, or clock unless those are the explicit
  subjects under test. Replace them with in-process fakes or trait objects.

Do not select a specific test runner here; use whatever tooling the project
settles on. The conventions above apply regardless of runner choice.

## 6. Formatter and Linter

**`rustfmt`** — enforces consistent formatting automatically. The formatter
removes debates about whitespace and style, keeping code reviews focused on
logic. Run it before every commit.

**`clippy`** — static analysis for idiomatic Rust. It catches common pitfalls
(unnecessary clones, panicking paths, unidiomatic patterns) and enforces a
higher bar than the compiler alone. Treat `clippy` warnings as errors;
suppress a lint only with an inline `#[allow(...)]` and a comment explaining why.
