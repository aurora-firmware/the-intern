# Operator & Deployer Guide

This guide is for anyone who installs, configures, runs, and observes `bob` in a
real environment. It covers prerequisites, building the binary, socket layout,
configuration, the audit log, policy basics, and how to stop the service cleanly.

New to `bob`? Start with the [Quickstart](../quickstart/index.md) for the
fastest path to a running service. For how to use `bob` subcommands once the
service is up, see the [End-User Guide](../end-user-guide/index.md). For the
architectural rationale behind the service design, see the
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

### Install the bob extension

The bob extension is a required source asset. Bob supplies it directly to every
pi process as `pi --extension <resolved-path>`; do not copy it into pi's own
extension search path and do not run `pi install` for it.

On Linux, install `bob.ts` under the XDG data directory. The default is:

```text
~/.local/share/bob/extensions/bob.ts
```

If `XDG_DATA_HOME` is set, the path is instead
`$XDG_DATA_HOME/bob/extensions/bob.ts`. On macOS, the default is
`~/Library/Application Support/bob/extensions/bob.ts`.

For a source checkout on Linux:

```bash
mkdir -p ~/.local/share/bob/extensions
cp the-intern/pi-extension/bob.ts ~/.local/share/bob/extensions/bob.ts
```

To use another location, set the top-level `extension_path` key in
`config.toml`:

```toml
extension_path = "/opt/bob/extensions/bob.ts"
```

`BOB_EXTENSION_PATH` provides the equivalent environment override. Bob checks
that the resolved path is a regular file before it spawns pi. If the file is
missing, the spawn fails closed and the error names the expected path; bob never
starts a session without its monitoring and authorization extension.

### Remove stale extension copies from pi's own `packages` list

pi loads extensions from two independent sources: the `--extension <path>`
flag bob passes on every spawn, and pi's own `~/.pi/agent/settings.json`
`packages` list. These are additive, not deduplicated against each other. If
`packages` still references an old, manually installed copy of `bob.ts` (for
example from an older manual install, or an extracted release archive left over
from an earlier upgrade), pi loads **two** bob extension instances into the
same session. Both connect to `extension.sock` under the same session id and
both register a blocking `tool_call` hook.

An older `bob.ts` copy cannot parse the current structured verdict frame and
fails closed by design, so its hook blocks every tool call even when the
current instance's hook — and the policy engine — allowed it. The audit log
(`bob audit tail`) shows the contradiction directly: every event and verdict
appears twice, and a `verdict` record with `allow: true` coexists with tool
calls that are still denied in the TUI.

**Fix:** open `~/.pi/agent/settings.json` and remove any entry from
`packages` that points at a `bob.ts` file — bob supplies its own copy via
`--extension` and does not need or expect one listed there. This file is
managed by pi, not by bob; bob never edits it.

**Detection:** as of this fix, bob no longer lets this collision pass
silently. If a second connection registers an already-active session id, the
service emits a `WARN`-level log line naming both connections and records a
`duplicate_extension_connection` audit `event` (visible via `bob audit tail
--filter events`) identifying the collision. Bob flags the collision rather
than refusing the second connection outright, because the service cannot
reliably tell which of the two connections is the stale one, and refusing the
wrong one would leave the session with no working extension at all. Seeing
this signal is itself the actionable sign to remove the stale `packages`
entry above.

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

## Channel adapters and interactive chat

The scheduler is the shipped channel adapter. It starts with `bob serve` and
turns each due entry in the JSON schedule store into a periodic request. There
is no adapter-level enable flag: an empty schedule means the actor remains idle,
and one or more entries make it fire prompts at their configured times. See
[Scheduled jobs](#scheduled-jobs) for the entry format and runtime management
commands.

`bob chat` does not use a channel adapter. It connects to `admin.sock`, calls
the supervised interactive-session RPC, and passes the terminal's standard
file descriptors to the service. The service then starts and owns the
interactive pi process. Interactive chat therefore has no channel-adapter
configuration or subscription path to enable or disable.

Bob's TOML configuration file is located at:

- Linux: `$XDG_CONFIG_HOME/bob/config.toml` (falls back to `~/.config/bob/config.toml`)
- macOS: `~/Library/Application Support/bob/config.toml`

---

## Working directory for pi-agent sessions

`bob` controls the working directory (cwd) each supervised `pi` process runs
in via the service-wide `pi_agent_cwd` config key and, for scheduled jobs, an
optional per-entry `cwd` (see [Scheduled jobs](#scheduled-jobs)). This lets pi
discover project context (`AGENTS.md`/`CLAUDE.md`), skills, and relative
prompt-file paths from a predictable directory instead of whichever directory
`bob serve` happened to be launched from.

### `pi_agent_cwd` (service-wide)

`pi_agent_cwd` is a top-level key in `config.toml` — not nested under any
`[subsystem]` table — that sets the working directory for every `pi` RPC
worker the supervisor spawns for the `bob serve` pool. Today that pool is
exercised by the scheduler, the only shipped channel adapter (see
[Channel adapters and interactive chat](#channel-adapters-and-interactive-chat)):

```toml
pi_agent_cwd = "/srv/workspaces/default"
```

- **Must be absolute.** A relative value fails configuration loading
  immediately with a clear error naming `pi_agent_cwd`.
- **Default: unset.** When `pi_agent_cwd` is not set, RPC workers inherit the
  launch cwd of the `bob serve` process itself — the behavior bob has always
  had. Set it explicitly so pi's context-file discovery, skills, and any
  relative paths in prompts resolve predictably.
- **Existence is not checked at config load.** A `pi_agent_cwd` naming a
  directory that does not exist still loads successfully. A missing directory
  only surfaces later, at worker-spawn time, as a logged (warned) spawn
  failure; for a scheduled firing that would use it, the tick is skipped with
  a warning rather than crashing the service.

### Precedence

When a scheduled job fires, bob resolves the working directory for that run
using this precedence, highest priority first:

1. **Per-entry `cwd`** on the schedule entry, if set (`--cwd` on
   `bob schedule add`; see [Scheduled jobs](#scheduled-jobs)).
2. **Service-wide `pi_agent_cwd`**, if set.
3. **Inherited launch cwd** of the `bob serve` process, if neither of the
   above is set.

A job added without `--cwd` simply falls through to `pi_agent_cwd` (or, if
that is also unset, to the inherited launch cwd) exactly as it did before
this feature existed.

### Interactive `bob chat` uses the caller's working directory

`bob chat` does not consult `pi_agent_cwd` at all. Instead, the CLI captures
the current working directory where `bob chat` was invoked and sends it to the
service in `session.interactive.open`; the supervised interactive `pi` session
is then spawned in that directory. This keeps interactive chat independent of
`pi_agent_cwd` and any scheduled job's `cwd`, while also avoiding the old
behavior where chat silently inherited the launch cwd of `bob serve`.

---

## Audit log

`bob` writes an append-only JSONL audit log. Each line is one JSON object
representing one audit record.

### What is recorded

The audit log captures three kinds of records:

- **`event`** — pi-agent extension events forwarded from running sessions.
  This also includes bob's own `duplicate_extension_connection` event,
  recorded when a second connection registers a session id that already has
  a live connection (see
  [Remove stale extension copies from pi's own `packages` list](#remove-stale-extension-copies-from-pis-own-packages-list)).
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

`bob` has two deterministic authorization gates, both evaluated by the
`policy-control` subsystem against an in-memory ruleset loaded from your TOML
config. The default behavior when no `[policy]` section is present is **deny all**
for the action gate. The two gates apply at different points and to different
traffic:

- **Pre-flight admission** applies to *admission-gated* queue-borne requests
  (e.g. external channel adapters). It does **not** apply to scheduled jobs —
  scheduler `Periodic` events are admitted by trusted
  schedule-store membership and are not checked against `admitted_users`, so an
  empty `admitted_users` list does not block scheduled prompt delivery.
  Interactive `bob chat` likewise does not run pre-flight admission.
- **The tool-call action gate** applies to *every* tool call from *every*
  supervised pi-agent session, including sessions started by scheduled jobs and
  interactive chat. There is no bypass for this gate.

For the architectural rationale and a detailed description of how the policy
engine works, see the [Architecture Overview](../architecture-overview/index.md).

### Pre-flight admission

When an *admission-gated* request enters the queue, `bob` checks the sender's
identity against the `admitted_users` list. Requests from identities not in the
list are dropped before any further processing. A denied `verdict` audit record
is appended for each blocked request with a reason that starts with `preflight
denied:`. Scheduled jobs are not admission-gated (see the note above): they are
admitted by trusted schedule-store membership and do not require an
`admitted_users` entry.

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

## Scheduled jobs

`bob` can run pi-agent prompts on a cron schedule. The scheduler runs entirely
inside the bob process — no system cron entries (crontab, systemd timers, or
similar) are needed or created.

**If bob is stopped when a job is due to fire, that job is skipped and will not
be replayed when the service restarts.** This is by design: jobs only
fire while the service is running, so every execution has a full audit trail.
Operators who need guaranteed delivery across restarts should keep bob running
under a process supervisor such as systemd.

### Schedule store (`schedules.json`)

`schedules.json` is the authoritative source for all scheduled jobs. `bob serve`
reads it at startup; `bob schedule add` and `bob schedule remove` persist
changes to it; and `bob schedule reload` applies edits you made to it directly.

**Default path (Linux):**

```
$XDG_STATE_HOME/bob/schedules.json
```

When `XDG_STATE_HOME` is not set, the XDG fallback is:

```
~/.local/state/bob/schedules.json
```

You can override the path in `config.toml`:

```toml
schedule_store_path = "/opt/bob/state/schedules.json"
```

Or set it via environment variable: `BOB_SCHEDULE_STORE_PATH`.

**File format:** The schedule store is a JSON document with this shape:

```json
{
  "version": 1,
  "entries": [
    {
      "id": "check-email",
      "cron": "*/15 * * * *",
      "prompt": "Check the inbox and summarise any unread messages."
    },
    {
      "id": "daily-report",
      "cron": "0 9 * * *",
      "file": "/opt/bob/prompts/daily-report.txt",
      "cwd": "/srv/workspaces/reports"
    }
  ]
}
```

The file is created with owner-only permissions (`0600`) and updated atomically
(written to a temp file in the same directory, then renamed), so a partial write
never corrupts the active schedule. An absent store is treated as empty — no
jobs are scheduled until entries are added.

**Note on `[[schedule]]` in `config.toml`:** The `[[schedule]]` TOML table is
no longer read by `bob serve`. Entries written to `config.toml` under
`[[schedule]]` are silently ignored. Use `schedules.json` and the
`bob schedule` subcommands instead.

Each entry has an `id`, a `cron`, and **exactly one** prompt source — either a
`prompt` (literal text) or a `file` (an absolute path):

| Field    | Type   | Description                                                                     |
|----------|--------|---------------------------------------------------------------------------------|
| `id`     | string | Unique identifier for the job (non-empty)                                        |
| `cron`   | string | 5-field cron expression (see below)                                             |
| `prompt` | string | Literal pi-agent prompt text run on each tick                                    |
| `file`   | string | Absolute path to a file whose contents are the prompt, read fresh on each tick   |
| `cwd`    | string | Optional absolute path: the working directory this entry's session runs in, overriding `pi_agent_cwd` for this entry only |

Provide exactly one of `prompt` or `file`. Setting both, setting neither, or
giving `file` a relative path is rejected when the store is loaded (the whole
store fails to load rather than skipping the bad entry). A `cwd` is always
optional; when present it must also be an absolute path, or the store fails
to load.

**File-backed prompts.** When an entry uses `file`, bob reads that file's
contents *fresh every time the job fires*, so editing the file changes what
future runs send without touching the schedule. If the file is missing,
unreadable, or blank at fire time, that tick is skipped and a warning is logged.

**Per-entry working directory (`cwd`).** An entry may also carry an optional
absolute `cwd`, naming the directory that entry's pi-agent session runs in
when it fires. When present it takes precedence over the service-wide
`pi_agent_cwd` for that entry only — see
[Working directory for pi-agent sessions](#working-directory-for-pi-agent-sessions)
for the full precedence rule. Like `file`, existence is not checked when the
entry is added or when the store is loaded — only at fire time. If the
resolved `cwd` does not exist when the job fires, that tick is skipped with a
warning and a monitoring failure record, and the entry fires again on its next
tick.

> **Security:** unlike `schedules.json` itself, neither a `file` prompt nor a
> `cwd` is read with any ownership or permission check — a deliberate
> relaxation of the trust boundary used for schedule-store admission. Because scheduled jobs bypass
> `[policy].admitted_users`, a prompt file or working directory that another
> user can write is an injection path into a trusted job. A writable `cwd` is
> especially significant: pi automatically loads `AGENTS.md`/`CLAUDE.md` and
> skills from a session's working directory, so a maliciously-writable `cwd`
> can inject context and instructions the operator never intended the job to
> run with. Keep both prompt files and every scheduled `cwd` under the same
> owner-only protection as `schedules.json` itself — filesystem permissions,
> not a bob-side ownership check, are the gate.

#### Cron expression format

`bob` uses standard 5-field cron expressions:

```
┌───────────── minute        (0–59)
│ ┌─────────── hour          (0–23)
│ │ ┌───────── day of month  (1–31)
│ │ │ ┌─────── month         (1–12)
│ │ │ │ ┌───── day of week   (0–6, Sunday = 0)
│ │ │ │ │
* * * * *
```

Six-field expressions (with a leading seconds field) are not accepted.

Five-field cron expressions are evaluated against the host's **local wall-clock
time**, not UTC. If the host's timezone is set to `America/New_York` and you
write `0 9 * * *`, the job fires at 09:00 New York local time regardless of
what UTC says. Set the host timezone before adding jobs so the cron schedule
aligns with your expectations.

### Managing jobs at runtime

The four `bob schedule` subcommands let you inspect and modify the active job
list without restarting the service.

#### `bob schedule list`

Print all currently active scheduled jobs:

```bash
bob schedule list
```

Each entry's line includes `cwd: <path>` at the end when the entry has one,
and omits it entirely otherwise:

```
check-email   */15 * * * *  prompt: Check the inbox and summarise any unread messages.
daily-report  0 9 * * *  file: /opt/bob/prompts/daily-report.txt  cwd: /srv/workspaces/reports
```

For machine-readable output:

```bash
bob schedule list --json
```

The same `cwd` field appears in the JSON output whenever the entry has one,
and is omitted from the object otherwise.

#### `bob schedule add`

Register a new job and persist it to the JSON schedule store. The job becomes
active immediately after the command succeeds:

```bash
bob schedule add \
  --id "check-email" \
  --cron "*/15 * * * *" \
  --prompt "Check the inbox and summarise any unread messages."
```

Or read the prompt from a file, re-read fresh on every run, and pin the job
to a specific working directory:

```bash
bob schedule add \
  --id "daily-report" \
  --cron "0 9 * * *" \
  --file ./prompts/daily-report.txt \
  --cwd /srv/workspaces/reports
```

Flags:

| Flag       | Required        | Description                                                     |
|------------|-----------------|-------------------------------------------------------------------|
| `--id`     | yes             | Unique job identifier                                            |
| `--cron`   | yes             | 5-field cron expression                                          |
| `--prompt` | one of these    | Literal pi-agent prompt text for each tick                       |
| `--file`   | one of these    | Path to a file whose contents are the prompt                     |
| `--cwd`    | no              | Absolute path: working directory the job runs in when it fires   |

Provide exactly one of `--prompt` or `--file`; they are mutually exclusive. A
`--file` path is resolved to an absolute path against your shell's working
directory (so relative paths work). The absolute path is what gets recorded,
and its contents are read fresh at each run. The file does **not** need to
exist when you add the schedule entry; existence is checked only when that fire
actually runs.

`--cwd` is optional and independent of `--prompt`/`--file` — combine it with
either. It must be an absolute path or the command fails immediately without
contacting the service. Unlike `--file`, the directory is **not** required to
exist when you run the command, since directory existence is a fire-time
concern (see
[Working directory for pi-agent sessions](#working-directory-for-pi-agent-sessions)).
When `--cwd` is omitted, the entry falls back to `pi_agent_cwd` and then to
the inherited launch cwd, per the same precedence.

#### `bob schedule remove`

Remove an existing job by its ID. The removal is persisted to the JSON schedule
store and takes effect immediately:

```bash
bob schedule remove --id "check-email"
```

#### `bob schedule reload`

Re-read `schedules.json` and replace the active job list with its contents.
Use this after editing `schedules.json` directly:

```bash
bob schedule reload
```

### Admission of scheduled jobs

Scheduled jobs are admitted by the **Unix trust boundary** and the trusted
schedule store — not by per-job UUID entries in `[policy].admitted_users`.
Because `schedules.json` is a local file owned by the operator (mode `0600`,
written only by `bob` itself or an authorized operator), a valid entry in it is
sufficient authorization for a periodic prompt to reach the agent.

**Do not add scheduler-derived UUIDs to `[policy].admitted_users` for scheduled
jobs.** Empty or absent `admitted_users` does not block scheduled prompt
delivery.

Every `tool_call` produced during a scheduled session still goes through
tool-call action authorization: the bob extension intercepts each tool invocation and
sends it to the policy engine for evaluation against `[[policy.action_rules]]`.
Only explicitly allowed tools execute; everything else is blocked. This gate is
independent of admission and cannot be bypassed by the scheduler.

### Observability for scheduled jobs

Bob provides four observation points for scheduled-job execution. There is no
dedicated schedule run-history store and no per-job success or failure counter;
all observability flows through the existing monitoring layer (consistent with
the fire-and-forget semantics of the `periodic` delivery kind).

**Service logs** — the scheduler emits structured `INFO` log lines when each job
is registered at startup and on reload. Warnings are logged when a cron
expression cannot be parsed (the job is skipped and does not fire), when a
periodic event cannot be submitted to the queue, and when session acquisition or
prompt delivery fails inside the periodic dispatcher.

**Policy verdict audit records** — scheduled jobs bypass pre-flight admission,
so no pre-flight `verdict` record is written for periodic prompts. Tool-call
authorization verdicts are still written for every tool invocation that occurs
during a scheduled session: `allow: true` when the tool matches a
`[[policy.action_rules]]` rule, and `allow: false` when it does not. Stream
them live with:

```bash
bob audit tail --filter verdicts
```

**Extension events** — the bob extension running inside each pi-agent session
emits events that are written to the audit log as `event` records. These records
capture what the agent did during execution. Stream them with:

```bash
bob audit tail --filter events
```

**No dedicated schedule run-history store** — there is no per-job execution
history, no "last run" timestamp, and no run counter persisted by bob itself.
Operators who need durable job-run records must collect and retain the audit log
externally (for example, by shipping the JSONL file to a log aggregator).

---

## Deploying the `email-triage` scheduled job

This section shows the validated operator procedure for turning the shipped
`the-intern/email-skills/` package into a live scheduled `email-triage` job.
It assumes the general policy model, `cwd`
precedence, and schedule-store behavior already described in
[Policy basics](#policy-basics),
[Working directory for pi-agent sessions](#working-directory-for-pi-agent-sessions),
and [Scheduled jobs](#scheduled-jobs); the steps below focus only on the
package-specific setup that T-139 and T-140 verified end to end.

1. Prepare the mailbox prerequisites outside bob.

   `email-triage` depends on a working Himalaya IMAP/SMTP account owned outside
   bob. Configure and test that account with Himalaya first, then choose the
   single manager escalation address the skill will email when a message cannot
   be classified confidently. Bob does not create or manage either of these
   inputs for you.

2. Deploy an owner-only workspace copy outside the repository checkout.

   The scheduled job's `--cwd` must point at a deployed copy of the package,
   not at this repository checkout. The deployed workspace holds mutable runtime
   state that the skill reads without an ownership check: the local
   `config/email-triage.toml`, the `worklog/` diary, and the `.pi/skills/`
   tree pi auto-loads from the working directory. Keep that whole workspace
   owner-only for the job user, matching the trust boundary described in
   [Scheduled jobs](#scheduled-jobs).

   ```bash
   WORKSPACE=/srv/workspaces/email-skills

   install -d -m 700 "$WORKSPACE"
   cp -r the-intern/email-skills/. "$WORKSPACE/"
   install -d -m 700 "$WORKSPACE/worklog"
   chmod 700 "$WORKSPACE" "$WORKSPACE/.pi" "$WORKSPACE/config" "$WORKSPACE/worklog"
   cp "$WORKSPACE/config/email-triage.example.toml" \
      "$WORKSPACE/config/email-triage.toml"
   ```

   Do not use the repository checkout as `--cwd`: a shared checkout is not the
   trusted runtime boundary for scheduled jobs, and it would mix mutable
   worklog/config state into source-controlled files.

3. Set the skill-local `manager_address`.

   Edit only the deployed copy's `config/email-triage.toml`. This file is
   skill-local configuration, not part of bob's top-level `config.toml`:

   ```toml
   manager_address = "manager@example.com"
   ```

   `manager_address` is required. It must be one well-formed email address.
   The shipped `email-triage.example.toml` stays in the repository as a template
   only; the real address belongs only in the deployed workspace copy.

4. Add scoped S-004 action rules for the deployed workspace, then reload policy.

   The validated runtime matcher shape is:

   - `read` rules match `arguments.path`, so use `field_path = "path"`.
   - `bash` rules match `arguments.command`, so use `field_path = "command"`.

   Do not copy older `cmd` examples from parser-only tests. The live T-139/T-140
   runs only succeeded when the bash rules matched the runtime `command` field.
   Replace `/srv/workspaces/email-skills` with the exact absolute path to your
   deployed copy and scope the mailbox move target to the real folder name from
   `himalaya folder list` (the validated account used `INBOX.Notifications`,
   not plain `Notifications`):

   ```toml
   [[policy.action_rules]]
   tool = "read"
   arg_matchers = [
     { field_path = "path", pattern = "/srv/workspaces/email-skills/.pi/skills/email-triage/SKILL.md" },
   ]

   [[policy.action_rules]]
   tool = "read"
   arg_matchers = [
     { field_path = "path", pattern = "/srv/workspaces/email-skills/.pi/skills/himalaya/SKILL.md" },
   ]

   [[policy.action_rules]]
   tool = "read"
   arg_matchers = [
     { field_path = "path", pattern = "/srv/workspaces/email-skills/.pi/skills/email-triage/references/*.md" },
   ]

   [[policy.action_rules]]
   tool = "read"
   arg_matchers = [
     { field_path = "path", pattern = "/srv/workspaces/email-skills/.pi/skills/email-triage/references/categories/*.md" },
   ]

   [[policy.action_rules]]
   tool = "read"
   arg_matchers = [
     { field_path = "path", pattern = "/srv/workspaces/email-skills/.pi/skills/himalaya/references/*.md" },
   ]

   [[policy.action_rules]]
   tool = "read"
   arg_matchers = [
     { field_path = "path", pattern = "/srv/workspaces/email-skills/worklog/*.md" },
   ]

   [[policy.action_rules]]
   tool = "read"
   arg_matchers = [
     { field_path = "path", pattern = "worklog/*.md" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "himalaya --version*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "himalaya account list*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "himalaya folder list*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "himalaya*envelope list*not flag seen*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "himalaya*message read*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "himalaya*message move*INBOX.Notifications*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "himalaya template write -H *To:* -H *Subject:Escalation:* *| himalaya template send*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "cat config/email-triage.toml*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "*find worklog*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "*ls worklog*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "test -f worklog/*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "cat worklog/*.md*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "mkdir -p worklog*" },
   ]

   [[policy.action_rules]]
   tool = "bash"
   arg_matchers = [
     { field_path = "command", pattern = "*>> worklog/*.md*" },
   ]
   ```

   After editing the policy section, reload it without restarting bob:

   ```bash
   bob policy reload
   ```

5. Add the scheduled job with its deployed `--cwd`, then verify the observed outcomes.

   Register the job against the deployed workspace, not the repository:

   ```bash
   bob schedule add \
     --id check-email \
     --cron "*/15 * * * *" \
     --prompt "Check email" \
     --cwd "$WORKSPACE"
   ```

   On the next tick, the expected operator-visible outcomes are:

   - A new `worklog/YYYY-MM-DD.md` entry under the deployed workspace.
   - `event` and `verdict` audit records visible with `bob audit tail`.
   - An escalation email sent to `manager_address` when the skill leaves a
     message open because it is not confidently classified.

   Helpful checks:

   ```bash
   bob audit tail --filter events --filter verdicts
   ls "$WORKSPACE/worklog"
   ```

   The cross-day continuity path verified in T-140 also reads prior worklog
   entries through the relative `read.path = "worklog/*.md"` matcher above, so
   keep that rule in place even if the first happy-path run appears to work
   without it.

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
