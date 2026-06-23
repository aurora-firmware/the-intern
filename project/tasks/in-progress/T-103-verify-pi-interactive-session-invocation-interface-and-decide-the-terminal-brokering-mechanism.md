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

### Session 2 — 2026-06-23

Implemented the confirming spike as a standard-library Python harness. The
client process sends stdin, stdout, and stderr over an AF_UNIX socketpair using
SCM_RIGHTS; the receiving process validates all three received descriptors are
TTYs and spawns default-interactive pi with `--no-extensions -e <bob.ts>
--no-session` on those descriptors.

Used a red→green TDD cycle. The initial test failed because the spike module did
not exist. Added coverage for transferring all three descriptors, preserving
the default interactive command shape with the explicit extension, and
rejecting received descriptors that are not TTYs. All three tests pass.

Ran the spike in an interactive terminal. It printed the SCM_RIGHTS
confirmation, rendered pi's full-screen TUI, showed the repository's `bob.ts`
under Extensions, and exited cleanly via Ctrl-D. This confirms ADR-011 mechanism
A; AC-2 does not trigger. The available executable during the confirming run
was pi 0.65.2 rather than the 0.79.10 recorded in Session 1. The sandbox also
rejected the deliberately absent extension-socket connection with EPERM, but
the extension loaded and the interactive TUI behavior under test worked. No
implementation work remains; review and integration are next.

### Session 3 — 2026-06-23

Investigated the review's version-specific evidence gap. The failure was
reproduced and isolated to PATH ordering: `/usr/local/bin/pi` version 0.65.2
appears before `/home/daneel/.npm-global/bin/pi`, while the latter resolves to
the installed `@earendil-works/pi-coding-agent` version 0.79.10.

Added an explicit `--pi` executable option to the throwaway spike so the target
installation can be selected reproducibly. Under TDD, the new selector test
first failed because `parse_args` accepted no argument vector; after the
minimal implementation, all four spike tests pass.

Ran the real-TTY spike with `--pi /home/daneel/.npm-global/bin/pi`. The
SCM_RIGHTS confirmation appeared, the rendered TUI header showed `pi v0.79.10`,
startup resources listed `bob.ts` under Extensions, and Ctrl-D exited cleanly
with status 0. This supplies the version-specific AC-1 evidence requested by
review. Mechanism A works with the stated target, so AC-2 does not trigger. No
implementation work remains.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-06-23

FAIL

Stage 1 did not pass, so Stage 2 was not used as an approval gate.

- **Work Log, Session 2 / AC-1:** The manual TTY run used pi 0.65.2, while the
  task's verified interface and ADR-011 explicitly identify pi 0.79.10 as the
  implementation on which the downstream decision is based. The run therefore
  demonstrates SCM_RIGHTS terminal brokering for 0.65.2, but does not confirm
  that the stated 0.79.10 target renders correctly with the same invocation and
  received descriptors. Rerun the spike in a real terminal with pi 0.79.10 and
  return the observed TUI/extension/exit evidence. If 0.79.10 was recorded in
  error, correct the canonical task and ADR through the appropriate lifecycle
  process before resubmitting.
- **Work Log, Session 2 / AC-2:** Because the intended-version confirming run
  has not occurred, the condition that determines whether ADR-011 must be
  revisited is not yet resolved for pi 0.79.10. Record that result after the
  corrected manual run.

The implementation diff is limited to the permitted throwaway spike. Its three
automated tests pass and cover SCM_RIGHTS transfer, the default-interactive
command shape with explicit `-e`, and rejection of non-TTY descriptors. These
checks do not replace the version-specific manual TTY evidence required above.

Obstacles Encountered: The available `pi` on the review host is
`/usr/local/bin/pi` version 0.65.2, so the reviewer could not independently run
the required interactive check against 0.79.10.

Next owner: active Development Loop.
