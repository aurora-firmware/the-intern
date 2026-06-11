---
id: T-091
title: Update user documentation for interactive bob chat
status: pending
priority: low
assigned-role: developer
created: '2026-06-11'
spec: S-008
---

# Update user documentation for interactive bob chat

## Description

Bring the user documentation in line with the S-008 chat behaviour. The
mdBook sources live in `the-intern/docs/src/`; the end-user guide
(`end-user-guide/index.md`) covers `bob chat` today.

Document: the `chat.send` params contract (`id`, `text`,
`application_identity`, optional `context_id`) and the `chat.message`
notification shape (`params.subscription`, `params.data` with a `text`
string for human-readable replies); the `--session` flag as selecting the
conversation context (it now maps to `context_id`); the `--json` output
mode for notifications; and an explicit note that replies require the
reply-producing pipeline from roadmap Phase 2 — until it lands, the
service delivers replies only when something injects them at the service
boundary. Remove or correct any text describing chat as send-only or the
old `session` wire field. Match the structure and tone of the surrounding
guide pages.

## Acceptance Criteria

AC-1: The documentation shall state the `chat.send` params contract and
the `chat.message` notification shape exactly as defined in S-008's wire
contract.

AC-2: The documentation shall describe `--session` as selecting the
conversation context (`context_id`) and shall note that reply generation
arrives with the Phase 2 pipeline.

AC-3: WHEN the documentation build runs THE SYSTEM SHALL build cleanly
with no broken links introduced by this change.

## Dependencies

- `T-086` — the documented push behaviour must exist.
- `T-088` — the documented params contract must be what the CLI sends.

## Files to Touch

- `the-intern/docs/src/end-user-guide/index.md` — chat usage, flags,
  output modes, current limitations.
- `the-intern/docs/src/SUMMARY.md` — only if a new page is added.

## Verification

```bash
cd the-intern/docs && mdbook build
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
