---
id: ADR-005
title: Commands load no daemon code unless they run it
status: accepted
created: '2026-11-05'
---

# ADR-005: Commands load no daemon code unless they run it

## Context

`bob` is a thin client of the service (S-000, Command line). S-005 REQ-016 asks that it keeps no state, that a command
that only calls the service doesn't load the daemon's code, and that a command such as `bob jobs list` answers quickly.
Only two commands run daemon code themselves: `bob serve` runs the daemon (S-005 REQ-014), and `bob import` runs
S-004's import step in-process while the daemon is stopped (S-005 REQ-013).

Which modules a command may load is a design rule, and later command groups rely on it. Until now the rule was written
in S-005 REQ-016 and AC-016.1, in `docs/development/coding_guidelines.md` and in `docs/development/architecture.md`.
CR-001 takes design statements out of the requirement text, and those two documents don't bind (`docs/AGENTS.md`), so
the rule needs a binding home before it leaves the spec. It doesn't fit ADR-001, which is about the daemon and its
database.

Sources: CR-001; S-000, Command line; S-005 REQ-013, REQ-014 and REQ-016; `docs/development/coding_guidelines.md`
(Command line, "A thin client"); `src/cli/connection.ts`; `src/daemon/state_layout.ts`;
`test/support/module_trace.ts`.

## Decision

A `bob` command reaches the daemon only through the client library, and loads daemon code only if it runs it.

1. **No daemon module in a command.** No daemon module (daemon, host, service, listeners, jobs, agents) is imported by
   a command other than `serve` and `import`.
2. **`serve` and `import` load theirs late.** These two commands load the daemon's code by a dynamic `import()` inside
   `run`, so loading the command table loads none of it.
3. **One exception.** `src/daemon/state_layout.ts`, the path layout, is the one daemon file every command may load,
   because `src/cli/connection.ts` uses it to resolve the runtime directory. It imports only Node modules.
4. **How to check.** A trace of the modules one run loads shows the rule:
   `node --import ./test/support/module_trace.ts src/cli/bob.ts <command>` lists that file and no other daemon module.

## Consequences

### Positive

- A command that only calls the service starts quickly, whatever the daemon's code grows to.
- The command line can't reach the daemon's state except through the service, so it behaves like any other client.
- A later command group has one rule to follow, and a trace checks it.

### Negative

- `serve` and `import` need a dynamic `import()`, so a wrong path in one fails when the command runs, not when the
  command table loads.

### Neutral

- The rule says nothing about how fast a command must be. S-005 REQ-016 gives a reference timing, not a threshold.
- That `bob` keeps no state is behaviour, and stays in S-005 REQ-016.

## Alternatives Considered

### Alternative A: Keep the rule in the coding guidelines only

**Description:** Take the rule out of S-005 and leave it in `docs/development/coding_guidelines.md`.
**Rejected because:** That document doesn't bind, so the rule would lose its force, and S-005 AC-016.1 would have
nothing binding to check against.

### Alternative B: Add the rule to ADR-001 decision 2

**Description:** Treat the command line as one more component that stays away from the host.
**Rejected because:** ADR-001 is about the daemon process and its database, and the command line isn't part of that
process. The rule also has its own reason, a quick start, and its own exceptions.

### Alternative C: Static imports everywhere

**Description:** Let every command import what it needs at the top of its file, including `serve` and `import`.
**Rejected because:** The command table imports every command, so each `bob` run would load the daemon's code, and
S-005 REQ-016 forbids that for a command that only calls the service.

## Amendments

| Date | Change | Reason |
|---|---|---|
