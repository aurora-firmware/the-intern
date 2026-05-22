---
id: T-075
title: Add pi-agent compatibility verification for bob extension
status: in-progress
priority: medium
assigned-role: unassigned
created: '2026-05-22'
---

# Add pi-agent compatibility verification for bob extension

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

The bob extension is coupled to the pi-agent extension API surface exposed by
`@earendil-works/pi-coding-agent`. Its `PI_EVENTS` list and blocking
`tool_call` hook are currently sourced from the installed package types, but the
package is declared as `^0.75.3`, which can silently admit newer versions whose
event names or handler signatures have drifted.

Make compatibility explicit for the tested pi-agent package version:

- Treat `@earendil-works/pi-coding-agent` **0.75.3** as the only supported and
  tested pi-agent API version for this bob extension until a future task updates
  the compatibility record.
- Pin the extension dependency to that exact version, not a semver range.
- Add a Vitest compatibility check that reads the installed
  `@earendil-works/pi-coding-agent/package.json` and fails with a clear message
  when the installed version is not the supported version.
- Extend the compatibility test to prove the fire-and-forget `PI_EVENTS` set in
  `bob.ts` still matches the event names exposed by the installed package types,
  with `tool_call` intentionally excluded because bob handles it through the
  blocking authz path.
- Document the supported version and the failure mode in the root `README.md`
  and `the-intern/extensions/README.md` so operators know when an installed
  pi-agent package is outside the tested compatibility envelope.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: The extension package shall declare
      `@earendil-works/pi-coding-agent` at exact version `0.75.3`, with no
      caret, tilde, or open range.

AC-2: WHEN `npm test` runs in `the-intern/extensions` THE SYSTEM SHALL fail with
      a clear compatibility error if the installed
      `@earendil-works/pi-coding-agent` package version is not `0.75.3`.

AC-3: WHEN `npm test` runs in `the-intern/extensions` THE SYSTEM SHALL verify
      that the bob extension's fire-and-forget `PI_EVENTS` registrations match
      the installed pi-agent package's typed event surface, excluding
      `tool_call` by name because it is handled by the blocking authz hook.

AC-4: The root `README.md` and `the-intern/extensions/README.md` shall document
      that bob extension compatibility is tested against
      `@earendil-works/pi-coding-agent` / pi-agent API version `0.75.3`, and
      that other installed versions are unsupported until the compatibility test
      and documentation are updated.

## Dependencies

- None — this task only touches the extension package and documentation.

## Files to Touch

- `the-intern/extensions/package.json` and `package-lock.json` — pin
  `@earendil-works/pi-coding-agent` to exact version `0.75.3`.
- `the-intern/extensions/bob.ts` and/or `bob.test.ts` — expose or inspect the
  fire-and-forget event list in a way that lets Vitest compare it with the
  installed package's typed event surface, while keeping `tool_call` on the
  blocking authz path.
- `README.md` — document the supported pi-agent API/package version and the
  incompatibility signal.
- `the-intern/extensions/README.md` — document the same compatibility contract
  for extension operators.

## Verification

```bash
cd the-intern/extensions
npm test
npm run typecheck
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-22

Before writing any code, confirmed the Work Log was empty (first session). Read the task, the existing `bob.ts`, `bob.test.ts`, `package.json`, and the installed `@earendil-works/pi-coding-agent` package types to understand the full landscape.

**What was done**

Two TDD cycles landed:

**Cycle 1 (AC-1, AC-2, AC-3):**

Created `pi-agent-compat.test.ts`. The tests drove three changes:
- AC-1 test: reads `extensions/package.json` and asserts the declared version is the bare string `0.75.3` with no `^` or `~`. This caught the existing `^0.75.3` declaration immediately. Fixed by editing both `package.json` and the root entry in `package-lock.json`.
- AC-2 test: reads the installed package's `package.json` and fails with a multi-line diagnostic message if the version is not `0.75.3`. This passed from the start (the installed version was already 0.75.3), confirming the test is correctly checking the right thing.
- AC-3 test: imports `PI_EVENTS` from `bob.ts` as a named export, reads the event names from the installed package's `dist/core/extensions/types.d.ts` by matching `on(event: "name", …)` lines, filters out `tool_call`, and asserts sorted equality. This drove adding `export` to the `PI_EVENTS` constant in `bob.ts`. The existing set matched exactly.

**Cycle 2 (AC-4):**

Added two AC-4 tests to `pi-agent-compat.test.ts` that assert the root `README.md` contains `0.75.3` and the word "unsupported", and that `the-intern/extensions/README.md` contains `0.75.3` and references `npm test` or "incompatib". Both tests failed (READMEs had no such content). Added a "JS Extension — pi-agent Package Compatibility" section to the root README and a "pi-agent Package Compatibility" section to the extensions README. The extensions README section also includes a step-by-step guide for future operators updating the compatibility record.

**What was tried and rejected**

Considered parsing the compiled JS instead of the `.d.ts` file to extract the event surface — rejected because the TypeScript declaration file is the canonical "typed event surface" the task AC-3 specifically references, and it is a stable text format with one overload per line.

Considered deriving the event list from the TypeScript type system at build time using a custom type utility — rejected as over-engineered; reading the `.d.ts` file at test time is simple, transparent, and gives useful error messages when the format changes.

**What remains**

Nothing — all four acceptance criteria have tests and implementations, all 30 tests pass, typecheck is clean, and both README files carry the required documentation.

Commits on `task/T-075-pi-agent-compatibility-verification`:
- `2f65665 feat(extensions): add pi-agent compatibility verification tests`
- `7559780 docs(extensions): document pi-agent 0.75.3 compatibility contract`

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-22

PASS

**Stage 1 — Spec compliance:** All four acceptance criteria are met.

- AC-1: `the-intern/extensions/package.json` and `package-lock.json` both declare `@earendil-works/pi-coding-agent` at exact version `0.75.3` with no caret or tilde. Verified by diff and by the AC-1 test.
- AC-2: `pi-agent-compat.test.ts` reads the installed package's `package.json` and asserts the version equals `0.75.3`, emitting a multi-line diagnostic error on mismatch. Test passes.
- AC-3: `pi-agent-compat.test.ts` dynamically imports `PI_EVENTS` from `bob.ts` (now a named export), parses the installed package's `dist/core/extensions/types.d.ts` for `on()` overloads, excludes `tool_call`, and asserts sorted equality. `bob.ts` has only the single `export` keyword added; the event list is unchanged. Test passes.
- AC-4: Root `README.md` and `the-intern/extensions/README.md` both document `0.75.3` as the supported version, state that other versions are unsupported, and describe the `npm test` failure signal. Two AC-4 tests confirm the content programmatically.

No unspecified files were modified. All six files touched are within the task's stated scope.

**Stage 2 — Code quality:**

- Correctness: Test logic correctly parses the `.d.ts` format using a line-anchored regex and throws an informative error if no overloads are found (guards against silent misparse). Error messages are actionable.
- Tests: 30 tests pass (`npm test`). The new test file covers both the passing case and the shape of failure messages. Tests are independent (no shared mutable state). `npm run typecheck` exits clean.
- Security: No hardcoded secrets, no external I/O beyond the local filesystem. File paths are constructed from `import.meta.dirname`, not user input.
- Readability: File is well-structured with section dividers, descriptive helper names, and a module-level doc comment. The `SUPPORTED_PI_AGENT_VERSION` constant makes the sentinel value easy to locate.
- Performance: Only file reads; no loops over large data sets or blocking calls in hot paths.

Minor observation (non-blocking): the AC-3 test describe label says "excluding tool_call" but the test body compares sorted arrays reporting both `missing` and `extra` items, which means it would also catch events added to `PI_EVENTS` that are not in the package surface. This is correct and conservative behaviour — just worth noting that the test is stricter than the AC wording alone suggests.
