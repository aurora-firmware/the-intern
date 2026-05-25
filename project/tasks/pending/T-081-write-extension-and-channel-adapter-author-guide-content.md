---
id: T-081
title: Write extension and channel-adapter author guide content
status: pending
priority: medium
assigned-role: developer
created: '2026-05-25'
spec: S-007
---

# Write extension and channel-adapter author guide content

## Description

Replace the stub created by T-077 for the Extension & Channel-Adapter
Author Guide chapter with content for developers who want to build against
`bob`'s public surfaces.

The chapter must cover:
- **JS extension protocol** — what `the-intern/extensions/bob.ts` forwards
  over `extension.sock`, the framing rules, and how a new extension would
  consume those events.
- **pi-agent compatibility** — the current tested pi-agent package and
  version (`@earendil-works/pi-coding-agent@0.75.3`), how the
  compatibility test asserts it, and what happens when a different
  version is installed.
- **Channel-adapter contract** — what the interactive-chat adapter does
  (normalizes `chat.send` into the request queue with a self-asserted
  application identity per ADR-005), and the contract any new adapter
  must satisfy. Link to
  `project/specs/channel-adapter-framework-and-interactive-chat-adapter.md`
  for the full specification.
- **Pointers to ADRs** — link to the decisions that constrain extension
  and adapter authors (ADR-001 admin-rpc framing, ADR-004 inbound request
  interface, ADR-005 application-level identity).

Keep this chapter pragmatic: a reader following it should know which
sockets to talk to, which framing to use, and which decisions they must
respect.

## Acceptance Criteria

AC-1: The system shall provide a populated Extension & Channel-Adapter
Author Guide chapter at `the-intern/docs/src/extension-author.md` whose
rendered HTML contains a section for each topic listed in the
Description.

AC-2: The system shall reference, by name and number, ADR-001, ADR-004,
and ADR-005 with links to the corresponding files under
`project/decisions/`.

AC-3: The system shall name the currently supported pi-agent package and
version exactly as `@earendil-works/pi-coding-agent@0.75.3` and link to
the compatibility test that enforces it.

AC-4: WHEN `mdbook build` runs from `the-intern/docs/`, THE SYSTEM SHALL
produce the Extension & Channel-Adapter Author Guide chapter without
warnings or broken internal links.

## Dependencies

- `T-077` — provides the mdBook scaffold and the stub file this task
  replaces.

## Files to Touch

- `the-intern/docs/src/extension-author.md` — replace stub with full
  content.

## Verification

```bash
cd the-intern/docs && mdbook build
test -s src/extension-author.md
grep -rq "ADR-005" book/
grep -rq "0.75.3" book/
```

## Work Log

## Review
