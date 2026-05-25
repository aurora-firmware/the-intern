---
id: T-080
title: Write architecture overview content for non-implementers
status: pending
priority: medium
assigned-role: developer
created: '2026-05-25'
spec: S-007
---

# Write architecture overview content for non-implementers

## Description

Replace the stub created by T-077 for the Architecture Overview chapter
with a conceptual description of the system aimed at readers who want to
understand `bob` without reading the Rust source.

The chapter must cover:
- **System shape** — `bob serve` as a long-running process exposing the
  admin socket (operator-facing) and the extension socket (JS extension
  facing), with an in-process request queue and in-memory persistence.
- **Request lifecycle** — how a request enters via a channel adapter,
  passes pre-flight admission, reaches the requests-handler, and how
  blocking tool-call authorization works.
- **Supervision** — the pi-agent supervisor's role (spawn, warm pool,
  prompt routing, idle reaping, kill) and its lifecycle relationship to
  `bob serve`.
- **Channel adapters** — the interactive-chat adapter as the implemented
  example; brief mention of the email/webhook/scheduler adapters as not
  yet implemented.
- **Policy gate** — pre-flight admission vs. the blocking tool-call gate,
  at a conceptual level.
- **Monitoring** — the append-only JSONL audit log, live `audit.tail`
  subscriptions, and `report.submit` intake.

Use at least two mermaid diagrams: one for the request lifecycle
(flowchart or sequence) and one for the supervisor's pi-agent lifecycle
states. Link out to `project/docs/system_overview.md` and
`project/docs/the-intern-architecture.md` for readers who want the
development-level deep dive.

## Acceptance Criteria

AC-1: The system shall provide a populated Architecture Overview chapter
at `the-intern/docs/src/architecture.md` whose rendered HTML contains a
section for each topic listed in the Description.

AC-2: The system shall include at least two mermaid diagrams (one for the
request lifecycle, one for the pi-agent supervisor state) that render as
SVG in the built HTML.

AC-3: WHEN `mdbook build` runs from `the-intern/docs/`, THE SYSTEM SHALL
produce the Architecture Overview chapter without warnings or broken
internal links.

AC-4: WHERE the chapter would otherwise restate development-level detail
already in `project/docs/`, THE SYSTEM SHALL link to that material
instead.

## Dependencies

- `T-077` — provides the mdBook scaffold (including `mdbook-mermaid`
  configuration) and the stub file this task replaces.

## Files to Touch

- `the-intern/docs/src/architecture.md` — replace stub with full content.

## Verification

```bash
cd the-intern/docs && mdbook build
test -s src/architecture.md
# at least two SVG diagrams produced from mermaid
test "$(grep -rc '<svg' book/architecture* 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" -ge 2
```

## Work Log

## Review
