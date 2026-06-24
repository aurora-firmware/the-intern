---
id: T-108
title: Update user docs for interactive bob chat and the extension by-path 
  install
status: pending
priority: medium
assigned-role: developer
created: '2026-06-23'
spec: CR-002
---

# Update user docs for interactive bob chat and the extension by-path install

## Description

Per CR-002 / CR-003 and the amended S-007, update the mdBook user docs under
`the-intern/docs/` so they match the shipped behaviour: the User CLI guide's
`bob chat` section (now an interactive pi session that requires the service
running), and the extension-install guidance (XDG `data` default,
`~/.local/share/bob/extensions/bob.ts`, `pi --extension`, no manual install into
pi's search path; XDG runtime layout per ADR-009). The docs must build cleanly.

## Acceptance Criteria

AC-1: The system shall update the `bob chat` user-guide section to describe the
      interactive pi session and the service-required precondition.

AC-2: The system shall update the extension-install documentation to the XDG
      `data` default and the `pi --extension` mechanism.

AC-3: WHEN the docs are built with `mdbook build` THE SYSTEM SHALL build without
      errors.

## Dependencies

- `T-102` — the extension README is the source of truth for the install model.
- `T-106` — the `bob chat` behaviour the guide documents.

## Files to Touch

- `the-intern/docs/src/` — the relevant User CLI and Extension/Operator chapters.

## Verification

```bash
cd the-intern/docs && mdbook build
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

### Session 1 — 2026-06-24

Replaced the obsolete `chat.open`/`chat.send` REPL documentation with the shipped service-required, supervised interactive pi flow. Documented terminal attachment, service ownership, extension authorization, session exit behavior, and the clear failure when `bob serve` is unreachable.

Added operator installation guidance for the XDG data default, macOS path, `extension_path`/`BOB_EXTENSION_PATH` overrides, `pi --extension`, and fail-closed missing-extension behavior. Added matching extension-loading details to the extension-author guide.

The initial content assertion failed because supervised interactive chat was undocumented. After the edits, all positive assertions passed and obsolete chat protocol references were absent. `mdbook build` completed successfully.

**Obstacles Encountered:** None. The build emitted the existing mdbook-mermaid version mismatch warning but no errors.

**What remains:** Nothing.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-06-24

PASS

Stage 1 passed. AC-1 is met by the rewritten `bob chat` section in
`the-intern/docs/src/end-user-guide/index.md`, which documents the supervised
interactive pi session, terminal attachment, service precondition, session
exit, and explicit no-service failure. AC-2 is met by the operator and
extension-author guides, which document the XDG data default,
`extension_path`/`BOB_EXTENSION_PATH` overrides, `pi --extension`, and the
fail-closed missing-file behavior. AC-3 was verified with `mdbook build` against
the submitted branch snapshot using the existing built `bob` binary; it
completed without errors (the existing mdbook-mermaid version warning remains).

Stage 2 passed. The documentation is accurate against the T-102 source of truth
and the shipped T-106 implementation, the changes are limited to the requested
user-documentation chapters, links and headings are consistent, and no obsolete
`chat.open`/`chat.send` user workflow remains in the edited guide.

Minor observation: a clean source archive requires a built `bob` binary (or
`BOB_BIN`) for the CLI-reference preprocessor; this is an existing documented
build prerequisite and is non-blocking.

Next owner: active Development Loop.
