# Node.js Coding Guidelines

These conventions apply to the TypeScript extension that runs inside each
pi-agent process. They are prose only; tool configs belong with the
implementation when the extension package exists.

---

## 1. Source Layout and Module Naming

The extension lives under `the-intern/extensions/` and targets Node.js 20 or
newer. TypeScript is the default source language because the architecture keeps
this as the only TypeScript surface in the system. Plain JS is reserved
for generated output or upstream artifacts if they are ever needed.

Entry points are thin. They register pi-agent hooks, initialize logging,
validate configuration, connect to the Rust service socket, and delegate to
modules grouped by responsibility: `hooks/`, `monitoring/`, `policy-client/`,
`schemas/`, and `skills/`.

Module file names are `kebab-case` and describe one clear responsibility:
`tool-call-hook.ts`, `verdict-socket.ts`, `event-forwarder.ts`. Avoid barrel
re-exports that obscure where a symbol originates. A file that exceeds about
300 lines is a signal to split it.

Internal modules use relative imports. Do not use path aliases that require
bundler configuration; keep the import graph resolvable by Node.js and the
chosen TypeScript build without special runtime hooks.

## 2. Identifier Naming Conventions

| Kind | Convention | Example |
|---|---|---|
| Variables and functions | `camelCase` | `sendVerdict`, `sessionId` |
| Classes and types | `PascalCase` | `SocketClient`, `ToolCallHook` |
| Constants, module-level and never reassigned | `SCREAMING_SNAKE_CASE` | `MAX_RETRY_COUNT` |
| Files and directories | `kebab-case` | `event-forwarder.ts` |

Prefer descriptive full words over abbreviations unless the abbreviation is
universally understood (`url`, `id`, `rpc`). Boolean variables and functions are
prefixed with `is`, `has`, or `can`: `isAuthorized`, `hasActiveSession`.

## 3. Interface Contracts and Runtime Validation

TypeScript types do not validate runtime data. Define schemas for every message
crossing the extension boundary: pi-agent `tool_call` payloads, verdict socket
requests, verdict responses, monitoring events, socket errors, and skill
metadata.

Validate as early as possible and fail closed. A malformed tool-call request,
malformed verdict, missing session identifier, invalid user identity, or
unknown action shape blocks the tool call and emits a safe monitoring event.

Schemas should constrain payload size, required identifiers, enum values,
argument shapes, and redaction behavior. Treat all model-originated tool
arguments as untrusted even when they arrive through pi-agent APIs.

## 4. Error Handling

Throw typed `Error` subclasses, not plain objects or string literals. Define one
subclass per failure domain: `SocketConnectionError`, `VerdictTimeoutError`,
`MalformedVerdictError`. Include the operation that failed and the safe
identifiers needed for diagnosis.

Do not mix thrown errors with result objects in the same codebase layer. Async
functions in the extension throw on failure and return the resolved value on
success. Callers use `try/catch`; they do not check a `result.ok` flag unless
they are at a protocol boundary that explicitly models allow/block.

Distinguish operational errors from programmer errors. Operational errors such
as verdict timeout, socket disconnect, or rejected payload become explicit
block/audit outcomes. Programmer errors and unknown extension state are fatal to
the session process so the Rust supervisor can replace it.

The blocking authorization path fails closed. If Policy Control is unreachable,
times out, returns malformed data, or cannot prove an allow verdict, the hook
returns a block result and emits a monitoring record.

Never swallow errors with an empty `catch` block. If a failure is truly safe to
ignore, add a comment explaining why. Include original errors as `cause` where
useful:

```ts
throw new SocketConnectionError(
  `failed to connect to verdict socket for session ${sessionId}`,
  { cause: originalError }
);
```

Unhandled promise rejections are bugs. Every `Promise` chain or `async`
function is either `await`-ed or has a `.catch` handler attached. Register
process-level `unhandledRejection` and `uncaughtException` handlers that log
safely, notify monitoring when possible, and let untrusted state terminate.

## 5. Logging Conventions

Use a structured logger that emits JSON lines to `stdout`. Application code does
not route logs to files, databases, or external services; the runtime
environment handles routing.

Each log entry carries at minimum `level`, `timestamp`, `msg`, and relevant
correlation fields. Include `sessionId`, `requestId` or `traceId`,
`toolCallId`, and `policyDecisionId` when present. Propagate
those identifiers through socket messages and monitoring events.

Additional fields are `camelCase` key-value pairs that describe the event
without exposing sensitive content.

| Level | When to use |
|---|---|
| `error` | A condition the extension cannot recover from without intervention |
| `warn` | A recoverable problem such as retry exhaustion or malformed input |
| `info` | Significant lifecycle events, verdicts, and forwarding milestones |
| `debug` | Detailed tracing data useful during development |

Never log credential values, raw user message text, raw tool arguments, file
contents, or data classified as sensitive by Policy Control. Log payload shape,
field names, byte lengths, hashes, and safe identifiers instead.

## 6. Security Rules

The extension is a trust-boundary courier, not a policy engine. It forwards
requests to the Rust service and enforces the returned verdict; it does not
invent authorization rules locally.

Do not use evaluated code: no `eval`, `new Function`, or equivalent dynamic
execution. Do not load modules from user-controlled or model-controlled names.
Dynamic imports are allowed only from literal allowlists defined in source.

Do not construct shell command strings. If extension code ever has to describe
or prepare action invocations, represent tools and arguments as structured data
and enforce allowlists before anything reaches pi-agent's `bash` tool.

Regular expressions used on untrusted input must be simple, bounded, and covered
by tests for pathological input. Prefer parser or schema validation over complex
regexes for message and argument validation.

Secrets come from environment or runtime configuration, never from committed
source. Do not print secrets through logs, error messages, test snapshots, or
monitoring payloads.

## 7. Event Loop, Timeouts, and Backpressure

Hook code must stay short and bounded. Do not perform CPU-heavy inspection,
large synchronous parsing, blocking filesystem work, or long retries in the
event loop. Defer heavy work to the Rust service or a dedicated process.

All socket calls have explicit timeouts. Timeout behavior is deterministic:
authorization timeouts block the tool call, monitoring timeouts are recorded
when possible, and reconnect attempts use bounded retry policies.

Handle socket backpressure explicitly. Bound outgoing queues, cap message
sizes, and define what is dropped, retried, or blocked when the Rust service is
down.

## 8. Testing Conventions

Unit tests live adjacent to the module they test, in a sibling file or a
`__tests__/` subdirectory. Integration tests that exercise the hook against a
stubbed socket go in the extension test directory.

A good test:

- Has a descriptive name that states the condition and expected outcome:
  `blocks_tool_call_when_verdict_socket_returns_deny`.
- Uses a clear arrange, act, assert structure.
- Constructs its own fixtures; no shared mutable state between tests.
- Replaces network, filesystem, clock, and process access with in-process fakes
  or stubs unless that boundary is the subject under test.
- Asserts one observable behavior per test. If a test has five unrelated
  assertions, split it into five tests.

Security-critical coverage must include allow verdict, deny verdict, verdict
timeout, malformed verdict, socket disconnect, malformed tool-call payload,
event forwarding, redaction, and no real side effect when authorization blocks.

Do not select a specific test runner here; use whatever tooling the project
settles on. The conventions above apply regardless of runner choice.

## 9. Package and Runtime Hygiene

Commit the package lockfile when the extension package is introduced. CI and
release builds install from the lockfile, not from floating dependency
resolution. Keep dependency count low, especially on hook, validation, logging,
and socket paths.

Use a maintained Node.js LTS-compatible runtime at or above the architecture's
Node.js 20 baseline. Production runs set production environment mode and avoid
loading development-only dependencies.

Add dependency vulnerability checks and no-secret scanning when package metadata
exists. A dependency used only for development must not be required by runtime
extension code.

## 10. Formatter and Linter

**`prettier`** enforces consistent formatting automatically across TypeScript
and JS files. Run it before every commit.

**`eslint`** provides static analysis for common mistakes and security rules:
unused variables, missing `await`, unsafe dynamic code, suspicious regexes,
unsafe child-process usage, and accidental floating promises. Configure it for
Node.js, TypeScript, and the chosen module system. Treat lint errors as
blocking; suppress a rule only with an inline comment explaining why the
suppression is safe.
