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

### Session 2 — 2026-08-10

Addressed the sole Stage 2 blocking issue from the 2026-08-10 review verdict: `handleResourcesDiscover` used `fs.existsSync(skillInstallPath)`, a synchronous blocking filesystem call on the extension's event loop, violating coding-guidelines-node.md §6 and the Stage 2 performance checklist.

Followed TDD: first tried `vi.spyOn(fs, "existsSync")` to assert the sync call was never made, but Vitest rejected it (`Cannot spy on export "existsSync". Module namespace is not configurable in ESM.`) since `bob.ts` and `bob.test.ts` both import `node:fs` via `import * as fs from "node:fs"` and Vitest can't redefine ESM namespace exports without `vi.mock`. Rejected reaching for `vi.mock("node:fs", ...)` as too invasive — nearly every test in the file (including `beforeEach`/`afterEach`) uses real `fs` calls for temp-dir setup/teardown, and partially mocking the module risked destabilizing unrelated tests. Instead wrote a black-box test on the handler's public contract: added `describe("T-160 review-fix: handleResourcesDiscover does not block the event loop", ...)` in `bob.test.ts`, asserting the value returned by calling the registered `resources_discover` handler is `instanceof Promise` (mirroring the already-async `handleToolCall` registration pattern) and still resolves to the correct `skillPaths`. Verified red first: `npx vitest run bob.test.ts -t "T-160 review-fix"` failed with `expected { Object (skillPaths) } to be an instance of Promise` against the pre-fix synchronous handler.

Implemented the minimal fix: made `handleResourcesDiscover` `async`, changed its return type to `Promise<{ skillPaths?: string[] } | void>`, and replaced `fs.existsSync(skillInstallPath)` with `try { await fs.promises.access(skillInstallPath); } catch { ... }` (the reviewer's suggested async equivalent — `access` rejects on a missing/inaccessible path, which the catch branch treats the same as the old boolean-negative branch: warn once, contribute no skill paths). Updated the `pi.on("resources_discover", ...)` registration's inline cast type to match the new `Promise<...>` return type, keeping it consistent with the existing `handleToolCall` cast just above it.

Verified green: the new test passes, and none of the four existing AC-2/AC-3/AC-4 tests needed any change — they already `await handlers[0]!(...)`, so making the handler `async` was transparent to them. Full suite: `npm test` → 44/44 passing (up from the reviewer's 43, the delta being the one new regression test). `npx tsc --noEmit` clean. `git diff --stat dev-agent...task/T-160-...` confirms only `bob.ts` and `bob.test.ts` changed in this session, and the task's full six-file Files-to-Touch scope remains unchanged overall. Committed as a single commit (`9997b9b fix(pi-extension): make resources_discover handler async`) on `task/T-160-answer-resources-discover-skill-path`. Nothing remains outstanding for this review-fix cycle; ready for re-review.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-10

FAIL

**Stage 1 — Acceptance criteria: all met.**
- AC-1: `resources_discover` removed from `PI_EVENTS` (`bob.ts` — the array
  no longer includes it); covered by
  `bob.test.ts` "T-160 AC-1" and `pi-agent-compat.test.ts`'s updated
  completeness check.
- AC-2: `handleResourcesDiscover` returns `{ skillPaths: [path] }` when
  `BOB_SKILL_INSTALL_PATH` is set, non-empty, and exists; covered by
  `bob.test.ts` "T-160 AC-2".
- AC-3: unset/empty var → no skill paths, exactly one `warn()` call, no
  throw; covered by `bob.test.ts` "T-160 AC-3" (both the unset and empty
  cases).
- AC-4: nonexistent path → no skill paths, exactly one `warn()` call, no
  throw; covered by `bob.test.ts` "T-160 AC-4".
- AC-5: `pi-agent-compat.test.ts`'s exclusion set is now
  `{tool_call, resources_discover}`; the `extra` assertion fails the check
  if either dedicated-handler event reappears in `PI_EVENTS`, satisfying the
  "shall fail if any dedicated-handler event is also present" clause.
- Files touched exactly match the Files-to-Touch list (6 files, verified via
  `git diff --stat dev-agent...task/T-160-answer-resources-discover-skill-path`);
  no unexpected files modified. `npm test` reproduces 43/43 passing
  (up from the 38 baseline); `npx tsc --noEmit` is clean; `mdbook build` in
  `the-intern/docs` succeeds with no warnings and the new
  `#skill-supply-via-resources_discover` anchor link resolves correctly
  against the generated heading id. No unspecified behavior was added; the
  self-noted module-doc-comment touch-up (lines 1-14) is in-scope same-file
  accuracy, not scope creep.

**Stage 2 — Code quality: one blocking issue.**

- **File and location:** `the-intern/pi-extension/bob.ts`, line 451, inside
  `handleResourcesDiscover` (registered as the `resources_discover` handler
  at the bottom of the file).
- **What is wrong:** `fs.existsSync(skillInstallPath)` is a synchronous,
  blocking filesystem call made directly on the extension's event loop, once
  per session at `resources_discover` time. This violates
  `docs/ai-team/docs/coding-guidelines-node.md` §6 ("Hook code must be short
  and bounded. Do not do CPU-heavy inspection, large synchronous parsing,
  blocking filesystem work, or long retry loops on the event loop.") and the
  Stage 2 performance checklist ("No unnecessary loops, blocking calls, or
  resource leaks"). It is also the only production-code (non-test) use of a
  `*Sync` fs call anywhere in `the-intern/pi-extension/` — there is no
  existing precedent for it in `bob.ts`.
- **What should change:** Use an async existence check (e.g.
  `await fs.promises.access(skillInstallPath)` inside a try/catch, or
  `fs.promises.stat`) and make `handleResourcesDiscover` an `async` function
  returning a `Promise`. This is a mechanical change with no effect on
  behavior or the acceptance criteria: the installed package's
  `ExtensionHandler<E, R>` type is
  `(event: E, ctx: ExtensionContext) => Promise<R | void> | R | void`, so an
  async handler is already a supported registration shape — the same shape
  already used for `handleToolCall` — and the existing tests already
  `await handlers[0]!(...)`, so no test rewrite is needed beyond confirming
  they still pass.

Everything else reviewed clean: no hardcoded secrets, `warn()` reused
correctly (existing helper, ctx.ui/stderr branches both already covered by
existing tests), tests are independent (`beforeEach`/`afterEach` reset
`tmpDir`/`sockPath`/all three `BOB_*` env vars, no shared mutable state
across the new describe blocks), naming and comments are clear, and
`env.d.ts`/`README.md`/`extension-author-guide/index.md` accurately reflect
the fail-open contract from S-003's 2026-08-09 amendment and ADR-014.

Next: Developer fixes the single blocking-call issue above and resubmits.

### Review Verdict — 2026-08-10

PASS

**Re-review scope:** Session 2's Work Log documents a fix for the sole Stage
2 blocking issue from the prior FAIL verdict (`fs.existsSync()` blocking the
event loop in `handleResourcesDiscover`). Verified that fix specifically,
then re-ran the full two-stage review on the current branch tip
(`task/T-160-answer-resources-discover-skill-path`, commit `9997b9b`).

**Targeted fix verification.**
- `the-intern/pi-extension/bob.ts`: `handleResourcesDiscover` is now
  `async` and returns `Promise<{ skillPaths?: string[] } | void>`; the body
  replaces `fs.existsSync(skillInstallPath)` with
  `try { await fs.promises.access(skillInstallPath); } catch { ... }`,
  matching the async `ExtensionHandler<E, R>` shape already used by
  `handleToolCall`. The `pi.on("resources_discover", ...)` registration
  cast's return type was updated to match. `grep -n "Sync(" bob.ts` returns
  no matches — no synchronous fs (or other blocking) call remains in the
  file.
- Confirmed the new regression test
  (`"T-160 review-fix: handleResourcesDiscover does not block the event
  loop"` in `bob.test.ts`) is a genuine red/green test, independently: ran
  it against a temporary copy of `bob.ts` restored to the pre-fix commit
  (`9997b9b^`) with the current test file — it failed with `expected {
  Object (skillPaths) } to be an instance of Promise`, then restored the
  fixed `bob.ts` and confirmed the suite is green again (working tree left
  clean, matching the committed state throughout).
- The fix is minimal: commit `9997b9b` touches only `bob.ts` (13 lines) and
  `bob.test.ts` (+34 lines, new test only) — no unrelated refactoring.

**Stage 1 — Acceptance criteria: all still met** (re-checked against the
current tip; the async change is behavior-preserving for AC-1 through AC-5):
- AC-1: `resources_discover` is absent from `PI_EVENTS` (`bob.ts:73` array;
  confirmed via `grep -n "resources_discover" bob.ts` — only doc comments
  and the dedicated-handler registration reference it); covered by
  `bob.test.ts` "T-160 AC-1" and `pi-agent-compat.test.ts`.
- AC-2: valid existing `BOB_SKILL_INSTALL_PATH` → `{ skillPaths: [path] }`;
  covered by `bob.test.ts` "T-160 AC-2" (still passes unchanged with the
  handler now async, since the test already awaits the handler's result).
- AC-3: unset/empty → no skill paths, one `warn()`, no throw; covered by
  "T-160 AC-3" (both cases).
- AC-4: nonexistent path → no skill paths, one `warn()`, no throw; covered
  by "T-160 AC-4".
- AC-5: `pi-agent-compat.test.ts`'s `DEDICATED_HANDLER_EVENTS` exclusion set
  is `{tool_call, resources_discover}` and the completeness check fails if
  either reappears in `PI_EVENTS`; confirmed via direct read of the test
  file.
- Files touched across the whole task branch remain exactly the six
  Files-to-Touch entries (`git diff --stat
  dev-agent...task/T-160-answer-resources-discover-skill-path`); no
  unexpected files modified. No unspecified behavior was added.

**Stage 2 — Code quality: clean, no blocking issues.**
- **Correctness:** the `try { await fs.promises.access(...) } catch { ... }`
  branch is the correct async equivalent of the removed
  `!fs.existsSync(...)` check — `access()` rejects on a missing or
  inaccessible path, and the catch branch takes the same warn-and-return-void
  path the old boolean-negative branch took. Behavior is unchanged for all
  four ACs.
- **Tests:** `npm test` in `the-intern/pi-extension` reproduces `Test Files
  2 passed (2)`, `Tests 44 passed (44)` (up from 43, the delta being the one
  new regression test); `npx vitest run bob.test.ts -t "T-160 review-fix"`
  passes in isolation; `npx tsc --noEmit` is clean. The new test is
  independent — reuses the existing `beforeEach`/`afterEach` fixture that
  creates a fresh `tmpDir` and clears all three `BOB_*` env vars per test, no
  shared mutable state.
- **Security:** no change to input validation or secret handling from the
  prior review.
- **Readability:** the new `describe` block is clearly named and comment-
  labelled "T-160 review-fix"; the async conversion is a small, self-
  contained diff with no dead code left behind.
- **Performance:** the blocking-call issue is resolved — no synchronous fs
  call remains in `bob.ts` production code (verified via grep, see above).

No new issues found. Everything previously reviewed clean in the 2026-08-10
first-entry verdict (secrets, `warn()` reuse, test independence, naming,
`env.d.ts`/`README.md`/`extension-author-guide/index.md` accuracy) is
unaffected by this session's change and remains clean, since session 2 only
touched `bob.ts` and `bob.test.ts`.

Next: task is ready for integration.
