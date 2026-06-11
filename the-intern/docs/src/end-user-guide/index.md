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

Open an interactive chat session with the Intern.

`bob chat` opens a chat subscription and then reads lines from stdin. Each line
is sent to the service as a `chat.send` request. Replies delivered by the
service arrive as `chat.message` notifications and are printed to stdout as they
come in — send and receive happen concurrently on the same connection. Press
Ctrl-C or close stdin (Ctrl-D) to end the session.

Each message you send carries a self-asserted application identity (a UUID
configured as `chat_application_identity`). The service uses this identity for
pre-flight admission checks and policy decisions before the message reaches the
request queue. This design is described at the architecture level in ADR-005;
as a user you only need to know that your `bob.toml` controls which identity
is presented on your behalf.

Use `bob chat` when you want to converse directly with the Intern from the
command line. Use `--session` to associate messages with a specific conversation
context.

**Example — start a new chat:**

```bash
bob chat
```

Type a message and press Enter. Press Ctrl-C to close the session.

**Example — attach to an existing conversation context:**

```bash
bob chat --session session-abc123
```

`--session` sets the `context_id` carried by every `chat.send` request on this
session. The service uses it to route messages to the right conversation
context. Omitting `--session` sends messages without a context id, which is
fine for a fresh conversation.

**Example — pipe input non-interactively:**

```bash
echo "Summarise the last three commits" | bob chat
```

`bob chat` sends the line and exits when stdin closes.

**Example — JSON output for downstream processing:**

```bash
bob chat --json
```

With `--json`, each notification from the service is printed as a single JSON
object on its own line. The output is the data payload extracted from the
notification, for example:

```json
{"text":"<reply text>"}
```

This makes the output easy to parse with `jq` or a script. The full wire-level
notification shape (including `params.subscription` and `params.data`) is
documented in the Wire contract section below.

**Wire contract**

`chat.open` is sent without parameters when the session starts. The service
returns a subscription id that is used automatically for the rest of the
session.

Each `chat.send` request carries:

| Field | Required | Description |
|---|---|---|
| `id` | yes | Subscription id from `chat.open` |
| `text` | yes | The message text typed by the user |
| `application_identity` | yes | UUID identifying the sending application (from `bob.toml`) |
| `context_id` | no | Conversation context; set by `--session` |

**Current limitation — reply generation requires Phase 2**

The push channel is in place: `chat.message` notifications are delivered to the
subscribing client whenever a reply is injected at the service's delivery
interface. However, the component that generates replies (the pi-agent prompt
pipeline, roadmap Phase 2) has not yet landed. In production today, `bob chat`
sends messages successfully and the service accepts them, but no reply is
produced and nothing is printed. Only tests exercise the full round-trip by
injecting replies directly at the service boundary.

Once the Phase 2 pipeline is integrated, replies will appear automatically
without any change to the `bob chat` command or its flags.
