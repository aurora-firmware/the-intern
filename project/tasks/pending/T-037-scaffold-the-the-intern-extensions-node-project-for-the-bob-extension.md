---
id: T-037
title: Scaffold the the-intern/extensions Node project for the bob extension
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-19'
spec: S-003
---

# Scaffold the the-intern/extensions Node project for the bob extension

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

Stand up `the-intern/extensions/` as a TypeScript Node project so the bob
extension (T-038) has somewhere to live, get linted, and be tested. Phase
1 of S-003. No runtime dependencies — the extension uses Node's built-in
`node:net`. Dev-deps cover pi's extension typings and Node's; test runner
is the developer's pick between `vitest` and `node --test`. The existing
`the-intern/extensions/README.md` stub must be rewritten to document the
env-var contract (`BOB_SESSION_ID`, `BOB_EXTENSION_SOCK_PATH`), the two
pi extension install paths (`~/.pi/agent/extensions/` and
`<project>/.pi/extensions/`), and the "bob service vs bob extension"
naming convention from S-003.

## Acceptance Criteria

AC-1: WHEN `npm install` is run in `the-intern/extensions/` THE SYSTEM SHALL install dev-dependencies on `@earendil-works/pi-coding-agent` types, `@types/node`, and a test runner, with no runtime dependencies declared.
AC-2: WHEN `npx tsc --noEmit` is run from `the-intern/extensions/` THE SYSTEM SHALL exit with status 0 against the empty project (no source files yet).
AC-3: WHEN the configured test runner is invoked via the `package.json` `test` script THE SYSTEM SHALL execute and report success against the empty `*.test.ts` set.
AC-4: The `the-intern/extensions/README.md` SHALL document the env-var contract from S-003, the pi install paths, and the bob service / bob extension naming convention.

## Dependencies

- None.

## Files to Touch

- `the-intern/extensions/package.json` — create; declares dev-deps and the `test` script.
- `the-intern/extensions/tsconfig.json` — create; strict TypeScript config that compiles to ESNext/Node targets without emitting JS.
- `the-intern/extensions/README.md` — rewrite from stub to operator-facing install + contract documentation.
- One additional config file for the chosen test runner if needed (e.g. `vitest.config.ts`).

## Verification

```bash
cd the-intern/extensions
npm install
npx tsc --noEmit
npm test
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
