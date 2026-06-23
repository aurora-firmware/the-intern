---
id: T-103
title: Verify pi interactive-session invocation interface and decide the 
  terminal-brokering mechanism
status: pending
priority: high
assigned-role: unassigned
created: '2026-06-23'
spec: CR-002
---

# Verify pi interactive-session invocation interface and decide the terminal-brokering mechanism

## Description

**Verification completed 2026-06-23 (findings below).** pi **does** expose a
usable interactive-on-given-stdio interface, so the CR-002 approach is feasible.
The infeasibility risk is closed. The remaining work is to decide and record the
**terminal-brokering mechanism** between the `bob chat` client's terminal and the
service-spawned pi process, in a new ADR, and prove it with a minimal spike.

### Verified pi interface (pi 0.79.10, `@earendil-works/pi-coding-agent`)

- **Interactive is the default mode.** `pi [options] [messages...]` runs an
  interactive **ink-based TUI**; `--print`/`-p` is the non-interactive opt-out
  (`--mode rpc` is the piped JSON-RPC worker bob already uses).
- **It requires a real TTY.** pi uses `process.stdin.setRawMode` and checks
  `process.stdin.isTTY`; on non-TTY pipes it degrades to non-interactive. The
  interactive session must therefore be given a **terminal** (the user's TTY or
  an allocated PTY), not plain pipes.
- **Extension by path is confirmed:** `--extension <path>` / `-e <path>` loads an
  extension file (repeatable); `--no-extensions`/`-ne` disables discovery while
  keeping explicit `-e` paths — so bob can load **only** `bob.ts` by path.
- **Version note:** installed pi is 0.79.10; `the-intern/extensions/package.json`
  pins the type dev-dep at 0.75.3. Reconcile if the type surface differs (minor).

### Remaining decision — brokering mechanism (record in an ADR)

Because interactive pi needs a real TTY, plain pipe-relay over `admin.sock` will
not work. Candidate mechanisms:

- **(A, recommended) fd-passing via `SCM_RIGHTS`:** `bob chat` passes its
  controlling-terminal fds (which are a TTY) to `bob serve` over `admin.sock`;
  the supervisor spawns pi with those fds as stdio. pi runs on the user's real
  terminal — no byte relay, no PTY allocation, no SIGWINCH plumbing.
- **(B) PTY allocation + byte relay:** the supervisor allocates a PTY, spawns pi
  on it, and relays bytes (and window-size changes) to the client over the
  socket. More moving parts.

## Acceptance Criteria

AC-1: The system shall record, in a new ADR under `project/decisions/`, the
      chosen terminal-brokering mechanism (A or B) and the rationale, citing the
      verified pi interface above.

AC-2: The system shall prove the chosen mechanism with a minimal spike that runs
      interactive pi (default mode, `-e <bob.ts>`) on the brokered terminal and
      observes the TUI render.

## Dependencies

- None.

## Files to Touch

- `project/decisions/ADR-0NN-<brokering-decision>.md` — new ADR (id assigned via
  `ai-team adr new`).

## Verification

```bash
ls project/decisions/ | grep -iE "broker|interactive|pty|terminal"
```

## Work Log

### Session 1 — 2026-06-23
Verified the pi 0.79.10 interface (see Description): interactive default mode,
ink TUI, requires a real TTY (`setRawMode`/`isTTY`), `--extension`/`-e <path>`
confirmed. Feasibility confirmed; infeasibility-escalation AC removed. Remaining
work narrowed to the brokering-mechanism ADR + spike; mechanism A (SCM_RIGHTS
fd-passing) recommended.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
