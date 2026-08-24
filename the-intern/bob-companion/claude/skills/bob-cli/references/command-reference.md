# bob command reference

Source of truth: `the-intern/service/crates/bob/src/cli/mod.rs` (clap
grammar) and `the-intern/service/crates/bob/src/cli/commands/*.rs`
(handlers). Global flag `--json` applies to every subcommand below.

## `bob init <path> [--force]`

Bootstraps a workspace at `<path>` and writes bob's live `config.toml` at
the platform default config path, without needing `bob serve` running
first. `<path>` is a required positional argument — the workspace
directory to create/populate (`AGENTS.md`, `CLAUDE.md`,
`config/email-triage.toml`, `worklog/`). Also installs the shared
`himalaya`/`email-triage`/`worklog` skill package at `skill_install_path`.

`--force` is optional. Without it, if the resolved live `config.toml` path
already exists, the command fails locally with `"live config already
exists at <path>; rerun with --force to replace it"` and writes nothing.
With `--force`, existing generated files (workspace files, the live config,
the shared skill package) are overwritten.

## `bob task [--board <PATH>] <subcommand>`

`--board` is a flag on `task` itself (before the subcommand), not on the
individual subcommands, and applies to all of them. Board resolution order:
`--board` if given, else the `TASKS_DIR` env var if set, else the nearest
ancestor directory named `tasks/` found by walking up from the current
working directory, else `<cwd>/tasks` (only auto-created for `task new`;
`show`/`list`/`status`/`note` fail locally with "no task board found" if
nothing is found by the search).

### `bob task new <title> [--status <STATUS>] [--created <DATE>] [--description <TEXT>] [--done <ITEM>]...`

Creates `<board>/<YYYY-MM-DD>-<slugified-title>.md` and prints its id,
status, and path (or the JSON equivalent with `--json`).
- `<title>` is a required positional argument.
- `--status` defaults to `todo`. Accepted values: `todo`, `doing`,
  `blocked`, `done`.
- `--created` overrides the creation date used in the id and frontmatter
  (format `YYYY-MM-DD`); defaults to today.
- `--description` is optional free text for the task's Description section.
- `--done` is repeatable — each occurrence adds one unticked Definition of
  Done item.

### `bob task show <id> [--path]`

Prints the task file's full content (or `{"id", "path", "title", "status",
"content"}` with `--json`).
- `<id>` accepts a partial identifier prefix; it must resolve to exactly one
  task file or the command fails locally (no match, or an ambiguous match
  listing every candidate).
- `--path` prints only the resolved file path instead of the content.

### `bob task list [--status <STATUS>]...`

Lists tasks grouped by status, or `{"tasks": [...]}` with `--json` (each
entry has `id`, `title`, `status`, `path`).
- `--status` is repeatable and filters to the given statuses
  (`todo`/`doing`/`blocked`/`done`). Omit it entirely to see every status
  except `done`.

### `bob task status <id> <status> [--reason <TEXT>]`

Rewrites the task's frontmatter `status` field and appends a log entry
recording the transition; prints the previous and new status (or the JSON
equivalent with `--json`).
- `<id>` accepts a partial identifier prefix, resolved the same way as
  `task show`.
- `<status>` is a required positional argument, not a flag.
- `--reason` is optional text appended to the log entry
  (`Status changed from <old> to <new>: <reason>`); omitted it reads
  `Status changed from <old> to <new>.`.

### `bob task note <id> <text>`

Appends a dated log entry to the task without changing its status; prints
the task id and path (or the JSON equivalent with `--json`).
- `<id>` accepts a partial identifier prefix, resolved the same way as
  `task show`.
- `<text>` is a required positional argument and must not be empty.

## `bob serve`

No flags. Foreground, long-running. Builds `BobConfig`, starts every
subsystem actor (monitoring, persistence, policy-control,
pi-agent-supervisor, requests-handler, extension-ipc, scheduler-adapter,
admin-rpc, periodic dispatcher), binds `admin.sock`/`extension.sock`, waits
for SIGTERM/SIGINT, then runs a 6-phase graceful shutdown. This is the only
subcommand that doesn't need another `bob serve` already running.

## `bob status [--json]`

Calls admin-RPC `service.status`. Human output: `ok`, `version`,
`uptime_seconds`. JSON: `{"ok":true,"version":"...","uptime_seconds":N}`.

## `bob sessions list [--json]`

Calls `sessions.list`. One session id per line, or a JSON array.

## `bob sessions kill <id> [--json]`

Calls `sessions.kill` with `{"id": id}`. Prints `killed: <id>` or JSON.

## `bob audit tail [--filter <KIND>]... [--json]`

Subscribes to `audit.tail.subscribe`; streams notifications until Ctrl-C,
then unsubscribes/closes. `--filter` is repeatable; valid values are
`events`, `reports`, `verdicts` — anything else is rejected by clap before
any connection is attempted. No `--filter` flags ⇒ subscribe params `{}`
(every kind streamed).

## `bob policy reload [--json]`

Calls `policy.reload`. Prints `policy reloaded` or `{"ok":true}`. If the
new ruleset fails validation, the *old* snapshot stays active and the
command surfaces the validation error — this is a safe, non-destructive
failure mode.

## `bob schedule add --id <ID> --cron <CRON> (--prompt <TEXT> | --file <PATH>) [--cwd <ABS_PATH>] [--json]`

Calls `schedule.add`.
- `--prompt` and `--file` are mutually exclusive and exactly one is
  required (clap `conflicts_with` / `required_unless_present`).
- `--file` is resolved to an absolute path against the *caller's* cwd
  before the RPC call; existence isn't checked until the job actually
  fires.
- `--cwd`, if given, must already be absolute or the command fails locally
  without contacting the service at all.

## `bob schedule remove --id <ID> [--json]`

Calls `schedule.remove`.

## `bob schedule list [--json]`

Calls `schedule.list`. Human output per line:
`<id>  <cron>  prompt:/file: <src>[  cwd: <path>]`. Note this subcommand
declares its own local `--json` field (`ScheduleCommand::List { json: bool
}`) distinct from the global flag, though it behaves the same.

## `bob schedule reload [--json]`

Calls `schedule.reload` — re-reads `schedules.json` from disk and replaces
the live schedule table in memory.

## `bob chat [--session <id>]`

Not a simple JSON-RPC call/subscribe like the rest. Implements a bespoke
handshake over `admin.sock`:
1. `session.interactive.open`
2. await `session.interactive.await_fds` notification
3. send stdin/stdout/stderr file descriptors via `SCM_RIGHTS`/`sendmsg`
   (1-byte anchor)
4. read the open response
5. block until a `session.interactive.exited` notification

The `--session <id>` flag is parsed but not currently used by the client.
`bob chat` sends the invoking shell's cwd as `params.cwd`. If the admin
socket isn't reachable, it errors with `"bob service is not running —
cannot reach admin socket at <path>"` and does **not** fall back to
launching a bare `pi` process.

## Admin-RPC method table (for context, not directly CLI-exposed)

Full JSON-RPC 2.0 method set handled by `admin-rpc`'s `Dispatcher`
(`the-intern/service/crates/admin-rpc/src/dispatch.rs`):
`service.status`, `sessions.list`, `sessions.kill`, `policy.reload`,
`audit.tail.subscribe`, `audit.tail.unsubscribe`, `report.submit`,
`schedule.add`, `schedule.remove`, `schedule.list`, `schedule.reload`,
`session.interactive.open` (plus server-pushed notifications
`session.interactive.await_fds` and `session.interactive.exited`).
Methods needing a subsystem handle that isn't wired up (e.g. `sessions.*`
without a supervisor) return JSON-RPC `-32601 Method not found`; malformed
JSON returns `-32700 Parse error` and closes the connection.
