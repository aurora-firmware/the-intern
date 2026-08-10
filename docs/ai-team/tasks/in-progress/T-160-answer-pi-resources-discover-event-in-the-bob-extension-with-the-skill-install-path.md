---
id: T-160
title: Answer pi resources_discover event in the bob extension with the skill 
  install path
status: pending
priority: high
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Answer pi resources_discover event in the bob extension with the skill install path

## Description

S-011 Implementation Order Phase 4, depends on T-150 (confirmed event
behaviour) and T-158 (env var exists). Today
`the-intern/pi-extension/bob.ts` subscribes to `resources_discover` only as
one entry in the generic fire-and-forget `PI_EVENTS` forwarding array
(`bob.ts:69`) — nothing answers it. Per ADR-014, remove `resources_discover`
from that generic list and give it its own handler, modeled on the existing
blocking `tool_call` hook's special-case registration pattern
(`handleToolCall`, near the bottom of `bob.ts`): on `resources_discover`,
read `BOB_SKILL_INSTALL_PATH` from the environment and return it as a
contributed skill path; if the variable is unset, empty, or names a path
that does not exist on disk, contribute no skill paths and log one warning
via the existing `warn()` helper (fail-open, per ADR-014 §4 — this must not
throw or block session start).

Removing `resources_discover` from the generic `PI_EVENTS` array will make
`the-intern/pi-extension/pi-agent-compat.test.ts` fail: it asserts
`PI_EVENTS` covers every event in the installed package's `on()` overloads
except `tool_call`. Update that test's exclusion set to
`{tool_call, resources_discover}` (events with dedicated handlers) as part
of this task, or its own `npm test` verification cannot pass.

## Acceptance Criteria

AC-1: The system shall no longer forward `resources_discover` through the
      generic `PI_EVENTS` event-loop registration.
AC-2: WHEN `BOB_SKILL_INSTALL_PATH` is set and non-empty, and names a path
      that exists, at extension load time THE SYSTEM SHALL answer pi's
      `resources_discover` event with that path as a contributed skill path.
AC-3: IF `BOB_SKILL_INSTALL_PATH` is unset or empty THEN THE SYSTEM SHALL
      contribute no skill paths, log one warning via the existing `warn()`
      helper, and shall not throw or block session initialisation. (S-003's
      2026-08-09 amendment makes the single warning mandatory for the
      absent/empty case as well as the nonexistent-path case of AC-4:
      "When `BOB_SKILL_INSTALL_PATH` is absent, empty, or names a path that
      does not exist, the extension MUST contribute no skill paths and log
      one warning." Gate 2 correction, 2026-08-09.)
AC-4: IF `BOB_SKILL_INSTALL_PATH` names a path that does not exist on disk
      THEN THE SYSTEM SHALL contribute no skill paths, log one warning via
      the existing `warn()` helper, and shall not throw or block session
      initialisation.
AC-5: The compatibility check's `PI_EVENTS`-completeness exclusion set shall
      be `{tool_call, resources_discover}` and shall fail if any
      dedicated-handler event is also present in `PI_EVENTS`.

## Dependencies

- `T-150` — confirmed `resources_discover` fires on all three spawn paths
- `T-158` — `BOB_SKILL_INSTALL_PATH` must be set on the child environment for
  this to have anything to read

## Files to Touch

- `the-intern/pi-extension/bob.ts` — remove `resources_discover` from
  `PI_EVENTS`, add a dedicated handler
- `the-intern/pi-extension/bob.test.ts` — add coverage for the new handler
  (present/absent/nonexistent-path env var cases)
- `the-intern/pi-extension/pi-agent-compat.test.ts` — update the
  `PI_EVENTS`-completeness exclusion set (AC-5)
- `the-intern/pi-extension/env.d.ts` — document `BOB_SKILL_INSTALL_PATH`
  alongside the other `BOB_*` environment variables
- `the-intern/pi-extension/README.md` — add `BOB_SKILL_INSTALL_PATH` to the
  "Environment-Variable Contract" section
- `the-intern/docs/src/extension-author-guide/index.md` — correction only,
  two points this task invalidates: the "Event frame — sent for every pi
  event except `tool_call`" claim (line 46) becomes wrong once
  `resources_discover` gets a dedicated handler, and the "Both variables are
  set by the bob service's pi-agent supervisor" enumeration (lines 13-15)
  omits `BOB_SKILL_INSTALL_PATH`. Without these two files-to-touch entries a
  correct implementation leaves shipped user docs contradicting the code, or
  forces a Files-to-Touch boundary escalation (Gate 2 correction,
  2026-08-09)

## Verification

```bash
cd the-intern/pi-extension && npm test
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-10

Implemented T-160 end to end via TDD, five commits on task/T-160-answer-resources-discover-skill-path. Read the ADR-014 decision record and S-003's 2026-08-09 amendment (env var contract for BOB_SKILL_INSTALL_PATH) before writing any code, since the task description referenced both but the task file's Work Log was empty (first session). Confirmed via node_modules/@earendil-works/pi-coding-agent's installed types.d.ts that ResourcesDiscoverResult ({skillPaths?, promptPaths?, themePaths?}) is not part of the package's public export surface (only reachable through the internal dist path, unlike ToolCallEventResult which is exported) — used a local minimal `{ skillPaths?: string[] }` type in the registration cast instead of importing it, following the same cast pattern already used for the tool_call registration.

Four TDD cycles, each red before green: (1) removed resources_discover from PI_EVENTS and added a dedicated (stub) handler + registration, which forced pi-agent-compat.test.ts's PI_EVENTS-completeness test red until the exclusion set was updated to {tool_call, resources_discover} — bundled that fix into the same commit since it was mechanically forced by the PI_EVENTS change and is explicitly required by AC-5; (2) unset/empty BOB_SKILL_INSTALL_PATH -> one warning, no skillPaths; (3) nonexistent path -> one warning, no skillPaths; (4) valid existing path -> {skillPaths: [path]}. Each cycle's test was verified red via `npx vitest run bob.test.ts -t "..."` before implementing, then green via `npm test`. Tests invoke `pi.handlers.get("resources_discover")[0]` directly to capture the handler's return value, mirroring the existing tool_call test pattern — no UDS server needed since this handler never touches the socket.

After the code cycles, updated env.d.ts, README.md, and docs/src/extension-author-guide/index.md per the Files-to-Touch list, including the two specific corrections the task called out (the "Event frame — sent for every pi event except tool_call" claim, and the two-variable supervisor enumeration). Also lightly corrected bob.ts's own top-of-file module doc comment (lines 1-14, not separately listed in Files to Touch but the same file already in scope) since it still said "for all non-tool_call events" after resources_discover also became a dedicated handler — judged this a minimal, same-file accuracy fix rather than scope creep. Verified the mdBook docs still build cleanly after the extension-author-guide edit (`mdbook build` in the-intern/docs, no warnings).

Final state: 6 files touched, exactly matching the task's Files to Touch list (verified via `git diff --stat dev-agent...task/...`). `npm test` in the-intern/pi-extension passes 43/43 (up from the 38 baseline), `npx tsc --noEmit` is clean. Nothing remains for this task; all five acceptance criteria (AC-1 through AC-5) have dedicated test coverage.

Evidence:
- `cd the-intern/pi-extension && npm test` — final run: `Test Files 2 passed (2)`, `Tests 43 passed (43)`.
- `cd the-intern/pi-extension && npx tsc --noEmit` — no output (clean).
- `git diff --stat dev-agent...task/T-160-answer-resources-discover-skill-path` — confirms only the six Files-to-Touch files changed.
- `cd the-intern/docs && mdbook build` — succeeded with no warnings after the extension-author-guide edit.
- Per-cycle red confirmations captured in the transcript (`npx vitest run bob.test.ts -t "T-160 AC-N"` failing before each implementation, passing after).

Obstacles Encountered:
- `ResourcesDiscoverResult` is not part of `@earendil-works/pi-coding-agent`'s public export surface (`dist/index.d.ts`), unlike `ToolCallEventResult`. Worked around by defining a local minimal inline type (`{ skillPaths?: string[] }`) in the registration cast, matching the project's existing pattern of casting `pi` for overloads that are awkward to type generically — no package or config change needed.
- None otherwise; `pi` binary was not needed since `npm test` runs a pure vitest suite with no `pi` process involved.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
