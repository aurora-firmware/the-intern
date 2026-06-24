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

### Session 1 — 2026-06-24

Retired the admin-socket interactive-chat dispatch path and removed the chat
admission stopgap.

**Key decisions and boundary notes (for the reviewer):**

1. **chat-adapter crate removed entirely** — it had no callers after removing
   admin-rpc's dependency. The workspace `members = ["crates/*"]` glob made this
   automatic once the directory was deleted. The scheduler-adapter never depended
   on it (confirmed by grep — the scheduler uses `requests-handler::Handle`
   directly). The "channel-adapter framework" the task asked to preserve for the
   scheduler is the generic intake/supervision in `requests-handler`, which is
   untouched; the chat-adapter crate itself was interactive-chat-specific and had
   no remaining consumer.

2. **ChannelsConfig / ChatChannelConfig removed from BobConfig** — these fields
   served only to gate chat-adapter startup in `serve.rs`. With the chat-adapter
   gone, the config structs are dead weight. `shell_e2e.rs` was the only external
   consumer; updated there.

3. **`admitted_users` stopgap fully removed** — the `scripts/bob-dev-config/`
   tree is gone along with the `XDG_CONFIG_HOME` override in `scripts/bob-dev.sh`.
   Per ADR-010 the new `bob chat` is socket-gated; no pre-flight identity
   admission is needed.

4. **Preserved untouched**: `SubscriptionBus`, the `audit.tail.*` handlers and
   tests, all `session.interactive.*` handlers and tests (the new T-104/105/106
   path), `scheduler-adapter`, `requests-handler`, the `ConnectionRegistry` audit
   path, and the `admin_rpc.rs` client tests.

5. **Two commits as specified**: service-code retirement first
   (`767b444 feat(admin-rpc,bob): retire admin-socket interactive-chat dispatch`,
   13 files, -3138 lines), then scripts cleanup
   (`305589b fix(scripts): remove chat admission stopgap from dev environment`).

**Obstacles Encountered:** A previous working session had removed the production
code but left a second batch of `chat.send` tests in `dispatch.rs` that still
referenced deleted types; that removal was completed cleanly in this session.

**What remains:** nothing for this task.

Evidence: `cargo build --workspace` clean after each change set; `cargo test
--workspace` 25 suites all `ok`, 0 failed; `cargo fmt --all -- --check` clean.
Commits `767b444`, `305589b` on branch
`task/T-107-retire-the-admin-socket-interactive-chat-path-and-remove-the-chat-admission-stopgap`.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-06-24

PASS

#### Stage 1 — Acceptance Criteria

**AC-1: Admin-socket interactive-chat dispatch removed; channel-adapter framework preserved.**

Verified by code inspection and grep across the task branch:

- `chat_router.rs` deleted entirely.
- `dispatch.rs`: `chat.open`, `chat.close`, `chat.send` handlers removed; `ChatHandle`, `ChatReplyRouter` fields removed from `Dispatcher`; `ChatSubscribed` and `ChatUnsubscribed` variants removed from `DispatchOutcome`. The `session.interactive.open` handler and all `audit.tail.*` handlers are fully intact.
- `lib.rs`: `chat_forwarder` task removed; `ConnectionRegistry` construction no longer attaches a chat router; `chat_adapter` and `chat_router` fields removed from `Config`. The `audit_forwarder`, `SubscriptionBus`, and `InteractiveSessionConfig` paths are untouched.
- `subscriptions.rs`: `SubscriptionKind::Chat` variant and all chat-subscription methods (`open_chat`, `close_chat`, `is_chat_subscription`, `with_chat_router`) removed from `ConnectionRegistry`. `SubscriptionBus` and audit subscription logic are untouched.

**Critical question — wholesale chat-adapter crate deletion vs. framework preservation:**

Independently verified that the "channel-adapter framework" the task was protecting is `requests-handler::Handle`, not the `chat-adapter` crate:

1. `scheduler-adapter/src/lib.rs` line 8: `use requests_handler::Handle as IntakeHandle;` — the scheduler-adapter imports directly from `requests-handler`, never from `chat-adapter`.
2. `scheduler-adapter/Cargo.toml`: no dependency on `chat-adapter`.
3. `admin-rpc/Cargo.toml`, `bob/Cargo.toml` (task branch): neither lists `chat-adapter`.
4. No remaining workspace member references `chat-adapter` or `ChannelsConfig`/`ChatChannelConfig` after the removals.
5. `requests-handler` crate is entirely untouched; `scheduler-adapter` tests (8/8 passing) and `serve.rs` scheduler wiring compile and run clean.

CR-002's text ("The adapter path is retained only as a possible basis for a future programmatic chat-over-admin.sock channel") describes an architectural possibility, not an obligation to retain dead code. S-006's amendment log explicitly marks Component 4 (interactive-chat adapter) as "superseded for interactive chat." The task's own "Files to Touch" section lists `the-intern/service/crates/chat-adapter/` as a target for removal. Deleting the crate is consistent with the task specification, CR-002 intent, and the S-006 amendment.

**AC-2: chat admission stopgap removed.**

- `scripts/bob-dev-config/bob/config.toml` deleted entirely (the `[policy] admitted_users` stopgap).
- `scripts/bob-dev.sh`: `XDG_CONFIG_HOME` export line removed. Confirmed by diff inspection.

**AC-3: `cargo test --workspace` and `cargo fmt --all -- --check` pass.**

Ran both commands from a git worktree of the task branch. Results:
- `cargo fmt --all -- --check`: clean (no output, exit 0).
- `cargo test --workspace`: 25 test suites, all `ok`, 0 failures. Total tests across suites: 479 passing.

#### Stage 2 — Code Quality

- **Correctness:** All removals are complete with no dangling references. The `ConnectionRegistry::Drop` impl no longer contains the `SubscriptionKind::Chat` arm (which would have been dead code after removing the variant). No orphaned import or unused variable warnings.
- **Tests:** The deleted `chat_e2e.rs` covered only the deleted functionality. `shell_e2e.rs` is correctly updated to drop `ChannelsConfig`/`ChatChannelConfig` from its `BobConfig` construction. The `session.interactive.*` and `audit.tail.*` tests in `admin-rpc/src/lib.rs` are fully intact and pass.
- **Security:** No new exposure introduced. Chat-admission exemption (ADR-010) is now enforced by the absence of the chat path, not by a runtime gate; consistent with the ADR.
- **Readability:** Removals are clean; doc-comments in `subscriptions.rs` updated to remove the now-false chat-subscription lifecycle section.
- **Performance:** No concerns.

**Diff scope check:** Every touched file is a necessary consequence of removing the chat-adapter crate and its dependents:
- `subscriptions.rs` — had chat-subscription methods and the `Chat` variant wired to the router.
- `lib.rs` — hosted `chat_forwarder` and the `ChatSubscribed`/`ChatUnsubscribed` dispatch arms.
- `config.rs` — held `ChannelsConfig`/`ChatChannelConfig` and `chat_application_identity`.
- `shell_e2e.rs` — consumed `ChannelsConfig`/`ChatChannelConfig` in its `BobConfig` construction.
- `chat_e2e.rs` — tested the deleted chat dispatch path exclusively.
- `chat-adapter/` — the deleted crate itself.
- `Cargo.lock` — auto-updated when the crate was removed.

No file was touched beyond what the removal required.
