---
id: T-103
title: Verify pi interactive-session invocation interface and decide the 
  terminal-brokering mechanism
status: in-progress
priority: high
assigned-role: unassigned
created: '2026-06-23'
spec: CR-002
---

# Verify pi interactive-session invocation interface and decide the terminal-brokering mechanism

## Description

**Verification and decision completed 2026-06-23.** Both halves of this task are
resolved up front; the residual work is a single confirming spike.

### Verified pi interface (pi 0.79.10, `@earendil-works/pi-coding-agent`)

- **Interactive is the default mode** — an `ink`-based TUI; `--print`/`-p` is the
  non-interactive opt-out (`--mode rpc` is the piped JSON-RPC worker bob uses).
- **Requires a real TTY** — pi uses `process.stdin.setRawMode` / `isTTY` and
  degrades to non-interactive on plain pipes.
- **Extension by path confirmed** — `--extension <path>` / `-e <path>`
  (repeatable); `--no-extensions`/`-ne` keeps explicit `-e`, so bob can load only
  `bob.ts` by path.
- **Version note:** installed pi is 0.79.10; `the-intern/extensions/package.json`
  pins the type dev-dep at 0.75.3 — reconcile if the type surface differs (minor).

### Brokering mechanism — DECIDED: mechanism A (ADR-011)

`bob chat` passes its controlling-terminal fds to `bob serve` over `admin.sock`
via `SCM_RIGHTS`; the supervisor spawns interactive pi on those fds (see
**ADR-011**). No PTY, no byte relay.

### Residual work — confirming spike

Prove, before T-104/T-105 build the production path, that interactive pi
(default mode, `-e <bob.ts>`) actually renders its TUI when a parent process
spawns it on terminal fds received via `SCM_RIGHTS`.

## Acceptance Criteria

AC-1: The system shall demonstrate, with a minimal spike, that interactive pi
      (default mode, `-e <bob.ts>`) runs and renders its `ink` TUI when spawned
      by a parent process on terminal fds received over a Unix socket via
      `SCM_RIGHTS` (mechanism A, ADR-011).

AC-2: IF the spike shows fd-passed terminal fds do not yield a working
      interactive pi THEN THE SYSTEM SHALL escalate to revisit ADR-011 before
      T-104 starts.

## Dependencies

- None.

## Files to Touch

- A throwaway spike (script or `examples/`/`tests/` harness) — not production
  code. ADR-011 already records the decision.

## Verification

```bash
# Manual: run the spike; observe interactive pi rendering on the fd-passed TTY.
ls project/decisions/ADR-011-* >/dev/null
```

## Work Log

### Session 1 — 2026-06-23
Verified the pi 0.79.10 interface (interactive default, ink TUI, requires a real
TTY via setRawMode/isTTY, `--extension`/`-e` confirmed). Decided the brokering
mechanism: mechanism A (SCM_RIGHTS fd-passing), recorded in ADR-011 (accepted).
Task narrowed to the confirming spike; infeasibility-escalation reduced to the
spike-fails case (AC-2).

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
