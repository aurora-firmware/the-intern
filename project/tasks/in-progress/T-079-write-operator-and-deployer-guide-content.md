---
id: T-079
title: Write operator and deployer guide content
status: pending
priority: medium
assigned-role: developer
created: '2026-05-25'
spec: S-007
---

# Write operator and deployer guide content

## Description

Replace the stub created by T-077 for the Operator & Deployer Guide chapter
with content for the audience that installs, configures, runs, and observes
`bob` in a real environment.

Topics the chapter must cover, each as its own section:
- **Prerequisites** — Rust toolchain (pinned via `rust-toolchain.toml`) and
  the `pi` binary on `PATH` as a hard precondition; how to verify and what
  to do if it is missing.
- **Build and install** — building `bob` from the workspace; where the
  binary lands.
- **Runtime layout** — `BOB_TEST_RUNTIME_DIR`, admin and extension sockets,
  default paths and how to override them with `BOB_ADMIN_SOCK_PATH` /
  `BOB_EXTENSION_SOCK_PATH`.
- **Channel configuration** — the `[channels.chat]` config section and
  enabling/disabling channels.
- **Audit log** — what the JSONL log captures, where it lives, how to tail
  it via `bob audit`.
- **Policy basics** — what pre-flight admission and the blocking
  `tool_call` authorization gate do operationally (link to the
  architecture chapter for the conceptual picture).
- **Shutdown** — how SIGTERM drives the supervisor's shutdown phases and
  socket cleanup.

This chapter focuses on operational behaviour. Architectural rationale
belongs in the Architecture Overview chapter; CLI flag exhaustiveness
belongs in the CLI Reference part.

## Acceptance Criteria

AC-1: The system shall provide a populated Operator & Deployer Guide
chapter at `the-intern/docs/src/operator-guide.md` whose rendered HTML
contains a section for each topic listed in the Description.

AC-2: The system shall state the `pi`-on-`PATH` precondition explicitly,
including how to verify it and an instruction to stop and escalate rather
than substitute a mock when it is missing.

AC-3: WHEN `mdbook build` runs from `the-intern/docs/`, THE SYSTEM SHALL
produce the Operator & Deployer Guide chapter without warnings or broken
internal links.

AC-4: IF the chapter discusses policy or architectural rationale beyond
operational behaviour, THEN THE SYSTEM SHALL link to the Architecture
Overview chapter rather than restating that material.

## Dependencies

- `T-077` — provides the mdBook scaffold and the stub file this task
  replaces.

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — replace stub created
  by T-077 with full content.

## Verification

```bash
cd the-intern/docs && mdbook build
test -s src/operator-guide/index.md
grep -rq "BOB_ADMIN_SOCK_PATH" book/
grep -rq "pi binary" book/
```

## Work Log

## Review
