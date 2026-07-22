# Node.js Coding Guidelines

These conventions apply to TypeScript code in `the-intern/pi-extension/`. The
extension runs inside each pi-agent process, so code in this package must be
small, explicit, fail-closed, and easy to audit.

---

## 1. Design Principles

Use SOLID as a practical design checklist:

- **Single Responsibility:** each file, class, function, and schema should have
  one reason to change. Split code when a module mixes hook registration,
  socket transport, validation, logging, and policy handling.
- **Open/Closed:** add new message shapes, event kinds, or policy outcomes by
  extending typed handlers and schemas instead of rewriting broad conditionals.
- **Liskov Substitution:** fakes and test doubles must obey the same observable
  contract as the socket, logger, clock, or pi-agent API they replace.
- **Interface Segregation:** expose narrow interfaces for hook handling,
  verdict transport, event forwarding, and logging. Do not make callers depend
  on methods they do not use.
- **Dependency Inversion:** high-level hook logic depends on small local
  interfaces; concrete sockets, clocks, process APIs, and loggers are passed in
  at the boundary.

Prefer simple functions and plain data over framework-heavy abstractions. Add an
abstraction only when it reduces duplication, clarifies a boundary, or makes
security-critical behavior easier to test.

## 2. Source Layout and Naming

Entry points stay thin: register pi-agent hooks, load configuration, initialize
logging, and delegate to focused modules.

Files and directories use `kebab-case`. Variables and functions use
`camelCase`. Classes, interfaces, and types use `PascalCase`. Constants that are
never reassigned use `SCREAMING_SNAKE_CASE`.

Use descriptive full words unless the abbreviation is standard (`id`, `url`,
`rpc`). Boolean names start with `is`, `has`, or `can`.

Avoid barrel re-exports that hide where a symbol comes from. A file over about
300 lines is a signal to split it by responsibility.

## 3. Boundaries and Validation

TypeScript types do not validate runtime data. Define schemas for every message
that crosses a boundary: pi-agent events, tool-call requests, socket requests,
socket responses, monitoring events, and persisted or replayed metadata.

Validate as early as possible and fail closed. A malformed tool call, verdict,
session id, user identity, action shape, or monitoring frame must not be treated
as allowed behavior.

Schemas should constrain:

- required identifiers
- enum values
- payload sizes
- argument shapes
- redaction behavior

Treat model-originated tool arguments as untrusted, even when they arrive
through pi-agent APIs.

## 4. Error Handling

Throw typed `Error` subclasses, not strings or plain objects. Define errors by
failure domain, such as `SocketConnectionError`, `VerdictTimeoutError`, and
`MalformedVerdictError`.

Do not mix thrown errors and `result.ok` objects within the same layer. Async
extension code throws on failure and returns values on success. Use result-like
protocol objects only at boundaries that explicitly model allow/block behavior.

Operational errors, such as socket disconnects, verdict timeouts, and malformed
remote payloads, become explicit block or monitoring outcomes. Programmer
errors and impossible states should terminate the process so the Rust supervisor
can replace untrusted state.

Include safe diagnostic context: operation name, session id, request id, byte
lengths, and known enum values. Do not include credentials, raw user text, raw
tool arguments, file contents, or sensitive policy-controlled data. Preserve
original errors as `cause` where useful.

Never leave an empty `catch` block. Every promise is awaited or has a `.catch`
handler. Process-level `unhandledRejection` and `uncaughtException` handlers
log safely, notify monitoring when possible, and let untrusted state terminate.

## 5. Security Rules

The extension is a trust-boundary courier, not a policy engine. It forwards
authorization requests to the Rust service and enforces the returned verdict. It
does not invent local allow rules.

The blocking authorization path fails closed. If the service is unreachable,
times out, returns malformed data, or cannot prove an allow verdict, block the
tool call and emit a safe monitoring record.

Do not use `eval`, `new Function`, or equivalent dynamic execution. Do not load
modules from user-controlled or model-controlled names. Dynamic imports are
allowed only from literal allowlists in source.

Do not construct shell command strings. Represent tools and arguments as
structured data, validate them, and let the policy gate decide whether execution
is allowed.

Regular expressions over untrusted input must be simple, bounded, and tested
with pathological input. Prefer schemas or parsers over complex regexes.

Secrets come from environment or runtime configuration, never from committed
source. Do not print secrets through logs, errors, test snapshots, or monitoring
payloads.

## 6. Async, Timeouts, and Backpressure

Hook code must be short and bounded. Do not do CPU-heavy inspection, large
synchronous parsing, blocking filesystem work, or long retry loops on the event
loop.

Every socket call has an explicit timeout. Authorization timeouts block the
tool call. Monitoring timeouts are recorded when possible.

Handle backpressure deliberately. Bound outgoing queues, cap message sizes, and
define whether work is dropped, retried, or blocked when the Rust service is
down.

## 7. Logging and Monitoring

Use structured JSON logs on `stdout`. Application code does not write logs to
files, databases, or external services.

Every log entry includes at least `level`, `timestamp`, `msg`, and relevant
correlation fields. Use `sessionId`, `requestId`, `traceId`, `toolCallId`, and
`policyDecisionId` when present.

Use levels consistently:

| Level | Use |
|---|---|
| `error` | Cannot recover without intervention |
| `warn` | Recoverable problem or blocked unsafe input |
| `info` | Lifecycle, verdict, and forwarding milestones |
| `debug` | Development-only diagnostic detail |

Never log credential values, raw user messages, raw tool arguments, file
contents, or sensitive policy-controlled data. Log shapes, field names, byte
lengths, hashes, and safe identifiers instead.

## 8. Testing

Tests describe behavior in their names:
`blocks_tool_call_when_verdict_socket_times_out`.

Each test should:

- arrange only the state it needs
- act through the public behavior of the unit
- assert one observable outcome
- avoid shared mutable state
- replace sockets, clocks, filesystem, process APIs, and loggers with fakes
  unless that boundary is the subject under test

Security-critical coverage includes allow verdicts, deny verdicts, verdict
timeouts, malformed verdicts, socket disconnects, malformed tool-call payloads,
event forwarding, redaction, and no side effect when authorization blocks.

## 9. Package and Tooling

Target Node.js 20 or newer. Commit the package lockfile. CI and releases install
from the lockfile, not floating dependency resolution.

Keep runtime dependencies few and justified, especially on hook, validation,
logging, and socket paths. Development-only dependencies must not be imported by
runtime extension code.

Use Prettier for formatting and ESLint for static checks. Treat lint errors as
blocking. Suppress a rule only with an inline comment that explains why the
suppression is safe.
