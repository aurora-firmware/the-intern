---
name: bob-cli
description: Drive the bob CLI — task, status, sessions, audit, policy, schedule, chat, and worklog subcommands. Use whenever the user asks you to run a bob command, create or update a task on the task board, append to or read the daily worklog, inspect or kill sessions, tail the audit log, reload policy, manage scheduled jobs, or start an interactive chat, and whenever you need to decide which bob subcommand accomplishes a task. Also use if a `bob <subcommand>` invocation errors or produces unexpected output.
---

# bob-cli

`bob` is a single binary with subcommands `init`, `task`, `serve`, `status`,
`sessions`, `audit`, `policy`, `schedule`, `chat`, `worklog`. Every subcommand accepts a global
`--json` flag for single-line JSON output instead of human-readable text —
prefer `--json` when you (Claude) are the consumer, since it's stable to
parse and the human text form is not guaranteed to match it field-for-field.

`bob task` drives the task board (`new`, `list`, `show`, `status`, `note`
subcommands) and is documented purely as a CLI surface here — the operating
discipline for how to use the board (when to move a task, how to size work,
etc.) lives in the `tasks` pi-agent skill that `bob init` installs, not in
this plugin.

Most client subcommands talk to `bob serve` over the admin Unix socket
(`admin.sock`). If that socket is missing or unreachable you'll get
`missing admin socket at <path>` — that's a "bob isn't running or the
socket path doesn't match" problem, not a bug in the subcommand; see
`bob-troubleshooting` and `bob-health-check`. The exceptions are the
filesystem-only subcommands — `bob init`, `bob task`, and `bob worklog` —
which read and write files under the workspace directly and never open
`admin.sock`, so they work whether or not `bob serve` is running.

## Quick command map

| Task | Command |
|---|---|
| Bootstrap a new workspace | `bob init <path>` |
| Create/list/show/move/note a task on the board | `bob task new\|list\|show\|status\|note` |
| Append to / read the daily worklog | `bob worklog append\|list` |
| Is bob up, and what version/uptime? | `bob status --json` |
| List active sessions | `bob sessions list --json` |
| Kill a session | `bob sessions kill <id>` |
| Watch live audit events/reports/verdicts | `bob audit tail --json` (Ctrl-C to stop) |
| Reload the policy ruleset from disk | `bob policy reload` |
| Add/remove/list/reload scheduled cron jobs | `bob schedule add\|remove\|list\|reload` |
| Open an interactive chat session | `bob chat` |
| Start the service (foreground) | `bob serve` |

Full flag-by-flag reference for every subcommand, including `init`, `task`,
`worklog`, and `schedule`, is in `references/command-reference.md`.

## Things that are easy to get wrong

- **`bob schedule add` requires exactly one of `--prompt` or `--file`** —
  passing both, or neither, fails locally (clap validation) before any RPC
  call is made. `--file` is resolved to an absolute path against your
  *current shell's* cwd at the time you run `bob schedule add`, but its
  existence is not checked until the job actually fires later — a typo'd
  path will look like success now and fail silently (with a monitoring
  warning) at cron time.
- **`--cwd` on `schedule add` must already be an absolute path** — bob does
  not resolve a relative one for you; it fails locally instead of calling
  the RPC.
- **`bob audit tail --filter <kind>`** only accepts `events`, `reports`, or
  `verdicts` (repeatable flag for multiple kinds). No filters = every kind.
  A misspelled filter value is rejected by clap before the process even
  connects to the socket.
- **`bob chat` is not JSON-RPC like the others** — it hands your terminal's
  stdin/stdout/stderr file descriptors to the running `bob serve` process
  over the admin socket so it can supervise an interactive `pi` on your
  real TTY. This means `bob chat` cannot be meaningfully run through a
  non-interactive tool call with piped I/O the way `bob status` can — if
  you need to reason about chat behavior, read `bob-troubleshooting`
  and the extension-author docs rather than trying to script it.
- **`bob schedule list` has its own local `--json`** in addition to the
  global flag — behaviorally the same, but worth knowing it's declared
  separately in the CLI grammar if you're ever reading the source.
- Session `uptime_seconds` from `bob status` is measured from when the
  admin-RPC dispatcher was constructed, **not** from process start — don't
  treat it as exact process age.

## Verifying an action actually took effect

Because these are RPC calls with no dry-run mode, prefer verifying instead
of assuming success:
- After `bob schedule add`, run `bob schedule list --json` and check the
  new id is present with the expected cron/prompt/cwd.
- After `bob policy reload`, a failure to validate the new ruleset leaves
  the *old* snapshot active and the command reports the error — re-run
  `bob policy reload` after fixing the ruleset rather than assuming a
  partial reload happened.
- After `bob sessions kill <id>`, `bob sessions list --json` should no
  longer show that id.
