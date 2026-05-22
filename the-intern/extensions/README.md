# the-intern/extensions

TypeScript extensions for the pi-agent coding agent. This package hosts the
**bob extension** (`bob.ts`), which is the event-forwarding membrane described
in S-003.

---

## Naming Convention: bob service vs bob extension

These two components share the name "bob" deliberately — the extension exists
only to talk to the service — but they are **distinct artifacts**:

| | bob service | bob extension |
|---|---|---|
| **Artifact** | Rust binary `bob` | TypeScript file `bob.ts` |
| **Location** | `the-intern/service/` | `the-intern/extensions/` |
| **Runtime** | Managed by the OS / systemd / docker | Loaded inside each `pi` process by pi's own extension loader |
| **Lifecycle** | Long-running server process | One instance per `pi` session, torn down with the pi process |
| **Install path** | System PATH or container image | pi's extension search path (see below) |

The bob service spawns `pi` processes and controls their environment. The bob
extension runs *inside* those pi processes and uses the environment variables
set by the bob service to connect back to it.

---

## Environment-Variable Contract

The bob service supervisor sets these two variables on every `pi` child process
it spawns. The bob extension reads them at load time; they are the sole
communication channel between the two components at startup.

### `BOB_SESSION_ID`

- **Type:** string, REQUIRED
- **Format:** Serialised form of `bob_core::types::SessionId` — a UUID string
  as currently produced by the supervisor.
- **Purpose:** Tags every event frame the bob extension writes to the UDS socket
  with the session identity. The bob service's multiplexer routes inbound frames
  by exact match on this value.
- **Absence behaviour:** If this variable is missing, the bob extension logs one
  warning line and becomes a no-op for the remainder of the session. The bob
  service never fails to spawn `pi` because of a missing value; it omits the
  variable instead, which produces the same "no events forwarded" outcome.

### `BOB_EXTENSION_SOCK_PATH`

- **Type:** string (filesystem path), REQUIRED
- **Format:** Absolute path to the `extension.sock` Unix domain socket that the
  `extension-ipc` actor binds.
- **Purpose:** The bob extension opens a UDS connection to this path on the first
  event it intercepts.
- **Absence behaviour:** Same as `BOB_SESSION_ID` — one warning, then no-op.

### `BOB_AUTHZ_TIMEOUT_MS`

- **Type:** string (positive integer), OPTIONAL
- **Format:** Decimal integer representing milliseconds, e.g. `"3000"`.
- **Purpose:** Configures the maximum time the blocking `tool_call` authz hook
  waits for a `AuthzVerdict` frame from the bob service before failing closed.
  When absent, the built-in default of **5000 ms** is used.
- **Fail-closed behaviour:** If no verdict arrives within the timeout, the tool
  call is blocked (not allowed to proceed) and one warning is logged.  The
  session continues; subsequent tool calls each get their own fresh timeout.

An operator can verify the contract by inspecting the environment of any running
`pi` process that was spawned by `bob serve`:

```sh
cat /proc/<pi-pid>/environ | tr '\0' '\n' | grep -E '^BOB_'
```

---

## Installation

The bob extension is shipped as source only. No npm publish, no build
artifact, no `pi install` command is invoked by the bob service itself. An
operator places the extension into one of pi's own discovery directories.

### Install Paths

| Scope | Path | When to use |
|---|---|---|
| Per-user (global) | `~/.pi/agent/extensions/bob.ts` | The extension should apply to all projects on this machine |
| Per-project | `<project>/.pi/extensions/bob.ts` | The extension should apply only within one project directory |

Both paths are pi's own discovery directories; the bob service plays no role in
extension discovery or loading.

**Example — per-user install:**

```sh
mkdir -p ~/.pi/agent/extensions
cp /path/to/the-intern/extensions/bob.ts ~/.pi/agent/extensions/bob.ts
```

**Example — per-project install (run from the project root):**

```sh
mkdir -p .pi/extensions
cp /path/to/the-intern/extensions/bob.ts .pi/extensions/bob.ts
```

### Running Without the Extension

Installing the bob extension is **optional**. If `bob.ts` is not in any pi
discovery directory, `bob serve` runs unchanged: prompts reach pi over
`runRpcMode()`, tool calls execute, and no event-forwarding observability is
added. The bob service emits no error and behaves identically to a pre-Phase-3
deployment.

---

## Policy-Control: Blocking tool_call Authorization Hook

The bob extension registers a **blocking** `tool_call` handler with pi-agent.
Before any tool executes, the handler:

1. Sends an `Authz` frame to the bob service over `extension.sock`:
   ```json
   {"kind":"authz","session":"<BOB_SESSION_ID>","tool":"<tool-name>","arguments":{...}}
   ```
2. Awaits a matching `AuthzVerdict` frame on the same socket:
   ```json
   {"kind":"authz_verdict","session":"<BOB_SESSION_ID>","verdict":"allow"}
   ```
   or
   ```json
   {"kind":"authz_verdict","session":"<BOB_SESSION_ID>","verdict":"block"}
   ```
3. Returns the verdict to pi: `allow` permits the call, `block` denies it.

### Fail-closed semantics

If any of the following occur, the tool call is **blocked** and one warning is
logged.  The pi session continues; the tool simply does not run.

| Failure condition | Result |
|---|---|
| No verdict within `BOB_AUTHZ_TIMEOUT_MS` (default 5 000 ms) | block + warn |
| Verdict frame is not valid JSON | block + warn |
| Verdict field is neither `"allow"` nor `"block"` | block + warn |
| UDS transport error or connection closed | block + warn |

---

## Connect-Window Pipelining vs Retry/Backoff Buffering

### What the spec says

S-003 specifies **no buffering**: when a lost-connection window occurs, frames
are dropped silently. There is no retry queue, no exponential back-off, and no
attempt to replay events that were lost while the transport was down.

### What the implementation does — and why it is not the same thing

`bob.ts` uses a `pendingFrames` array that holds frames during the **in-flight
first connect**. This is a *connect-window pipeline buffer*, not a retry buffer:

- **Scope:** The buffer is active only from the moment the first event fires
  (triggering a `net.createConnection` call) until the UDS `connect` callback
  fires — a window measured in single-digit milliseconds under normal conditions.
- **No retry:** If the connect fails (e.g. `ENOENT`, `ECONNREFUSED`), the
  buffer is discarded immediately and the transport is marked dead. No replay,
  no reconnect attempt.
- **No post-failure queue:** Once the transport is dead the buffer is gone.
  Every subsequent event is silently dropped — exactly as S-003 requires.

The distinction is:

| Behaviour | Connect-window pipelining | Retry/backoff buffering |
|---|---|---|
| **When active** | During initial UDS connect only | After a failure, while waiting to reconnect |
| **On connect failure** | Buffer discarded, transport dead | Buffer retained for replay |
| **Spec compliance** | Compatible with S-003 | Prohibited by S-003 |

### Bound on the buffer (B-003)

Without a cap, `pendingFrames` could grow without bound if the bob service is
slow to accept the connection — a real memory-growth risk under bursty load.
B-003 tracked this defect. The fix introduces `PENDING_FRAMES_CAP = 64`: if the
queue reaches 64 frames before the connect callback fires, the transport is
killed immediately (one warning, then silent no-op) rather than buffering
further. This keeps the pre-connect window finite and bounded regardless of
event rate.

---

## pi-agent Package Compatibility

The bob extension is tested against `@earendil-works/pi-coding-agent`
**version 0.75.3** only. This is the only supported pi-agent API version
until a future task updates the compatibility record.

### Incompatibility signal

Running `npm test` in this directory will fail immediately with a descriptive
error if a version other than **0.75.3** is installed:

```
INCOMPATIBLE pi-agent version detected.
  Installed:  <detected version>
  Supported:  0.75.3
```

This check lives in `pi-agent-compat.test.ts`. Other installed versions are
**unsupported** until both the test and this documentation are updated to
reflect the new tested version.

### Updating the compatibility record

When a new pi-agent version is to be adopted:

1. Install the new version: `npm install @earendil-works/pi-coding-agent@<new-version>`.
2. Run `npm test` and check whether any events are missing from or extra in
   `PI_EVENTS` in `bob.ts`. The AC-3 test will report the exact discrepancies.
3. Update `PI_EVENTS` and the handler registrations in `bob.ts` as needed.
4. Update `SUPPORTED_PI_AGENT_VERSION` in `pi-agent-compat.test.ts`.
5. Update the version references in this file and in the root `README.md`.

---

## Development

This is a pure TypeScript package with no runtime dependencies. Everything
listed in `devDependencies` is used during development and testing only.

```sh
npm install       # install dev-deps
npx tsc --noEmit  # type-check without emitting JS (pi uses jiti for source-level loading)
npm test          # run vitest
```

TypeScript is configured with strict mode and targets ESNext/NodeNext. The
extension code uses `node:net` for the UDS connection; no external networking
library is required.
