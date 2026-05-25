# Operator & Deployer Guide

This guide is for anyone who installs, configures, runs, and observes `bob` in a
real environment. It covers prerequisites, building the binary, socket layout,
configuration, the audit log, policy basics, and how to stop the service cleanly.

For how to use `bob` subcommands once the service is up, see the
[End-User Guide](../end-user-guide/index.md).
For the architectural rationale behind the service design, see the
[Architecture Overview](../architecture-overview/index.md).

---

## Prerequisites

### Rust toolchain

The Rust toolchain is pinned in `the-intern/service/rust-toolchain.toml`:

```toml
[toolchain]
channel = "stable"
components = ["rustfmt", "clippy"]
```

`rustup` reads this file automatically and installs the pinned channel the first
time you build. You do not need to set the toolchain version yourself.

Verify your Rust installation:

```bash
rustc --version
cargo --version
```

### `pi` binary on PATH

The `pi` binary (the pi-agent process) is a **hard precondition** for `bob` to
run. The supervisor spawns `pi` child processes for every session; without it the
service will not start.

Verify the binary is reachable:

```bash
which pi
```

If `which pi` returns a path, you are ready to proceed.

**If `pi` is missing: stop here and escalate.** Do not substitute a mock, a
script wrapper, or any other stand-in. `pi` must be the genuine pi-agent binary
on `PATH` before you continue.

---

## Build and install

Build the `bob` binary from the Rust workspace:

```bash
cd the-intern/service
cargo build -p bob
```

The debug binary lands at:

```
the-intern/service/target/debug/bob
```

For a release build:

```bash
cargo build -p bob --release
```

The release binary lands at:

```
the-intern/service/target/release/bob
```

Add the relevant `target/` subdirectory to your `PATH`, or copy the binary to a
location already on `PATH`.

---

## Runtime layout

`bob serve` binds two Unix domain sockets. Where they land depends on how you
configure the runtime directory.

### Default socket paths

On Linux the defaults follow XDG conventions:

```
$XDG_RUNTIME_DIR/bob/admin.sock
$XDG_RUNTIME_DIR/bob/extension.sock
```

On macOS the defaults use `$TMPDIR`:

```
$TMPDIR/bob-$UID/admin.sock
$TMPDIR/bob-$UID/extension.sock
```

The socket directory is created with mode `0700`; the sockets themselves use
mode `0660`.

### Isolating a session with `BOB_TEST_RUNTIME_DIR`

For development or testing, set `BOB_TEST_RUNTIME_DIR` to point both sockets at
a temporary directory:

```bash
export BOB_TEST_RUNTIME_DIR="$(mktemp -d)"
echo "$BOB_TEST_RUNTIME_DIR"
```

Then start the service with explicit socket paths derived from that variable:

```bash
BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock" \
BOB_EXTENSION_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/extension.sock" \
bob serve
```

### Overriding socket paths directly

You can override the socket paths without using `BOB_TEST_RUNTIME_DIR`:

```bash
# Move the admin socket to a custom path
export BOB_ADMIN_SOCK_PATH="/run/myservice/bob-admin.sock"

# Move the extension socket to a custom path
export BOB_EXTENSION_SOCK_PATH="/run/myservice/bob-ext.sock"
```

Both `BOB_ADMIN_SOCK_PATH` and `BOB_EXTENSION_SOCK_PATH` are respected at
startup. Any override path must lie under a directory that the service can
create with mode `0700`.

Client subcommands (`bob status`, `bob sessions`, etc.) resolve the admin socket
path using the same environment variables, so set `BOB_ADMIN_SOCK_PATH` in the
shell where you run client commands too.

---

## Channel configuration

`bob serve` can run multiple channel adapters. Currently the interactive-chat
channel is the only implemented adapter; others (email, webhook, scheduler) are
planned for later phases.

The channel configuration lives in the `[channels]` section of bob's TOML config
file (see [ADR-002](../../project/decisions/ADR-002-bob-configuration-format-toml-via-figment.md)
for the format choice). The default config file path is:

- Linux: `$XDG_CONFIG_HOME/bob/config.toml` (falls back to `~/.config/bob/config.toml`)
- macOS: `~/Library/Application Support/bob/config.toml`

### Chat channel

The chat channel is **enabled by default**. To disable it, add a
`[channels.chat]` section to your TOML config:

```toml
[channels.chat]
enabled = false
```

When `enabled = false`, `bob serve` skips starting the chat adapter at startup.
Existing `bob chat` connections will fail to subscribe. Set `enabled = true` (or
omit the section entirely) to restore normal operation.

---

## Audit log

`bob` writes an append-only JSONL audit log. Each line is one JSON object
representing one audit record.

### What is recorded

The audit log captures three kinds of records:

- **`event`** — pi-agent extension events forwarded from running sessions.
- **`verdict`** — policy verdicts: whether a pre-flight admission check or a
  `tool_call` authorization request was allowed or blocked.
- **`report`** — external action reports submitted via `report.submit` on
  `admin.sock`.

### Where the log lives

The default path follows XDG state conventions:

- Linux: `$XDG_STATE_HOME/bob/audit.jsonl` (falls back to `~/.local/state/bob/audit.jsonl`)
- macOS: `$XDG_STATE_HOME/bob/audit.jsonl` (falls back to `~/Library/Application Support/bob/audit.jsonl`)

You can override the path in the `[monitoring]` section of your TOML config:

```toml
[monitoring]
audit_log_path = "/var/log/bob/audit.jsonl"
```

If the path or its parent directories do not exist, `bob serve` creates them
with owner-only permissions (`0700`) and fails at startup if the file cannot be
opened for appending.

### Tailing the log live

Use `bob audit tail` to stream records as they arrive:

```bash
export BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock"
bob audit tail
```

Narrow the stream to one or more record kinds:

```bash
bob audit tail --filter verdicts
bob audit tail --filter events --filter reports
```

Accepted filter values: `events`, `reports`, `verdicts`. Without `--filter`, all
kinds are shown.

You can also configure which kinds appear in live tail streams by default via
`default_tail_filters` in the `[monitoring]` section:

```toml
[monitoring]
default_tail_filters = ["events", "verdicts"]
```

Records are always written to disk regardless of filter settings; filters only
affect what is delivered to live subscribers.

---

## Policy basics

`bob` applies two deterministic authorization gates to every request. Both are
evaluated by the `policy-control` subsystem against an in-memory ruleset loaded
from your TOML config. The default behavior when no `[policy]` section is present
is **deny all**.

For the architectural rationale and a detailed description of how the policy
engine works, see the [Architecture Overview](../architecture-overview/index.md).

### Pre-flight admission

When a request enters the queue, `bob` checks the sender's identity against the
`admitted_users` list. Requests from identities not in the list are dropped
before any further processing. A `PreflightDenied` audit record is appended for
each blocked request.

Configure the admitted users in the `[policy]` section:

```toml
[policy]
admitted_users = [
    "00000000-0000-0000-0000-000000000001",
]
```

Each entry is the UUID string form of a `UserId`.

### Tool-call authorization gate

Before a supervised pi-agent session runs a tool, `bob` evaluates the tool name
and arguments against the action allow-list. A tool call is permitted only if an
explicit allow rule matches it; everything else is blocked. This check runs
deterministically inside the service — the agent process cannot influence the
ruleset or the outcome.

Add action rules under `[[policy.action_rules]]`:

```toml
[[policy.action_rules]]
tool = "bash"

[[policy.action_rules]]
tool = "read_file"
```

A rule with no argument matchers allows that tool for any arguments. The model is
allow-only: if a tool is absent from the list, it is denied.

### Reloading policy without restart

After editing the policy section, reload without restarting the service:

```bash
bob policy reload
```

The service re-reads the config file, validates the new ruleset, and atomically
swaps the active snapshot. If validation fails the previous snapshot stays in
force and the command reports the reason.

---

## Shutdown

Send `SIGTERM` (or press Ctrl-C) to initiate a graceful shutdown. The service
runs a six-phase protocol:

1. **Stop accepting new connections.** The admin socket listener and subsystem
   command channels are closed. New connections are rejected.
2. **Cancel subsystem workers.** Actors see their command channels close and
   begin draining.
3. **Drain bounded queues** up to `shutdown_drain_deadline` (default: 30 s).
   In-flight requests that have been accepted are processed; new submissions
   are rejected.
4. **Reap pi-agent children** up to `shutdown_reap_deadline` (default: 10 s).
   The supervisor terminates active session workers first, then warm (idle)
   workers, then sends forced kills to any that have not exited within their
   individual termination deadline.
5. **Flush audit records.** Any audit records queued but not yet written to disk
   are flushed to the JSONL log.
6. **Remove socket files.** Both `admin.sock` and `extension.sock` are deleted
   from disk. A clean exit is logged.

You can tune the drain and reap deadlines in the TOML config:

```toml
shutdown_drain_deadline = "30s"
shutdown_reap_deadline  = "10s"
```

If the process is killed with `SIGKILL` before shutdown completes, socket files
may be left on disk. Remove them manually before restarting:

```bash
rm -f "$BOB_ADMIN_SOCK_PATH" "$BOB_EXTENSION_SOCK_PATH"
```
