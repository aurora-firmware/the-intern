---
id: T-088
title: Map CLI --session to context_id and retire the session wire field
status: pending
priority: medium
assigned-role: developer
created: '2026-06-11'
spec: S-008
---

# Map CLI --session to context_id and retire the session wire field

## Description

Make `bob chat --session X` meaningful by sending the value the server
actually reads (Component 4 of S-008, params half).

Today `build_chat_send_params` in
`crates/bob/src/cli/commands/chat.rs` sends a `session` key that the
server ignores, while `handle_chat_send` reads optional
`params.context_id` into the pipeline's `RequestContext`. Change the CLI
to send `context_id` (from `--session`) in `chat.send` params and to stop
sending the `session` key entirely; likewise stop sending the
`{"session": …}` params object on `chat.open` (the server accepts no
params there). Update the unit tests in the same file that currently pin
the `session` key, including the B-008 regression tests, to pin the new
contract instead. CLI flag surface (`--session`) is unchanged.

## Acceptance Criteria

AC-1: WHEN `bob chat --session X` sends a message THE SYSTEM SHALL include
`params.context_id` equal to `X` and SHALL NOT include a `session` key in
the `chat.send` params.

AC-2: WHEN `--session` is not provided THE SYSTEM SHALL omit `context_id`
from `chat.send` params.

AC-3: WHEN opening the chat THE SYSTEM SHALL send `chat.open` without a
`session` key.

AC-4: The system shall continue to send `params.id`, `params.text`, and
`params.application_identity` on `chat.send` exactly as before.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/bob/src/cli/commands/chat.rs` —
  `build_chat_send_params`, the `chat.open` params, and their unit tests.

## Verification

```bash
cd the-intern/service && cargo test -p bob --lib chat && cargo fmt --all -- --check
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
