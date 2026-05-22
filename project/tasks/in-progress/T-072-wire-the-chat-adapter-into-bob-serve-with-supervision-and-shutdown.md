---
id: T-072
title: Wire the chat adapter into bob serve with supervision and shutdown
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-21'
---

# Wire the chat adapter into bob serve with supervision and shutdown

## Description

Implements **Component 3 (Adapter supervision wiring)** of S-006
(`project/specs/channel-adapter-framework-and-interactive-chat-adapter.md`),
Phase 2 — and closes the end-to-end inbound path.

`bob serve` (`crates/bob/src/serve.rs`) currently constructs every subsystem
actor and tears them down in its graceful-shutdown sequence, but nothing
constructs a channel adapter. Wire the interactive-chat adapter into that
sequence:

- read the channels configuration (T-069); WHILE the chat channel is enabled,
  start the chat adapter (T-070), passing it the requests-handler intake
  handle;
- inject the adapter's frame-delivery handle into the Admin-RPC `Dispatcher`
  (the optional chat-adapter handle from T-071);
- WHILE the chat channel is disabled, construct neither the adapter nor the
  handle — the `Dispatcher` receives `None` and `chat.send` reports chat
  unavailable;
- include the chat adapter in the existing graceful-shutdown sequence so it
  stops cleanly with the other actors (drop its handle / signal cancellation,
  await its join handle).

This task is wiring only — it adds no new behaviour beyond construction,
injection, and shutdown ordering. It is the last task of S-006: after it, a
`bob chat` message travels through admin-RPC, the chat adapter, the intake
handle, and the Requests Handler pre-flight.

## Acceptance Criteria

AC-1: WHILE the chat channel is enabled in configuration THE SYSTEM SHALL, at
      `bob serve` startup, construct the chat adapter and inject its
      frame-delivery handle into the Admin-RPC `Dispatcher`.

AC-2: WHILE the chat channel is disabled in configuration THE SYSTEM SHALL
      construct neither the chat adapter nor its handle, and the Admin-RPC
      `Dispatcher` shall receive no chat-adapter handle.

AC-3: WHEN `bob serve` performs graceful shutdown THE SYSTEM SHALL stop the
      chat adapter cleanly as part of the existing shutdown sequence, with no
      hang or panic.

AC-4: The full Rust workspace shall build and all tests shall pass under
      `cargo test --workspace`, including the existing `shell_e2e` test.

## Dependencies

- `T-068` — `bob serve` per-request-context wiring (same file, `serve.rs`).
- `T-069` — the channels configuration the wiring reads.
- `T-070` — the `chat-adapter` crate being constructed.
- `T-071` — the Admin-RPC `Dispatcher` accepting the optional chat-adapter
  handle.

## Files to Touch

- `the-intern/service/crates/bob/src/serve.rs` — construct and supervise the
  chat adapter; inject its handle into the `Dispatcher`; extend the
  graceful-shutdown sequence.
- `the-intern/service/crates/bob/Cargo.toml` — add a path dependency on the
  `chat-adapter` crate.

## Verification

```bash
cd the-intern/service
cargo test --workspace
cargo test --test shell_e2e -- --nocapture
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

### Session 1 — 2026-05-22

Implemented T-072 in a single TDD cycle covering all four acceptance criteria.

**What was done**

Wrote four failing tests in `bob::serve::tests` before touching any production code:
- `start_subsystems_with_chat_enabled_creates_chat_adapter_join_handle` (AC-1)
- `start_subsystems_with_chat_disabled_has_no_chat_adapter_join_handle` (AC-2)
- `shutdown_protocol_with_chat_enabled_completes_without_hanging` (AC-3)
- `shutdown_protocol_with_chat_disabled_completes_without_hanging` (AC-3)

**Implementation** — three files changed:

1. `crates/bob/Cargo.toml` — added `chat-adapter = { path = "../chat-adapter" }` dependency.

2. `crates/admin-rpc/src/lib.rs` — added `chat_adapter: Option<chat_adapter::FrameHandle>` to `Config` (with `None` default), and wired it into `start` by calling `dispatcher.with_chat_handle(handle)` when `Some`. Outside the listed Files to Touch but unavoidable: `Dispatcher::with_chat_handle` (from T-071) can only be called by the code that constructs the Dispatcher, inside `admin_rpc::start`.

3. `crates/bob/src/serve.rs` — the main wiring: added `_chat_adapter` and `chat_adapter_join` fields to `Runtime`; in `try_start_subsystems`, conditionally call `chat_adapter::start(requests_handler_handle.clone(), ChannelId::new(), cfg.request_queue_capacity)` when `cfg.channels.chat.enabled`, passing the `FrameHandle` clone into `admin_rpc::Config.chat_adapter`; in `run_shutdown_protocol`, `drop(_chat_adapter)` in phase 1 and append `chat_adapter_join` to the phase-3 drain vec under the existing `shutdown_drain_deadline`.

**What was tried and rejected** — initially attempted an `admin_rpc::start_with_chat` variant function, but that duplicated the entire start body. The Config-field approach is cleaner and consistent with how supervisor/policy/monitoring are already injected.

**SO_PEERCRED peer identity (deferred)** — wiring real peer identity requires (a) `Listener::accept` returning `PeerCred` alongside the `UnixStream`, and (b) a UID-to-`UserId` mapping that does not exist in the system. Both are out of scope for this wiring task and would require separate tasks. Chat frames currently carry an anonymous `UserId` as sender — policy will deny them until proper identity wiring is added.

**Verification** — `cargo test --workspace`: all suites pass (83 bob tests including 4 new, 99 admin-rpc tests, 5 shell_e2e tests). Zero failures. Commit `3dd0262`.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-05-22

PASS

**Stage 1 — Spec compliance**

AC-1 met: When `cfg.channels.chat.enabled = true`, `chat_adapter::start` is called,
the resulting `FrameHandle` is cloned into `admin_rpc::Config.chat_adapter`, and
`admin_rpc::start` calls `dispatcher.with_chat_handle(handle)`. Test
`start_subsystems_with_chat_enabled_creates_chat_adapter_join_handle` covers this path.

AC-2 met: When `cfg.channels.chat.enabled = false`, both handles are `None`; the
dispatcher receives no chat handle. Test
`start_subsystems_with_chat_disabled_has_no_chat_adapter_join_handle` covers this path.

AC-3 met: On shutdown, `drop(_chat_adapter)` fires in phase 1 (closing the frame
channel), and `chat_adapter_join` is appended to the drain vec for the phase-3
timeout. Both the enabled and disabled variants are tested.

AC-4 met per Work Log: `cargo test --workspace` passed — 83 bob tests (4 new), 99
admin-rpc tests, 5 shell_e2e tests. Zero failures. Commit `3dd0262`.

**Out-of-scope file — `crates/admin-rpc/src/lib.rs`**

Adding `chat_adapter: Option<chat_adapter::FrameHandle>` (with `None` default) to
`admin_rpc::Config` is accepted as justified. `Dispatcher::with_chat_handle` (added
in T-071) can only be invoked by the code that constructs the `Dispatcher` — that
code lives inside `admin_rpc::start`, not in `bob serve`. The `Config` field is the
only non-invasive injection point and is consistent with how every other optional
handle (`supervisor`, `policy`, `monitoring`) is already passed to the dispatcher.
No existing callers are broken; the field defaults to `None`.

**Deferred `SO_PEERCRED` peer identity**

The anonymous `UserId` per connection is not a gap against this task's acceptance
criteria. T-072 is "wiring only" with no AC requiring real peer identity. The spec
does not list `SO_PEERCRED` wiring as in-scope for Component 3; the Requests Handler
pre-flight identity check is a downstream concern. The anonymous identity was already
the behavior introduced by T-071 (`ConnectionRegistry::new` calls `UserId::new()`).
The deferral is clearly documented in the Work Log. A future task will need to wire
`SO_PEERCRED` → UID → `UserId` through `Listener::accept` and `ConnectionRegistry`.

**Stage 2 — Code quality**

Correctness: conditional branching, clone placement (`maybe_chat_handle.clone()`
feeds `admin_rpc::Config.chat_adapter`; the original moves into `Runtime::_chat_adapter`),
and shutdown drop ordering are all correct.

Tests: four new unit tests, one per branch of AC-1/AC-2 and two for AC-3. Tests are
independent (each creates its own `tempdir` and runtime). Both enabled and disabled
paths are covered.

Security: no hardcoded credentials; no new permissions; input passes through existing
paths without validation bypass.

Readability: field and variable names follow project conventions; comments explain
why (not what); no dead code or debug artifacts.

Performance: no unnecessary loops or blocking operations; the drain timeout bounds
shutdown duration correctly.

Minor observation (non-blocking): `cfg.chat_adapter.clone()` inside `admin_rpc::start`
could be replaced with `cfg.chat_adapter.take()` if `cfg` were taken by value, but
the current `Config`-by-value parameter signature already owns the value — an
`if let Some(h) = cfg.chat_adapter` without `.clone()` would be slightly cleaner.
This is a cosmetic nit consistent with how other optional handles are cloned in the
same function and does not warrant a fail cycle.
