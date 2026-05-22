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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
