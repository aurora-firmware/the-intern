---
id: B-004
title: extension-ipc multiplex caches default_route permanently for unknown 
  session ids
severity: medium
status: in-progress
created: '2026-05-19'
---

# extension-ipc multiplex caches default_route permanently for unknown session ids

## Summary

`crates/extension-ipc/src/multiplex.rs::route_for_session` (around lines 116-121) treats an unknown session id as "use the default route" and inserts that default route into the session→route map keyed under the unknown id. Future calls for the same unknown session id then return the cached route from the map rather than consulting the live default. If the original default sender is later replaced or closed, those unknown-session lookups keep returning the stale route. The behaviour was not previously test-covered.

## Reproduction Status

Status: confirmed — by code inspection per the AI review report (Section 1, medium severity).

## Evidence

- Logs / stack traces / failing assertions: none at runtime; structural fault confirmed by code reading.
- Failing command or test: none yet; the path "unknown session after default-route close" has no test coverage.
- First diagnostic step: read `crates/extension-ipc/src/multiplex.rs` lines 116-121 and the surrounding caching logic.

## Reproduction Steps

1. Open `crates/extension-ipc/src/multiplex.rs::route_for_session`.
2. Observe that on an unknown session id, the function reads the current default route and inserts it into the session→route map under that unknown session id.
3. Observe that a subsequent call with the same unknown session id returns the cached entry rather than consulting the live default.
4. Verify by adding a test that: (a) registers a default route, (b) queries a route for an unknown session id (cache populated), (c) replaces or removes the default route, (d) queries again for the same unknown session id — it should reflect the new default, not the cached one.

## Expected Behavior

`route_for_session` for an unknown session id should always reflect the current default route (or `None` if there is no default). It must not permanently cache the default under the unknown id.

## Actual Behavior

`route_for_session` for an unknown session id permanently caches the default route at first lookup. Subsequent lookups for that unknown id return the stale cache even after the default sender has changed or been closed.

## Environment

- OS / platform: Linux
- Language / runtime version: Rust workspace under `the-intern/service`
- Relevant dependencies: `crates/extension-ipc`
- Branch / commit: `dev-agent` post-merge of T-040 (`ceb872d`)

## Related

- Task: none
- Specification: S-003

## Suspected Area

`the-intern/service/crates/extension-ipc/src/multiplex.rs` — `route_for_session` (around lines 116-121).

## Fix Verification

```bash
cd the-intern/service
cargo test -p extension-ipc
```

A new unit test in `multiplex.rs` must cover the "unknown session after default-route close" path and pass.

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-05-19

**Reproduction status:** Confirmed by code inspection. Structurally unambiguous; runtime reproduction not required to observe the defect.

**Evidence captured:** `route_for_session` at `crates/extension-ipc/src/multiplex.rs:116-121` uses `self.session_routes.entry(session).or_insert_with(|| self.default_route.clone())`. `HashMap::entry().or_insert_with()` permanently inserts the closure's return value into the map. On the first lookup for an unknown session id, a clone of `self.default_route` is stored under that id; later lookups hit the occupied entry and return the stale clone regardless of subsequent changes to `self.default_route`.

**Isolated fault:** `route_for_session` (line 119) — the entry-API pattern was chosen for lazy initialisation but, as a side effect, binds unknown session ids to a snapshot of the default route at first lookup.

**Root cause or fault hypothesis:** The fall-back-to-default behaviour was conflated with permanent registration. The fix is to keep the fallback live: on a missing session entry, read `self.default_route` directly without inserting.

**Planned verification:** Replace the `entry().or_insert_with()` pattern with `get(&session).unwrap_or(&self.default_route)`. Relax `&mut self` to `&self` since no mutation happens. Add a public `set_default_route` so the regression test can replace the default at runtime through the observable interface. Regression test: register default A → look up unknown session id → replace default with B → look up the same unknown session id → assert the second message arrives on B, not A. Verify with `cargo test -p extension-ipc`.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-19

Wrote the failing regression test `route_for_session_reflects_new_default_for_unknown_session_after_default_replaced` in `multiplex.rs` (red). Pre-fix it failed with: "second reply must NOT arrive on old default route A (stale cache)".

Implementation: replaced `self.session_routes.entry(session).or_insert_with(|| self.default_route.clone())` with `self.session_routes.get(&session).cloned().unwrap_or_else(|| self.default_route.clone())` (i.e. a live read of `self.default_route` on cache miss with no insertion). The receiver of `route_for_session` was relaxed from `&mut self` to `&self`. Added a public `set_default_route` to `SessionMultiplexer` so the regression test could replace the default through the observable interface (no production caller currently uses it, but the regression test does).

Considered exposing `session_routes` directly for testing and rejected it — would couple tests to implementation details.

After the fix: `cargo test -p extension-ipc` reports 29/29 passing (28 pre-existing + 1 new). Commit `00be9f3` on `bug/B-004-multiplex-unknown-session-cache` — `fix(extension-ipc): stop caching default route for unknown session ids`. Nothing remains for the next session.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-19

PASS

**Stage 1 — Bug criteria**

- Diagnosis Log present before the Work Log. Reproduction status explicitly marked "confirmed by code inspection". Evidence: exact file and lines cited (`multiplex.rs:116-121`). Isolated fault documented (`entry().or_insert_with()` side-effect). Root cause articulated (fallback conflated with permanent registration). Planned verification matches the fix applied. All Diagnosis Log fields satisfied.
- Fix is scoped to the isolated cause. The `entry().or_insert_with()` pattern is replaced with `self.session_routes.get(&session).unwrap_or(&self.default_route).clone()`. No insertion happens for unknown session ids; the live `default_route` field is always consulted on cache miss.
- No unrelated behaviour added. The only production additions are the receiver relaxation and `set_default_route`; both are directly motivated by the fix and its regression test.
- Fix Verification steps executed: `cargo test -p extension-ipc` ran 29/29 green on `bug/B-004-multiplex-unknown-session-cache` at commit `00be9f3`.

**Stage 2 — Code quality**

- `route_for_session` receiver changed from `&mut self` to `&self` — correct, since no mutation occurs. `handle_frame` keeps `&mut self` (still mutates via `monitoring.record_event` and needs it for `register_session` callers). The borrow relationship is sound; the Rust compiler accepted it without issue.
- `set_default_route` signature is `&mut self` with a single assignment to `self.default_route`. Internally coherent. Doc-comment accurately describes post-condition. The regression test uses it to trigger the exact stale-cache path described in the diagnosis.
- Regression test `route_for_session_reflects_new_default_for_unknown_session_after_default_replaced` exercises the precise fault sequence: register default A → lookup unknown session (reply on A confirmed) → `set_default_route(B)` → lookup same unknown session → assert no reply on A and reply on B. The negative assertion (`rx_a.try_recv().is_err()`) guards against the stale-cache regression.
- Existing tests `distinct_sessions_do_not_cross_deliver_replies`, `authz_frame_returns_deny_by_default_on_same_session_route`, `event_frame_forwards_to_monitoring_without_wire_reply`, and all 25 other tests remain green.
- No hardcoded secrets, no dead code, no commented-out blocks. Names are descriptive and follow project conventions.
