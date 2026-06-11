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

### Session 1 — 2026-06-11

Implemented T-088 in a single red→green→refactor TDD cycle. The task required two small, targeted changes to `the-intern/service/crates/bob/src/cli/commands/chat.rs`:

1. **`chat.open` params (AC-3):** The `run_with_parts_async` function previously built `open_params` with a `{"session": id}` branch and an empty-object branch. Replaced this with a single unconditional `json!({})` — the server accepts no params on `chat.open`.

2. **`chat.send` params (AC-1, AC-2, AC-4):** `build_chat_send_params` previously used `"session"` as the key when a session was provided. Changed the key to `"context_id"`. The `None`-session branch was left unchanged (it already omitted the key entirely, satisfying AC-2). The `id`, `text`, and `application_identity` fields are untouched (AC-4).

Test changes: Updated `chat_opens_with_session_and_sends_each_input_line` to assert `params == json!({})` on open (AC-3) and `"context_id"` rather than `"session"` in send params (AC-1). Added `chat_send_params_omit_context_id_when_session_not_provided` to explicitly pin AC-2: no `context_id` and no `session` key in send params when `--session` is absent.

No approaches were tried and rejected — the mapping was straightforward. The `--session` CLI flag surface is unchanged, only the wire keys emitted to the server changed. Total tests went from 14 to 15; all pass. Format check clean.

Nothing remains.

Evidence: baseline 14/14 pass; red run failed as expected on open-params assertion; green run 15/15 pass; `cargo test -p bob --lib chat && cargo fmt --all -- --check` clean. Commit `2950b05` on `task/T-088-map-cli-session-to-context-id-and-retire-the-session-wire-field`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
