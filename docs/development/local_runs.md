# Local runs

How a developer runs their own instance of The Intern, apart from the instance a team uses. A local run is for trying
the service by hand against a real model. It is not part of the automated tests and the tests never need it
(see [tech_stack.md](tech_stack.md), Test harness). This page restates no requirements: where it differs from
[S-002](../ai-team/specs/S-002-daemon-and-host-runtime.md) or the accepted decision records, fix this page.

## Commands

Start a development instance from the repository root, with its four directories under `.tmp/`. A directory flag
must be an absolute path, so the command builds each one from `$PWD`:

```
node src/cli/bob.ts serve \
  --config-dir "$PWD/.tmp/dev/config" \
  --state-dir "$PWD/.tmp/dev/state" \
  --data-dir "$PWD/.tmp/dev/data" \
  --runtime-dir "$PWD/.tmp/dev/runtime" \
  --verbose
```

The daemon runs in the foreground and writes its log to standard error (S-002 R-4). `--verbose` adds the debug lines.
Stop it with Ctrl-C. For a second instance, use another folder under `.tmp/`.

Run the live checks, which start the daemon over your own pi login, with `npm run test:live`.

## Where the state is kept

An instance uses four directories: config, state (the database), data (the default workspaces of the roles) and
runtime (the socket's directory). By default they are resolved from the XDG base directories, in a folder named
`the-intern` (S-002 R-6). A team's instance runs there unless its flags say otherwise.

A development instance overrides them with the instance-directory flags (S-002 R-6, R-21) and points them at
subfolders of the git-ignored `.tmp/` folder of the repository. This keeps its state apart from any team's instance,
so several instances can run side by side. The rules of R-6 apply to these directories too: a missing directory is
created owner-only (mode 0700), and an existing one that is not a directory, not owned by you, or accessible to the
group or others stops startup (ADR-002, decision 6).

The runtime directory has a fallback. When `XDG_RUNTIME_DIR` is unset, as on macOS and under launchd, and no
`--runtime-dir` is given, the runtime directory is the `run` folder inside the state directory (S-002 R-6).

The database belongs to one daemon: only the daemon opens it (ADR-001, decision 1).

## The model login

A real model comes from your own pi login, used in place. The environment sets the pi agent folder, as for pi agent
itself (S-002 R-21). The instance does not copy the login into its directories or its database, and writes into the
agent folder only the login's own token refreshes (ADR-002, decision 5).

## Inspecting a running instance

Inspect a running instance through `bob` read commands, never by opening its database. Only the daemon opens the
database (ADR-001, decision 1), and another process reading it would break that rule.

## Logging

The daemon writes one plain line per event on standard error. The line format and the levels are answered in
[tech_stack.md](tech_stack.md), Local runs and diagnostics.
