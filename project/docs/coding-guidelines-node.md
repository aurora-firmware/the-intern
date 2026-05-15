# Node.js Coding Guidelines

These conventions apply to the JS extension that runs inside each pi-agent
process. They are prose only — no tool configs are checked in as part of this
document.

---

## 1. Source Layout and Module Naming

The extension lives in a single package under `extension/`. Entry point is
`extension/index.js` (or `index.ts` if TypeScript is adopted). Related code is
grouped into subdirectories by responsibility: `hooks/`, `monitoring/`, `skills/`.

Module file names are `kebab-case` and describe one clear responsibility:
`tool-call-hook.js`, `verdict-socket.js`, `event-forwarder.js`. Avoid barrel
re-exports that obscure where a symbol originates. A file that exceeds ~300 lines
is a signal to split it.

Internal modules use relative imports (`../monitoring/event-forwarder`). Do not
use path aliases that require bundler configuration; keep the import graph
resolvable by Node.js without a build step where possible.

## 2. Identifier Naming Conventions

| Kind | Convention | Example |
|---|---|---|
| Variables and functions | `camelCase` | `sendVerdict`, `sessionId` |
| Classes | `PascalCase` | `SocketClient`, `ToolCallHook` |
| Constants (module-level, never reassigned) | `SCREAMING_SNAKE_CASE` | `MAX_RETRY_COUNT` |
| Files and directories | `kebab-case` | `event-forwarder.js` |

Prefer descriptive full words over abbreviations unless the abbreviation is
universally understood (`url`, `id`, `rpc`). Boolean variables and functions are
prefixed with `is`, `has`, or `can`: `isAuthorized`, `hasActiveSession`.

## 3. Error Handling

Throw typed `Error` subclasses, not plain objects or string literals. Define one
subclass per failure domain: `SocketConnectionError`, `VerdictTimeoutError`. This
makes `catch` blocks explicit about what they handle and leaves other error types
to propagate.

Do not mix thrown errors with result objects in the same codebase layer. Choose
one style at each boundary and document it: async functions in the extension
throw on failure and return the resolved value on success. Callers use
`try/catch`; they do not check a `result.ok` flag.

Never swallow errors with an empty `catch` block. If a failure is truly safe to
ignore, add a comment explaining why. Include context in every error message: the
operation that failed, the relevant input, and — where useful — the original
error as `cause`:

```js
throw new SocketConnectionError(
  `failed to connect to monitoring socket at ${socketPath}`,
  { cause: originalError }
);
```

Unhandled promise rejections are bugs. Every `Promise` chain or `async` function
is either `await`-ed or has a `.catch` handler attached.

## 4. Logging Conventions

Use a structured logger that emits JSON lines (one object per entry) to `stdout`.
Each log entry carries at minimum: `level`, `timestamp` (ISO-8601), `msg`, and
`sessionId` where applicable. Additional fields are `camelCase` key-value pairs
that describe the event without exposing sensitive content.

Level guidance:

| Level | When to use |
|---|---|
| `error` | A condition the extension cannot recover from without intervention |
| `warn` | A recoverable problem (retry exhausted, unexpected field in response) |
| `info` | Significant lifecycle events (hook registered, verdict received, session end) |
| `debug` | Detailed tracing data useful during development |

Never log credential values, raw user message text, or data classified as
sensitive by Policy Control. Log the structure of a payload (field names, byte
lengths) rather than its contents.

## 5. Testing Conventions

Unit tests live adjacent to the module they test, in a sibling file or a
`__tests__/` subdirectory. Integration tests that exercise the hook against a
stubbed socket go in `extension/tests/`.

A good test:

- Has a descriptive name that states the condition and expected outcome:
  `blocks_tool_call_when_verdict_socket_returns_deny`.
- Constructs its own fixtures; no shared mutable state between tests.
- Replaces network and filesystem access with in-process fakes or stubs. The
  socket client is injected so tests never open a real socket.
- Asserts one observable behavior per test. If a test has five unrelated
  assertions, split it into five tests.

Do not select a specific test runner here; use whatever tooling the project
settles on. The conventions above apply regardless of runner choice.

## 6. Formatter and Linter

**`prettier`** — enforces consistent formatting automatically across JS/TS files.
It eliminates style debates and keeps diffs focused on logic. Run it before every
commit.

**`eslint`** — static analysis for common mistakes and style rules not covered by
formatting (unused variables, unsafe `eval`, missing `await`). Configure it with
rules appropriate to Node.js and the chosen module system. Treat lint errors as
blocking; suppress a rule only with an inline comment that explains why the
suppression is safe.
