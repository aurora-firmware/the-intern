# Rust Coding Guidelines

These conventions apply to the Rust service that forms the deterministic core
of the Intern. They are prose only; tool configs belong with the implementation
when the service workspace exists.

---

## 1. Source Layout and Module Naming

Organise code as a single Cargo workspace under `the-intern/service`. Each
logical subsystem lives in its own crate inside `crates/`: channel adapters,
request handling, policy control, monitoring, persistence, and pi-agent process
supervision. Binary entry points wire configuration, tracing, async runtime,
shutdown, and crate dependencies; durable business rules live in library crates.

Keep deterministic domain logic runtime-agnostic where practical. Policy rules,
request normalization, audit record construction, and persistence contracts
should not depend directly on sockets, timers, child processes, or filesystem
effects. Put Tokio I/O, Unix sockets, HTTP/webhook adapters, child-process
control, and concrete storage at adapter boundaries.

Module names are `snake_case` and describe a single responsibility. Avoid
generic names such as `utils` or `helpers`; prefer `audit_log`,
`pool_supervisor`, or `verdict`. A module that has grown beyond about 300 lines
is a signal to split it. File structure mirrors the module hierarchy:
`policy/control.rs` holds `mod policy::control`.

## 2. Identifier Naming Conventions

Follow the standard Rust naming rules enforced by formatter and linter:

| Kind | Convention | Example |
|---|---|---|
| Types, traits, enums | `UpperCamelCase` | `SessionEvent`, `PolicyVerdict` |
| Functions, methods, variables | `snake_case` | `spawn_agent`, `idle_timeout` |
| Constants, statics | `SCREAMING_SNAKE_CASE` | `MAX_POOL_SIZE` |
| Lifetimes | short lowercase | `'a`, `'conn` |

Prefer full words over abbreviations unless the abbreviation is universally
understood (`rpc`, `id`, `url`). A name should read as a phrase:
`is_authorized`, `handle_inbound_event`, `send_verdict`.

## 3. Async Runtime and Concurrency

Use Tokio for the long-running service runtime. All queues, socket I/O, timers,
child-process supervision, and channel adapters should be async unless there is
a measured reason otherwise.

Use bounded channels for internal queues and make backpressure explicit. A full
queue is a service state that must be handled deliberately: reject, shed, retry
later, or slow the producer. Do not hide backpressure behind unbounded buffers.

Every spawned task is owned by a supervisor or task tracker. Do not spawn
detached work whose lifecycle cannot be cancelled, awaited, and observed during
shutdown. Wrap external I/O, policy verdict calls, child-process operations, and
queue receives in timeouts that map to typed service errors.

Reserve blocking work for explicit blocking boundaries. If unavoidable blocking
I/O or CPU-heavy work appears, isolate it from the async runtime and document
why it cannot be made async or moved out of process.

## 4. Service Interfaces and Middleware

For HTTP, webhook, scheduler, and admin surfaces, prefer the Tower ecosystem
style of composable services and layers. Cross-cutting behavior such as
timeouts, request IDs, rate limits, authentication context, tracing, and
readiness checks should be reusable middleware rather than duplicated in each
adapter.

Channel adapters translate edge protocols into internal event structs and then
hand off to the Requests Handler. They should not contain policy decisions or
agent orchestration logic.

## 5. Error Handling

Use `Result<T, E>` throughout. Panics are reserved for programmer errors and
invariant violations; do not use `unwrap` or `expect` on values that can
legitimately be absent or fail at runtime.

At crate boundaries, define dedicated error enums with `thiserror`. Application
wiring may use broader error aggregation, but library APIs return typed errors
callers can inspect. Propagate errors with `?` and add context at the boundary
where the operation, actor, and target resource are known.

Use a stable service error taxonomy where it fits the domain:
`PolicyDenied`, `InvalidRequest`, `ServiceDown`, `Timeout`, `Shutdown`,
`Persistence`, `ChildProcess`, and `Configuration`. Authorization uncertainty is
not success; unknown policy state must fail closed.

Never include raw user content, credentials, tokens, file contents, or sensitive
policy-controlled data in error values or messages. Include identifiers,
classes, byte counts, and safe metadata instead.

Public functions document their failure behavior. Use `# Errors` for expected
failures, `# Panics` for invariant violations that can panic, and `# Safety`
for any unsafe API approved by ADR.

## 6. Observability and Audit Logging

Use `tracing` for structured, levelled diagnostics throughout the service.
Initialize tracing once at process start. Production logs should be structured
and machine-readable; local development may use a more human-readable formatter.

Emit spans for every significant unit of work: inbound event handling, request
normalization, policy decision, child-process lifecycle change, prompt delivery,
tool call, monitoring ingest, and audit write. Span fields are `snake_case`
key-value pairs such as `session_id`, `request_id`, `tool_call_id`, `action`,
`verdict`, and `duration_ms`.

Level guidance:

| Level | When to use |
|---|---|
| `ERROR` | A condition the service cannot recover from automatically |
| `WARN` | A recoverable problem that degrades correctness or performance |
| `INFO` | Significant state transitions and policy/audit milestones |
| `DEBUG` | Detailed operational data useful during development |
| `TRACE` | High-frequency internal data; disabled in production |

Keep operational logs separate from append-only audit records. Audit records are
part of the product contract and must be sufficient to reconstruct incoming
requests, routing decisions, authorization verdicts, tool invocations, results,
and failures.

Never log credential values, raw user message content, or data classified as
sensitive by Policy Control. Log the shape of a payload rather than its
contents when tracing data flow.

## 7. Configuration and Secrets

Configuration is typed, validated once at startup, and treated as immutable
after service initialization. Use layered configuration: safe defaults, local
file values, environment overrides, and explicit CLI flags for operational
choices.

Fail fast on missing or invalid configuration. Include the configuration key and
source when safe, but never print secret values. Credentials and tokens are
wrapped in secret-holding types that do not expose values through ordinary debug
formatting.

Configuration determines runtime behavior such as socket paths, queue sizes,
timeouts, pool sizes, audit-log destinations, and channel adapter settings.
Policy rules remain explicit data or code, not implicit side effects hidden in
environment variables.

## 8. Graceful Shutdown

Shutdown has a defined protocol:

1. Stop accepting new channel events and admin requests.
2. Signal workers and supervisors to cancel.
3. Drain bounded queues up to a configured deadline.
4. Wait for tracked tasks to finish or report timeout.
5. Flush audit records and close sockets/listeners.
6. Terminate idle pi-agent children, then active children, using forced kill only
   after a timeout.

Shutdown paths are observable. They log the trigger, remaining queue depth,
active sessions, child-process termination outcomes, audit flush result, and
final exit reason.

## 9. Security and Supply Chain

Default crates to `#![forbid(unsafe_code)]`. Any unsafe code requires an ADR
that names the invariant, explains why safe Rust is insufficient, and describes
the review and test strategy.

Commit `Cargo.lock` for the service workspace and use locked dependency
resolution in CI and releases. Add dependency checks for known advisories,
license policy, duplicate versions, and disallowed sources when the workspace
is introduced. Keep third-party dependencies narrow and justified, especially
on policy, monitoring, and process-control paths.

Validate all external input at the service boundary: channel payloads, webhook
bodies, Unix socket messages, child-process output, CLI-tool monitoring reports,
and persisted records read back from storage. Treat model-originated arguments
as untrusted even when they came through a supervised pi-agent process.

## 10. Testing Conventions

Unit tests live alongside the code they test in `#[cfg(test)]` modules within
the same file. Integration tests that exercise multiple crates live in a
workspace-level `tests/` directory.

A good test:

- Has a descriptive name that states the condition and the expected outcome:
  `returns_block_verdict_when_user_lacks_permission`.
- Arranges the minimum state needed for the scenario, acts on the unit under
  test, and asserts the result.
- Does not share mutable state with other tests; each test constructs its own
  fixtures.
- Does not depend on network, filesystem, wall-clock time, or real child
  processes unless those are the explicit subjects under test.
- Uses fakes or trait-backed test doubles for policy stores, channel adapters,
  audit sinks, clocks, sockets, and process supervisors.

Async tests must control timeouts and cancellation explicitly. Timer, retry,
idle-reaping, and queue-drain behavior should use controllable clocks where the
chosen runtime allows it.

Integration coverage must include queue backpressure, request normalization,
policy denial, verdict timeout, child-process spawn/reap failure, audit append
failure, graceful shutdown, and no-action-on-deny behavior.

Do not select a specific test runner here; use whatever tooling the project
settles on. The conventions above apply regardless of runner choice.

## 11. Formatter and Linter

**`rustfmt`** enforces consistent formatting automatically. Run it before every
commit.

**`clippy`** catches common pitfalls such as unnecessary clones, panicking
paths, blocking-in-async mistakes, and unidiomatic patterns. Treat warnings as
errors; suppress a lint only with an inline `#[allow(...)]` and a comment
explaining why.

## 12. Packaging and Runtime

Release the Rust service as a single OS-agnostic binary where practical.
Container images use a multi-stage build, a minimal runtime image, an explicit
non-root user, and only the binary plus required runtime assets. Runtime images
must not contain build caches, source checkout metadata, credentials, or unused
toolchains.

Production readiness includes a health or readiness surface, configured
shutdown deadlines, resource limits, audit-log durability expectations, and
verification that the service can start, reject malformed input, receive a
shutdown signal, flush audit records, and exit cleanly.
