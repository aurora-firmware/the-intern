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

- `the-intern/docs/src/extension-author-guide/index.md` — replace stub
  created by T-077 with full content.

## Verification

```bash
cd the-intern/docs && mdbook build
test -s src/extension-author-guide/index.md
grep -rq "ADR-005" book/
grep -rq "0.75.3" book/
```

## Work Log

### Session 1 — 2026-05-26

Read `the-intern/extensions/bob.ts`, `package.json`,
`pi-agent-compat.test.ts`, `extension-ipc/src/framing.rs`,
`extension-ipc/src/lib.rs`, `chat-adapter/src/lib.rs`, and ADR-001/004/005
before writing a single word. All factual claims were verified against
the source files before inclusion.

Wrote `the-intern/docs/src/extension-author-guide/index.md` (188 lines)
with four H2 sections:

- **JS Extension Protocol** — the two environment variables `bob`
  sets, the two outbound frame kinds (event and authz) with their wire
  shapes taken directly from `bob.ts` JSDoc and `framing.rs`, the one
  inbound frame kind (authz_verdict), the failure behaviour
  (one-warning-then-silent), and guidance for any alternative consumer
  of `extension.sock`.
- **pi-agent Compatibility** — names `@earendil-works/pi-coding-agent@0.75.3`
  exactly, describes the three checks in `pi-agent-compat.test.ts`
  (pinned declaration, installed version, PI_EVENTS surface coverage),
  and explains the error a maintainer sees when versions mismatch.
- **Channel-Adapter Contract** — describes what the interactive-chat
  adapter does (normalize to `DeliveryKind::Sync`, populate
  `RequestContext` with the self-asserted `UserId`, submit to intake,
  apply no policy), calls out the ADR-005 identity model, and lists the
  contract any new adapter must satisfy.
- **Pointers to ADRs** — one paragraph per ADR with inline links via
  `../../../project/decisions/` relative paths.

`mdbook build` completed without errors; all four verification commands
from the task file passed.

### Session 2 — 2026-05-28

Fixed the single AC-3 defect raised in the cycle 1 review: the compatibility
test file reference at line 90 of
`the-intern/docs/src/extension-author-guide/index.md` was a bare
backtick-formatted path with no hyperlink. Converted it to a Markdown
hyperlink using the relative path
`../../../extensions/pi-agent-compat.test.ts`, confirmed with `realpath`
before committing. The reviewer's suggested path
(`../../../../the-intern/extensions/pi-agent-compat.test.ts`) had one extra
level that would also resolve, but the three-level path is accurate and was
preferred. Ran `mdbook build` via its full path
(`/home/daneel/.cargo/bin/mdbook`); build completed clean, and the rendered
HTML confirms the `<a href>` tag is present. All four verification commands
from the task file passed. One line changed, one commit on the task branch.

## Review

### Review Verdict — 2026-05-28

FAIL

**Stage 1 — Spec Compliance**

AC-1: Four H2 sections are present (JS Extension Protocol, pi-agent Compatibility, Channel-Adapter Contract, Pointers to ADRs), covering every topic listed in the Description. File is at `the-intern/docs/src/extension-author-guide/index.md` as specified in Files to Touch. PASS.

AC-2: ADR-001, ADR-004, and ADR-005 are each referenced by name and number, with hyperlinks using `../../../project/decisions/<filename>.md` paths. The same relative-path convention was used and accepted in T-080 with the same book nesting level. PASS.

AC-3: FAIL. The package and version `@earendil-works/pi-coding-agent@0.75.3` are named exactly at line 81 of the guide. However, the compatibility test is referenced only as a backtick-formatted path (`the-intern/extensions/pi-agent-compat.test.ts`) at line 90 — there is no hyperlink. AC-3 explicitly requires a *link* to the compatibility test. A code-formatted prose path is not a link.

AC-4: `mdbook` is not installed in the review environment so the command could not be re-run independently. The Work Log asserts the build completed without errors. This is accepted on the Developer's evidence given that AC-4 cannot be re-verified here.

**Stage 1 verdict: FAIL — AC-3 not met.**

Stage 2 was not applied because Stage 1 failed.

---

**Required fix:**

- **File:** `the-intern/docs/src/extension-author-guide/index.md`, line 90 (the sentence beginning `` `the-intern/extensions/pi-agent-compat.test.ts` runs as part of… ``).
- **What is wrong:** The compatibility test file is referenced as a backtick-formatted path with no hyperlink. AC-3 requires a link to the compatibility test.
- **What should change:** Replace the bare path with a Markdown hyperlink. The relative path from the guide file to the test is `../../../../the-intern/extensions/pi-agent-compat.test.ts` (four levels up from `the-intern/docs/src/extension-author-guide/` to the repo root, then into `the-intern/extensions/`). Example:
  ```
  [`the-intern/extensions/pi-agent-compat.test.ts`](../../../../the-intern/extensions/pi-agent-compat.test.ts)
  ```
  After making this change, re-run `mdbook build` to confirm no new warnings or broken-link errors are introduced, and record the result in the Work Log.
