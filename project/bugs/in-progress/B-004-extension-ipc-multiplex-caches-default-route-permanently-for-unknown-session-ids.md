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
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
