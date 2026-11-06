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

The daemon runs in the foreground and writes its log to standard error (S-002 REQ-004). `--verbose` adds the debug
lines. Stop it with Ctrl-C. For a second instance, use another folder under `.tmp/`.

Run the live checks, which start the daemon over your own pi login, with `npm run test:live`,
`npm run test:live:agents`, `npm run test:live:jobs` and `npm run test:live:desk`. The last asks the front desk for a
piece of work, then pipes the same request to `bob chat` and runs `bob jobs follow` on the job it names until it is
Done. Each takes `--model <provider/id>` after `--`, and each runs in a short folder under the system temp folder,
since a socket path over 107 bytes fails.

## Checking the network listener from the LAN

This check shows that a computer on the local network (LAN) reaches the network listener (S-003 Success Criterion 5).
It needs a second computer on the same network as the machine that runs the daemon.

1. Find the machine's LAN address, for example with `ip -4 addr` on Linux or `ipconfig getifaddr en0` on macOS, and
   choose a fixed port that nothing on the machine listens on (`ss -ltn` lists the ports in use on Linux).
2. Write the `[network]` section into the development instance's `config.toml`, with that address and port. The
   daemon refuses to start on a config directory that the group or others can access, so the command creates it with
   umask `077`:

   ```
   (umask 077 && mkdir -p "$PWD/.tmp/dev-lan/config")
   printf '[network]\naddress = "192.168.1.20"\nport = 8080\n' > "$PWD/.tmp/dev-lan/config/config.toml"
   ```

3. Start the daemon on that instance:

   ```
   node src/cli/bob.ts serve \
     --config-dir "$PWD/.tmp/dev-lan/config" \
     --state-dir "$PWD/.tmp/dev-lan/state" \
     --data-dir "$PWD/.tmp/dev-lan/data" \
     --runtime-dir "$PWD/.tmp/dev-lan/runtime"
   ```

4. On the other computer, open `http://192.168.1.20:8080/ui/` in a browser. The Board opens; the
   [web interface chapter](../manual/web_interface.md) describes the pages.
5. On the other computer, use the pages, and create a job on the Front desk page.
6. Read the job's origin on its Job page, and with `bob jobs get <number>` on the service's machine.
7. On the other computer, call `daemon.status`:

   ```
   curl -X POST -H 'Content-Type: application/json' http://192.168.1.20:8080/operations/daemon.status
   ```

   The answer is `{"result":{"phase":"ready",…}}`.
8. Stop the daemon with Ctrl-C.

The network listener has no login and no encryption (S-003). Run this check only on a network you trust.

## Where the state is kept

An instance uses four directories: config, state (the database), data (the default workspaces of the roles) and
runtime (the socket's directory). By default they are resolved from the XDG base directories, in a folder named
`the-intern` (S-002 REQ-006). A team's instance runs there unless its flags say otherwise.

A development instance overrides them with the instance-directory flags (S-002 REQ-006, REQ-021) and points them at
subfolders of the git-ignored `.tmp/` folder of the repository. This keeps its state apart from any team's instance,
so several instances can run side by side. The rules of REQ-006 apply to these directories too: a missing directory is
created owner-only (mode 0700), and an existing one that is not a directory, not owned by you, or accessible to the
group or others stops startup (ADR-002, decision 6).

The runtime directory has a fallback. When `XDG_RUNTIME_DIR` is unset, as on macOS and under launchd, and no
`--runtime-dir` is given, the runtime directory is the `run` folder inside the state directory (S-002 REQ-006).

The database belongs to one daemon: only the daemon opens it (ADR-001, decision 1).

## The model login

A real model comes from your own pi login, used in place. The environment sets the pi agent folder, as for pi agent
itself (S-002 REQ-021). The instance does not copy the login into its directories or its database, and writes into the
agent folder only the login's own token refreshes (ADR-002, decision 5).

## Inspecting a running instance

Inspect a running instance through `bob` read commands, never by opening its database. Only the daemon opens the
database (ADR-001, decision 1), and another process reading it would break that rule.

## Logging

The daemon writes one plain line per event on standard error. The line format and the levels are answered in
[tech_stack.md](tech_stack.md), Local runs and diagnostics.
