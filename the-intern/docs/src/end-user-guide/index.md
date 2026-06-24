# End-User Guide

This guide is for anyone who has `bob` installed and wants to use it to drive
the Intern service. It covers what each subcommand does and walks through
concrete examples so you know what to expect.

If you need to install `bob` or configure the runtime directory, see the
[Operator & Deployer Guide](../operator-guide/index.md). If you want a full
listing of every flag and option, see the [CLI Reference](../cli-reference/index.md).

---

## Quick orientation

`bob` communicates with a running Intern service over a Unix socket. Before
running any subcommand other than `serve`, you need a service instance already
listening. Point `bob` at the right socket with the `BOB_ADMIN_SOCK_PATH`
environment variable, or rely on the default path if you started the service
without overrides.

```bash
# Tell bob where to find the running service
export BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock"
```

---

## `bob serve`

Start the Intern service in the foreground.

Use `bob serve` when you want to bring up a fresh service instance — either for
day-to-day use or for an isolated testing session. The service listens on an
admin socket and an extension socket, runs the pi-agent supervisor, and accepts
connections from other `bob` subcommands.

**Example — start an isolated session:**

```bash
export BOB_TEST_RUNTIME_DIR="$(mktemp -d)"
BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock" \
BOB_EXTENSION_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/extension.sock" \
bob serve
```

The service logs startup progress to stdout and stays in the foreground. Press
Ctrl-C (SIGTERM) to stop it. During shutdown the supervisor reaps any live
pi-agent child processes and removes the socket files before exiting.

---

## `bob status`

Report whether the service is up and what version is running.

Use `bob status` to do a quick health check — to confirm the service is
accepting connections, to see the reported version, or to measure uptime.

**Example — human-readable status:**

```bash
bob status
```

Output:

```
ok: true
version: 0.3.0
uptime_seconds: 42
```

**Example — JSON output for scripting:**

```bash
bob status --json
```

Output:

```json
{"ok":true,"uptime_seconds":42,"version":"0.3.0"}
```

---

## `bob sessions`

List active sessions or forcibly end one.

Use `bob sessions list` to see which chat or work sessions are currently open.
Use `bob sessions kill <id>` when a session is stuck or you want to reclaim
resources without restarting the whole service.

**Example — list sessions:**

```bash
bob sessions list
```

Output (one session ID per line):

```
session-abc123
session-def456
```

**Example — list sessions as JSON:**

```bash
bob sessions list --json
```

Output:

```json
["session-abc123","session-def456"]
```

**Example — end a session:**

```bash
bob sessions kill session-abc123
```

Output:

```
killed: session-abc123
```

---

## `bob audit`

Stream the live audit log to your terminal.

Use `bob audit tail` to watch what the service is doing in real time — incoming
events, submitted reports, and policy verdicts all appear as they are recorded.
You can narrow the stream to one or more kinds with `--filter`.

Accepted filter values: `events`, `reports`, `verdicts`.

**Example — tail all audit output:**

```bash
bob audit tail
```

Notifications arrive as JSON objects, one per line, until you press Ctrl-C.

**Example — watch only policy verdicts:**

```bash
bob audit tail --filter verdicts
```

**Example — watch events and reports together:**

```bash
bob audit tail --filter events --filter reports
```

---

## `bob policy`

Signal the service to reload its policy rules from disk.

Use `bob policy reload` after you have edited the policy configuration file and
want the change to take effect without restarting the service. The service
re-reads the rules and applies them to all subsequent requests.

**Example:**

```bash
bob policy reload
```

Output:

```
policy reloaded
```

**Example — JSON confirmation:**

```bash
bob policy reload --json
```

Output:

```json
{"ok":true}
```

For details on the policy file format and where it lives, see the
[Operator & Deployer Guide](../operator-guide/index.md).

---

## `bob chat`

Open a supervised interactive pi session in your terminal.

`bob chat` is a front end to a running `bob serve` process. It asks the service
to start an interactive `pi` child and attaches your terminal's standard input,
output, and error streams to that child. The resulting interface is pi's own
interactive session, not a line-oriented bob REPL.

The service owns and supervises the pi process. It assigns the session id,
configures the extension socket, loads the bob extension, exposes the session
through `bob sessions list`, and reaps it on exit. The extension's blocking
`tool_call` authorization hook remains active throughout the session.

Before running `bob chat`:

1. Install `bob.ts` at the configured extension path as described in the
   [Operator & Deployer Guide](../operator-guide/index.md#install-the-bob-extension).
2. Start `bob serve` and leave it running.
3. Set `BOB_ADMIN_SOCK_PATH` in the client shell if the service uses a socket
   override.

**Example — start a new chat:**

```bash
bob chat
```

Use pi normally. When the pi process exits, `bob chat` exits too.

If the service is not reachable, `bob chat` exits non-zero with an error such
as:

```text
bob service is not running — cannot reach admin socket at <path>
```

It does not fall back to launching an unsupervised pi process. Check that
`bob serve` is running and that both shells resolve the same admin socket path.
