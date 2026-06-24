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

### Session 2 — 2026-06-24

Addressed all review findings:

- Replaced operator guidance for the deleted chat adapter with the always-running scheduler adapter, `[[schedule]]` configuration, and direct supervised-session behavior for `bob chat`.
- Replaced deleted `chat-adapter`/`ChatFrame` references with the current `InternalEvent`, `RequestContext`, and `IntakeHandle` contract, using `scheduler-adapter` as the concrete implementation.
- Updated the architecture overview’s `admin.sock` responsibilities, queue lifecycle scope, adapter inventory, and direct `session.interactive.open` flow.

The initial semantic check reproduced all obsolete claims. After editing, no stale positive claims remained. I rejected retaining generic chat-adapter language because the implementation and subscription route were deleted by T-107.

**Obstacles Encountered:** None. `mdbook build` emitted the existing mdbook-mermaid version warning but completed successfully.

**What remains:** Nothing.

### Session 3 — 2026-06-24

The red semantic search reproduced exactly two stale `bob.toml` references in the scheduled-jobs documentation. Replaced both with the shipped ADR-009 filename, `config.toml`.

No alternative changes were attempted because the review identified a precise terminology mismatch and the two-line correction fully resolved it.

**Obstacles Encountered:** None. The build emitted the existing mdbook-mermaid version warning but completed successfully.

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

### Review Verdict — 2026-06-24

FAIL

Stage 1 fails because the submitted mdBook remains internally contradictory
about the shipped chat and channel-adapter behavior. A correct replacement for
the end-user `bob chat` section is insufficient while the related operator,
extension-author, and architecture chapters still instruct readers using the
deleted subscription-based implementation. This is within scope: the
Description requires the mdBook user docs to match shipped behavior, and Files
to Touch permits the relevant content under `the-intern/docs/src/`, explicitly
including the Extension/Operator chapters.

- **`the-intern/docs/src/operator-guide/index.md`, `## Channel configuration`
  (submitted branch lines 187–212)** — The guide says interactive chat is the
  only implemented adapter, documents `[channels.chat] enabled`, and says
  `bob chat` subscribes. The interactive chat adapter and subscription path were
  removed, and the scheduler adapter is shipped. Replace this section with the
  current adapter/configuration model and clarify that interactive `bob chat`
  uses the supervised session RPC rather than a configurable chat adapter.
- **`the-intern/docs/src/extension-author-guide/index.md`,
  `## Channel-Adapter Contract` (submitted branch lines 135 onward)** — The
  chapter names deleted `crates/chat-adapter` as the reference implementation
  and documents its obsolete `ChatFrame`/admin-socket intake flow. Remove the
  deleted implementation contract and describe the currently shipped adapter
  contract using existing source (including the scheduler adapter where a
  concrete implementation is needed).
- **`the-intern/docs/src/architecture-overview/index.md`, System Shape line 26
  and Channel Adapters lines 142–149 on the submitted branch** — The overview
  still assigns chat subscriptions to `admin.sock`, calls interactive chat the
  only implemented adapter, and says scheduler is unimplemented. Update the
  socket purpose and adapter inventory/flow to match CR-002, T-106, and T-107.

Stage 2 was skipped because Stage 1 did not pass. `mdbook build` still succeeds,
but successful rendering does not validate the behavioral accuracy required by
the task.

**Obstacles Encountered:** The initial review checked the newly edited sections
and build result too narrowly and missed contradictory material later in the
same chapters. Integration inspection surfaced the broader mdBook consistency
failure; no implementation blocker remains.

Next owner: Developer via the active Development Loop.

### Review Verdict — 2026-06-24

FAIL

Cycle 2 resolves every finding from the previous verdict: the operator guide no
longer configures or subscribes a chat adapter, the extension-author guide uses
the shipped scheduler adapter and current intake types, and the architecture
overview now describes `session.interactive.open`, the scheduler inventory, and
the queue/direct-session split. AC-1 and AC-2 are met. The submitted snapshot
also passes `mdbook build` with the existing built `bob` binary supplied through
`BOB_BIN`; only the existing mdbook-mermaid version warning is emitted, so AC-3
is met.

Stage 1 nevertheless remains FAIL because one shipped filesystem-layout
contradiction remains in the edited operator guide:

- **`the-intern/docs/src/operator-guide/index.md`, `## Scheduled jobs`, lines
  349 and 438 on the submitted branch** — The guide first identifies the actual
  XDG configuration file as `$XDG_CONFIG_HOME/bob/config.toml` (line 204), then
  labels the schedule section as being in `bob.toml` and tells operators to edit
  `bob.toml` before `bob schedule reload`. The shipped resolver and ADR-009 use
  `config.toml`; a user following these instructions could edit the wrong file.
  Rename both remaining `bob.toml` references to `config.toml` so the scheduled
  job instructions agree with the documented and implemented XDG layout.

Stage 2 was skipped because Stage 1 did not fully pass. No other stale
chat-subscription, deleted chat-adapter, or unimplemented-scheduler claim remains
under `the-intern/docs/src/`, and `git diff --check` passes.

**Obstacles Encountered:** None. The required build completed successfully; the
remaining issue was found by comparing terminology across the edited operator
chapter and ADR-009.

Next owner: Developer via the active Development Loop.

### Review Verdict — 2026-06-24

PASS

Stage 1 passed. AC-1 is met by the end-user guide's supervised interactive pi
flow, explicit running-service precondition, terminal attachment, session-exit
behavior, and no-service error. AC-2 is met by the operator and extension-author
guides' XDG data defaults, `extension_path`/`BOB_EXTENSION_PATH` overrides,
`pi --extension` mechanism, and fail-closed missing-file behavior. AC-3 was
verified on the submitted branch snapshot: `mdbook build` completed without
errors using the existing built `bob` binary through `BOB_BIN`; only the known
mdbook-mermaid version warning was emitted.

All prior FAIL findings are resolved. The operator guide describes scheduler
configuration and direct supervised chat without a deleted chat adapter; the
extension-author guide uses the shipped scheduler adapter and current intake
contract; the architecture overview describes the current admin socket,
scheduler, queue, and direct interactive-session paths; and both scheduled-job
filename references now use ADR-009's shipped `config.toml`. Repository-wide
semantic searches under `the-intern/docs/src/` found no remaining stale
chat-subscription, deleted chat-adapter, unimplemented-scheduler, or `bob.toml`
claim.

Stage 2 passed. The documentation matches the relevant shipped implementation
and source-of-truth artifacts, the four changed mdBook chapters are necessary to
remove the cross-chapter contradictions, headings and links remain coherent,
and no unrelated behavior or files were added. `git diff --check` passes.

**Obstacles Encountered:** None. The build required the repository's existing
built `bob` binary for the CLI-reference preprocessor, as documented; this did
not block verification.

Next owner: active Development Loop.
