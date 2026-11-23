---
id: ADR-005
title: Commands load no daemon code unless they run it
status: accepted
created: '2026-11-05'
---

# ADR-005: Commands load no daemon code unless they run it

## Context

`bob` is a thin client of the service (S-000). S-005 REQ-016 asks that a command that only calls the service doesn't
load the daemon's code, so it answers quickly. Only `bob serve` and `bob import` run daemon code (S-005 REQ-013,
REQ-014). CR-001 takes this design rule out of the spec, and the developer docs don't bind, so it needs an ADR.
S-010's installation commands manage the program and the service: they guard the instance with its owner lock, copy
its stopped database and read the daemon's startup report (ADR-013), and call no operation apart from `daemon.status`
(S-005 Definitions, REQ-016 as amended for S-010).

## Decision

A `bob` command reaches the daemon only through the client library, and loads daemon code only if it runs it.

1. **No daemon module in a command.** No command other than `serve`, `import` and the installation commands imports a
   daemon module (daemon, host, service, listeners, jobs, agents).
2. **`serve`, `import` and the installation commands load theirs late,** by a dynamic `import()` inside `run`, so
   loading the command table loads none of it. The installation commands load `src/install/` and, of the daemon's
   files, only `src/daemon/ownership.ts` and `src/daemon/startup_report.ts`, which import only Node modules. They copy
   the database with `node:sqlite` and restore it by running the previous version's `bob import` as a child process
   (ADR-013 decision 5), so they load neither the host nor any pi package.
3. **One exception.** Every command may load the path layout, `src/daemon/state_layout.ts`, which
   `src/cli/connection.ts` uses and which imports only Node modules.
4. **How to check.** `node --import ./test/support/module_trace.ts src/cli/bob.ts <command>` lists the modules a run
   loads: that file and no other daemon module, and for an installation command also the two files decision 2 names.

## Consequences

- A command that only calls the service starts quickly however the daemon grows, and behaves like any other client.
- A wrong path in `serve`'s or `import`'s dynamic `import()` fails only when that command runs.
- The rule sets no timing; S-005 REQ-016 gives a reference timing, and that `bob` keeps no state stays there too.

## Alternatives Considered

- **The rule in the coding guidelines only:** rejected because they don't bind, so S-005 AC-016.1 would check against
  nothing binding.
- **The rule in ADR-001 decision 2:** rejected because the command line isn't part of the daemon process, and the rule
  has its own reason and exceptions.
- **Static imports everywhere:** rejected because the command table imports every command, so every run would load
  the daemon.
