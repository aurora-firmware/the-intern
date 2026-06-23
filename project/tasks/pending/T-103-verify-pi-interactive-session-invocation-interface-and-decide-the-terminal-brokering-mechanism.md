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

CR-002 requires `bob chat` to run a **supervised, directly-launched interactive**
pi session, but today the supervisor only spawns `pi --mode rpc` (piped stdio, no
TTY). This is a verification/design task that must complete before T-104–T-106.

Verify against the actual pi CLI/source (pi is a hard prerequisite, on `PATH`):
1. how to launch an **interactive** pi session (invocation + flags), and whether
   `--extension <path>` (T-101) composes with interactive mode;
2. whether/how pi can run on **caller-provided stdio** — an allocated PTY or
   inherited file descriptors.

Then decide and record the **terminal-brokering mechanism** between the `bob chat`
client's terminal and the service-spawned pi process. Candidate mechanisms:
passing the client's terminal fds to the service over `admin.sock` via
`SCM_RIGHTS` (fd-passing), or relaying PTY bytes over the socket. Record the
verified interface and the decision in a new ADR under `project/decisions/`.

## Acceptance Criteria

AC-1: The system shall document the verified pi interactive-session invocation
      (command, flags, and how `--extension` composes) against the real pi CLI.

AC-2: The system shall record, in a new ADR under `project/decisions/`, the
      chosen terminal-brokering mechanism and the rationale.

AC-3: IF pi exposes no usable interactive-on-given-stdio interface THEN THE
      SYSTEM SHALL escalate that the CR-002 approach is infeasible rather than
      proceeding to T-104.

## Dependencies

- None.

## Files to Touch

- `project/decisions/ADR-0NN-<brokering-decision>.md` — new ADR (id assigned via
  `ai-team adr new`).

## Verification

```bash
# Verification/design task: the new ADR exists and records the brokering decision.
ls project/decisions/ | grep -iE "broker|interactive|pty|terminal"
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
