---
id: T-107
title: Retire the admin-socket interactive-chat path and remove the chat 
  admission stopgap
status: pending
priority: medium
assigned-role: developer
created: '2026-06-23'
spec: CR-002
---

# Retire the admin-socket interactive-chat path and remove the chat admission stopgap

## Description

Per CR-002 (S-006 interactive-chat adapter superseded, S-008 superseded) and
ADR-010, remove the now-dead admin-socket interactive-chat dispatch from
`bob serve`: the interactive-chat adapter wiring, the chat reply router, and the
`chat.open` / `chat.send` / `chat.message` handlers — insofar as they served
interactive chat. **Keep the channel-adapter framework** (intake handle, config,
supervision) that the scheduler adapter (S-009) depends on. Also remove the chat
admission stopgap added earlier: the `scripts/bob-dev-config` `[policy]` admission
of the chat identity and the `XDG_CONFIG_HOME` wiring in `scripts/bob-dev.sh`
(chat is no longer admission-gated, ADR-010). If the file count makes this hard to
one-shot, split the code retirement from the script cleanup.

## Acceptance Criteria

AC-1: The system shall remove the admin-socket interactive-chat dispatch (chat
      adapter wiring, reply router, `chat.*` handlers) from `bob serve` while
      preserving the channel-adapter framework used by the scheduler.

AC-2: The system shall remove the `scripts/bob-dev-config` chat admission stopgap
      and the corresponding `XDG_CONFIG_HOME` wiring in `scripts/bob-dev.sh`.

AC-3: The system shall pass `cargo test --workspace` with no new failures.

## Dependencies

- `T-106` — the new launcher must replace the old REPL before the server-side
  path is removed.

## Files to Touch

- `the-intern/service/crates/bob/src/serve.rs` — drop the chat-adapter / reply
  wiring.
- `the-intern/service/crates/admin-rpc/src/` (`chat_router.rs`, `dispatch.rs`) —
  remove the chat dispatch/router.
- `the-intern/service/crates/chat-adapter/` — remove the interactive-chat adapter.
- `scripts/bob-dev.sh`, `scripts/bob-dev-config/bob/config.toml` — remove the
  stopgap.

## Verification

```bash
cd the-intern/service && cargo test --workspace
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
