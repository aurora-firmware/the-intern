# PR Review: aurora-firmware/the-intern#20 — feat(chat): S-008 interactive bob chat — push channel, session routing, and docs

## Summary

This PR delivers the full outbound chat path for `bob chat` (spec S-008): a per-session reply router in `admin-rpc`, forwarder tasks that push `chat.message` notifications to subscribers, `--session`→`context_id` mapping, frame-safe CLI receive loop, an end-to-end integration test, and user documentation updates. The implementation is well-structured and the test coverage is solid. Two correctness issues were found in the close/cancel path: one confirmed ordering inversion (the comment says deregister-first, the code does close-first), and one latent race in the forwarder's `select!` that could cause spurious deliveries or drops on close.

| Scope | Files | Lines changed | Tier | Findings |
|---|---|---|---|---|
| source | 14 | 2,257 | full | 2 warnings, 1 suggestion |
| documentation | 11 | 1,471 | full | 0 |

---

## Findings

### Source

#### [warning] `chat.close` deregisters from router after dropping cancel sender — `the-intern/service/crates/admin-rpc/src/dispatch.rs:358`

In `handle_chat_close`, `registry.close_chat(sub_id)` is called at line 358, which drops the oneshot cancel sender and immediately signals the chat forwarder task to exit. The router deregistration (`router.deregister(sub_id)`) happens only afterward at line 365.

The inline comment at lines 361–363 explicitly says deregistration "must happen before the cancel sender is dropped (done inside `registry.close_chat`)". The code contradicts itself. The `Drop` path in `ConnectionRegistry` (subscriptions.rs:388–392) gets the ordering right — deregister first, then remove the cancel sender — confirming the intended sequence.

The race window: a producer can call `DeliveryHandle::deliver` after `close_chat` drops the cancel sender but before `router.deregister` removes the entry. In that window a payload lands in `rx`; the forwarder is already woken by the cancel signal and, depending on scheduling, may forward the stale payload before exiting — a notification escaping past a close.

**Fix:** check whether the subscription is open, deregister from the router first, then call `close_chat`:

```rust
if registry.is_open_chat_subscription(sub_id) {
    if let Some(ref router) = self.chat_router {
        router.deregister(sub_id);    // 1. stop new deliveries
    }
    registry.close_chat(sub_id);     // 2. then signal forwarder
    let response = Response::ok(id, json!({ "ok": true }));
    DispatchOutcome::ChatUnsubscribed { response, id: sub_id }
} else {
    // not found error
}
```

This requires a read-only `is_open_chat_subscription` helper on `ConnectionRegistry`; alternatively, add a method that separates the existence check from the cancel-sender drop.

---

#### [warning] `chat_forwarder` select! is unbiased — cancel and delivery can race on close — `the-intern/service/crates/admin-rpc/src/lib.rs:359`

`chat_forwarder` uses a plain (non-biased) `tokio::select!`. When both the `cancel_rx` signal and a pending item in `rx` become ready in the same scheduler tick — possible if a reply arrives at the same moment `chat.close` fires — either arm can win. If the delivery arm wins, a notification escapes past a close. If the cancel arm wins, a queued item is silently dropped.

The `close_chat` ordering issue (finding above) creates exactly this condition: the cancel signal fires before the router entry is removed, so a concurrent producer can enqueue into `rx` after the cancel fires.

If the intent is that close immediately halts all delivery, bias the cancel arm:

```rust
tokio::select! {
    biased;
    _ = &mut cancel_rx => return,
    payload_opt = rx.recv() => { ... }
}
```

If best-effort drain on close is acceptable, the current code is fine but the comment should say so.

This is a latent flakiness risk under load rather than a deterministic failure; the e2e test passes because it uses sleep-based synchronisation that avoids the race window.

---

#### [suggestion] Chat and audit subscription id counters both start at 1 — client-visible ids can collide across types — `the-intern/service/crates/admin-rpc/src/subscriptions.rs:332`

`next_chat_id` and `next_audit_id` both initialise to 1. A connection that has both an open audit subscription and an open chat subscription will receive id `"1"` for both. The server correctly disambiguates by kind (`audit_cancel_txs` vs. `chat_cancel_txs`) so there is no server-side confusion. However, a client that stores subscription ids in a single map keyed only on the string value would silently overwrite one with the other.

The current `bob` CLI does not mix subscription types on one connection, so this is not an active bug. Worth noting because `AdminSubscriptionId` is a public type shared across both code paths. An easy fix is to start one counter at a different offset or use a single shared counter for all subscription kinds.

---

## Skipped files

None. No lock files, vendored code, minified assets, generated markers, or binary files were present in the diff.

---

## Review notes

- **Source scope**: `full` tier — diff read in full; surrounding code read for `dispatch.rs` close path, `subscriptions.rs` Drop impl, and `lib.rs` forwarder. The repo is on `dev-agent` which carries the PR head, so files were read directly.
- **Documentation scope**: `full` tier — all 11 files reviewed. The lifecycle artifacts (CR, spec, task files) and end-user guide were checked for internal consistency and against the source implementation. No discrepancies found.
- **Security**: No files matched the security-flag criteria (no auth/crypto/token/session path names, no secrets consumption, no new trust-boundary parsing). The PR adds no network listeners or credential handling.
- The e2e test in `chat_e2e.rs` is comprehensive and correctly exercises the full round-trip. The two warnings above are about teardown ordering that the test's sleep-based synchronisation happens to avoid — they would surface under concurrency stress or a biased scheduler.
