# Rust Coding Guidelines

These conventions apply to Rust code in `the-intern/service/`. The service is
the deterministic core of the Intern, so code should make boundaries explicit,
handle failure deliberately, and preserve auditability.

---

## 1. Design Principles

Use SOLID as a practical design checklist:

- **Single Responsibility:** each crate, module, type, and function should have
  one reason to change. Split code when domain decisions, I/O, persistence,
  policy, and process supervision start to live in the same unit.
- **Open/Closed:** add new commands, event kinds, policies, or storage backends
  by extending typed enums, traits, and adapter implementations instead of
  rewriting unrelated callers.
- **Liskov Substitution:** test doubles and alternate implementations must obey
  the same contract as the trait or port they replace, including error behavior
  and cancellation semantics.
- **Interface Segregation:** keep traits small and role-specific. A scheduler,
  policy evaluator, audit sink, process supervisor, or store should expose only
  the methods its callers need.
- **Dependency Inversion:** deterministic domain logic depends on traits and
  typed data. Concrete sockets, timers, child processes, filesystem access, and
  storage live at adapter boundaries.

Prefer simple data structures and functions over broad abstractions. Add a
trait only when there is a real boundary, a meaningful test double, or more than
one implementation.

## 2. Source Layout and Naming

The Rust workspace lives under `the-intern/service/`. Binary code wires
configuration, tracing, runtime startup, shutdown, and crate dependencies.
Business rules live in library code.

Use standard Rust naming:

| Kind | Convention | Example |
|---|---|---|
| Types, traits, enums | `UpperCamelCase` | `SessionEvent` |
| Functions, methods, variables | `snake_case` | `spawn_agent` |
| Constants, statics | `SCREAMING_SNAKE_CASE` | `MAX_POOL_SIZE` |
| Lifetimes | short lowercase | `'a`, `'conn` |

Module names are `snake_case` and describe responsibility. Avoid `utils` and
`helpers`; prefer names that say what the module owns. A file over about 300
lines is a signal to split it.

## 3. Boundaries and Contracts

Keep deterministic domain logic runtime-agnostic where practical. Policy
decisions, request normalization, audit record construction, and schedule or
persistence contracts should not depend directly on sockets, timers, child
processes, or filesystem effects.

Channel, admin, scheduler, extension, persistence, and process-supervision code
translate external effects into typed internal data and errors. They should not
hide policy decisions or invent implicit side effects.

Validate all external input at service boundaries: CLI input, Unix socket
messages, extension frames, channel payloads, child-process output, monitoring
reports, and persisted records read from disk.

Treat model-originated tool arguments as untrusted even when they came through a
supervised pi-agent process.

## 4. Async Runtime and Concurrency

Use Tokio for long-running service runtime work. Socket I/O, queues, timers,
channel adapters, and child-process supervision should be async unless there is
a measured reason otherwise.

Use bounded channels for internal queues. A full queue is an explicit service
state: reject, shed, retry later, or slow the producer. Do not hide backpressure
behind unbounded buffers.

Every spawned task is owned by a supervisor or task tracker. Do not spawn
detached work whose lifecycle cannot be cancelled, awaited, and observed during
shutdown.

Wrap external I/O, policy verdict calls, child-process operations, queue sends,
and queue receives in timeouts that map to typed service errors.

Keep blocking work out of the async runtime. If blocking I/O or CPU-heavy work
is unavoidable, isolate it behind a blocking boundary and document why.

## 5. Error Handling

Use `Result<T, E>` throughout. Panics are for programmer errors and invariant
violations, not expected runtime failure. Do not use `unwrap` or `expect` for
values that can legitimately be absent or fail.

At crate boundaries, use dedicated error enums with `thiserror`. Application
wiring may aggregate errors, but library APIs return typed errors callers can
inspect.

Propagate errors with `?` and add context where the operation, actor, and target
resource are known. Authorization uncertainty is not success: unknown policy
state fails closed.

Prefer the service error taxonomy where it fits:
`PolicyDenied`, `InvalidRequest`, `ServiceDown`, `Timeout`, `Shutdown`,
`Persistence`, `ChildProcess`, and `Configuration`.

Never include raw user content, credentials, tokens, file contents, raw tool
arguments, or sensitive policy-controlled data in errors. Include identifiers,
classes, byte counts, and safe metadata instead.

Public functions document failure behavior with `# Errors`. Document invariant
panics with `# Panics` and approved unsafe contracts with `# Safety`.

## 6. Observability and Audit Logging

Use `tracing` for structured diagnostics. Initialize tracing once at process
start. Production logs should be structured and machine-readable; local
development may use a human-readable formatter.

Emit spans for significant units of work: inbound event handling, request
normalization, policy decisions, child-process lifecycle changes, prompt
delivery, tool calls, monitoring ingest, and audit writes.

Use `snake_case` span fields such as `session_id`, `request_id`,
`tool_call_id`, `action`, `verdict`, and `duration_ms`.

Keep operational logs separate from append-only audit records. Audit records are
product behavior, not debug output.

Never log credential values, raw user message content, raw tool arguments, file
contents, or data classified as sensitive by Policy Control. Log payload shape
and safe identifiers instead.

## 7. Configuration and Secrets

Configuration is typed, validated once at startup, and treated as immutable
after service initialization unless a component has an explicit reload path.

Use layered configuration: safe defaults, local file values, environment
overrides, and explicit CLI flags for operational choices.

Fail fast on missing or invalid configuration. Include the key and source when
safe, but never print secret values.

Secrets and tokens use wrappers that do not expose values through ordinary
debug formatting. Policy rules remain explicit data or code, not hidden
environment-variable side effects.

## 8. Graceful Shutdown

Shutdown behavior is part of the service contract:

1. Stop accepting new events and admin requests.
2. Signal workers and supervisors to cancel.
3. Drain bounded queues up to a configured deadline.
4. Wait for tracked tasks to finish or report timeout.
5. Flush audit records and close sockets/listeners.
6. Terminate pi-agent children gracefully, then force kill only after timeout.

Shutdown paths log the trigger, remaining queue depth, active sessions,
child-process termination outcomes, audit flush result, and final exit reason.

## 9. Security and Supply Chain

Default crates to `#![forbid(unsafe_code)]`. Any unsafe code requires an ADR
that names the invariant, explains why safe Rust is insufficient, and describes
the review and test strategy.

Commit `Cargo.lock` for the service workspace and use locked dependency
resolution in CI and releases. Keep third-party dependencies narrow and
justified, especially on policy, monitoring, and process-control paths.

Add checks for known advisories, license policy, duplicate versions, and
disallowed sources when tooling is available.

## 10. Testing

Unit tests live near the code they test in `#[cfg(test)]` modules. Integration
tests that exercise multiple crates live in workspace test targets.

Tests describe behavior in their names:
`returns_block_verdict_when_user_lacks_permission`.

Each test should:

- arrange only the state it needs
- act through the public behavior of the unit
- assert observable behavior
- avoid shared mutable state
- avoid network, filesystem, wall-clock time, and real child processes unless
  that boundary is the subject under test
- use fakes or trait-backed test doubles for policy stores, adapters, audit
  sinks, clocks, sockets, and process supervisors

Async tests control timeouts and cancellation explicitly. Timer, retry,
idle-reaping, and queue-drain behavior should use controllable clocks when the
runtime allows it.

Integration coverage should include queue backpressure, request normalization,
policy denial, verdict timeout, child-process spawn/reap failure, audit append
failure, graceful shutdown, and no action on deny.

## 11. Formatting and Linting

Use `rustfmt` for formatting.

Use `clippy` for static checks such as unnecessary clones, panicking paths,
blocking-in-async mistakes, and unidiomatic patterns. Treat warnings as errors
for new code. Suppress a lint only with an inline `#[allow(...)]` and a comment
explaining why.

## 12. Packaging and Runtime

Release the service as a single OS-agnostic binary where practical.

Container images use a multi-stage build, a minimal runtime image, an explicit
non-root user, and only the binary plus required runtime assets. Runtime images
must not contain build caches, source checkout metadata, credentials, or unused
toolchains.

Production readiness includes health or readiness behavior, configured shutdown
deadlines, resource limits, audit-log durability expectations, and verification
that the service can start, reject malformed input, receive a shutdown signal,
flush audit records, and exit cleanly.
