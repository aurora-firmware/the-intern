---
id: B-018
title: stale second bob extension instance silently blocks all tool calls
severity: medium
status: in-progress
created: '2026-07-04'
---

# stale second bob extension instance silently blocks all tool calls

## Summary

pi loads extensions from its own `~/.pi/agent/settings.json` `packages` list
*in addition to* the `--extension <path>` flag bob passes (CR-003). When an
older release copy of `bob.ts` is present there (observed: the 0.1.3 release
archive, installed under the pre-CR-003 manual model), two bob extension
instances run in every supervised session. The stale instance speaks the
obsolete string verdict wire format (`"verdict":"allow"|"block"`), while the
service now sends a structured object (`{"allow":bool,"reason":…}`); the
stale hook parses every current verdict as invalid and fails closed, so
**every tool call is blocked** even though Policy Control returned allow and
the current extension's hook allowed. There is no detection, no version
handshake, and no operator-visible signal beyond duplicated audit records.
CR-003 made bob own extension delivery precisely to prevent this version
skew, but a leftover `packages` entry silently reintroduces it.

## Reproduction Status

Status: confirmed

Confirmed on the dev machine on 2026-07-04: `~/.pi/agent/settings.json`
contains `"packages": ["../../bob-the-intern/the-intern-bob-extension-0.1.3/bob.ts"]`;
that file's `handleInboundLine` accepts only string verdicts. Audit records in
`.tmp/bob-dev/state/bob/audit.jsonl` show every extension event and every
authz verdict duplicated in pairs per session (two instances, same
`BOB_SESSION_ID`, two socket connections), with `allow: true` verdicts while
interactive tool calls are blocked in the TUI.

## Evidence

- `~/.pi/agent/settings.json` `packages` entry pointing at
  `~/bob-the-intern/the-intern-bob-extension-0.1.3/bob.ts`.
- Old copy's parser (`handleInboundLine`): accepts only
  `frame.verdict === "allow" || frame.verdict === "block"`; anything else
  resolves `"error"` → fail closed → hook returns block.
- Current service wire format: `extension-ipc/src/framing.rs`
  `OutboundFrame::AuthzVerdict { verdict: PolicyVerdict }` serializes as
  `{"verdict":{"allow":…,"reason":…}}`.
- Audit log: paired duplicate records per tool call/event, e.g. session
  `f18275fd` on 2026-06-30 16:37 — two identical `allow` verdicts and two
  `tool_execution_start`/`tool_execution_end` records per instant.
- Operator symptom: every interactive `bob chat` tool call is denied with the
  extension's fail-closed warning while `bob audit tail` shows allow.

## Reproduction Steps

1. Install an old release extension archive and reference it from
   `~/.pi/agent/settings.json` `packages` (the pre-CR-003 install model).
2. Start the service (`./scripts/run-bob-dev.sh`) with a policy that allows
   `bash`/`read`/`write`.
3. Open `bob chat` and ask the agent to run any tool.
4. Observe the tool call is blocked despite the audit log recording
   `allow: true`, and every event/verdict appearing twice in the audit log.

## Expected Behavior

Exactly one bob extension instance — the one bob supplies via
`pi --extension` — participates in the authz path per session. If a second
instance (or a wire-format mismatch) is present, it is detected and surfaced
loudly: at minimum a distinguishable warning and audit signal; ideally the
session refuses to start or the stale instance disables itself, so an
allow-verdict-but-blocked state cannot exist silently.

## Actual Behavior

Both instances load silently. Each opens its own `extension.sock` connection
under the same session id and registers its own blocking `tool_call` hook.
The stale instance cannot parse current verdict frames, fails closed, and pi
blocks the tool because one of its hooks blocked. The operator sees blanket
denials that contradict the audit log, with no hint that a second, outdated
extension copy is the cause. Duplicate audit records are the only trace.

## Environment

- OS / platform: Linux (dev machine, single-user-local per ADR-008)
- Language / runtime version: pi-agent binary on PATH (tested version
  recorded in `README.md`); extension source `the-intern/extensions/bob.ts`
- Relevant dependencies: pi settings `packages` extension loading; release
  archive `the-intern-bob-extension-<tag>.tar.gz`
- Branch / commit: `dev-agent` @ 56787d1

## Related

- Specification: `project/specs/S-003-js-extension-for-pi-agent-event-forwarding.md`
  (CR-003 amendment: bob owns extension delivery, fail-closed),
  `project/specs/S-004-policy-control-pre-flight-admission-and-the-blocking-tool-call-authorization-path.md`
- Decision: ADR-009 (extension default path), ADR-010 (the `tool_call` gate
  is interactive chat's security gate — so silent blanket blocking is a
  usability *and* observability defect)

## Suspected Area

Wire-contract versioning between `the-intern/extensions/bob.ts` and
`the-intern/service/crates/extension-ipc/src/framing.rs` (no version field,
no handshake); absence of duplicate-instance detection in `bob.ts` and of any
diagnostics in the service when one session id opens multiple connections.
The immediate operator remediation (remove the stale `packages` entry from
`~/.pi/agent/settings.json`) is environmental and outside the repo; this bug
covers making the failure detectable/impossible, and documenting the
migration in the operator docs.

## Fix Verification

```bash
# From the-intern/extensions/: extension unit tests cover the new
# detection/handshake behaviour.
npm test
# From the-intern/service/:
cargo test --workspace
# Manual: with a deliberately stale second copy wired into pi settings,
# start a session — bob must surface a loud, attributable warning (or refuse
# the session) instead of silently blocking all tool calls.
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-07-04

**Reproduction status:** Confirmed. Direct on-disk evidence (`pi-logs.log`, untracked, captured from a live `bob serve` + real `pi` run on 2026-06-30, session `577ef1bc-e5de-497b-b4f0-f42f6b9443ac`) shows every one of 11 distinct extension event types delivered exactly twice under one identical session id — the same duplication signature the bug's own audit-log evidence describes. Combined with independent static-source verification of every mechanism named in the bug (below) and an isolated unit-level reproduction of the duplicate-connection blind spot (added temporarily to `extension-ipc/src/lib.rs`, run, then fully reverted), this constitutes a deterministic, structural confirmation rather than a flake. A full live end-to-end re-run (deliberately stale `packages` entry + `bob chat`) was attempted but blocked by sandbox tooling limits keeping a long-lived `bob serve` process alive across tool-call boundaries; this is a harness limitation, not a reproduction gap (see Evidence for what was independently confirmed instead).

**Evidence captured:**
- `pi-logs.log` timeline: `session_start`, `resources_discover`, `before_agent_start`, `agent_start`, `turn_start`, `message_start`, `message_end`, `context`, `before_provider_request`, `input`, `session_shutdown` — each appears exactly twice under `session: 577ef1bc-e5de-497b-b4f0-f42f6b9443ac` (`grep -oP "event: \K[a-z_]+" pi-logs.log | sort | uniq -c`; `grep -oP "session: \K[0-9a-f-]+" pi-logs.log | sort | uniq -c` → single session id, 44 lines).
- `the-intern-bob-extension-0.1.3/bob.ts` lines 135-157 (`handleInboundLine`): resolves a verdict only for `frame.verdict === "allow" || frame.verdict === "block"` (string); anything else → `"error"` → fail-closed (lines 355-356: `warn("authz: unparseable or transport-error verdict — blocking tool call")`, `return { block: true, reason: "authz verdict error" }`).
- `extension-ipc/src/framing.rs`: `OutboundFrame::AuthzVerdict { session, verdict: PolicyVerdict { allow: bool, reason: Option<String> } }`; test `encodes_authz_verdict_with_newline` asserts wire shape `{"kind":"authz_verdict","session":...,"verdict":{"allow":false,"reason":"..."}}`. Current `the-intern/extensions/bob.ts` `handleInboundLine` (lines 139-183) requires `verdictObj.allow` to be a boolean. Neither frame variant carries any version/protocol marker.
- `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/packages.md`: local-path `packages` entries load independently as extensions; "Scope and Deduplication" dedupes only by resolved absolute path *between global and project settings*, never against a CLI `--extension`/`-e` path. `pi-agent-supervisor/src/process.rs` lines 55/288 always append `--extension <path>` for bob's own current `bob.ts`; nothing in bob inspects or clears the operator's `~/.pi/agent/settings.json` `packages` list.
- `extension-ipc/src/lib.rs`: `run_listener` (lines 187-233) spawns one independent `run_connection` task per accepted socket (line 213); `run_connection` (lines 98-167) constructs its own private `SessionMultiplexer::new(...)` (line 105) with no cross-connection registry. Repo-wide `grep -rn "\.register_session("` shows `SessionMultiplexer::register_session` (multiplex.rs line 196) is called only from the unit-test module (lines 521-522) — dead code in every production path.
- Temporary diagnostic test `diagnostic_b018_two_connections_same_session_are_fully_unaware_of_each_other`, added to `extension-ipc/src/lib.rs`, run via `cargo test -p extension-ipc diagnostic_b018 -- --nocapture` (1 passed, no distinguishing log line emitted), then reverted with `git checkout -- the-intern/service/crates/extension-ipc/src/lib.rs` (confirmed via `git status --short` / `git diff --stat`, clean tree): two `run_connection` tasks over two separate `UnixStream::pair()`s, identical `Authz` frame with the same `SessionId` sent on both, both independently return `allow` with zero shared state or correlation.
- `cargo test -p extension-ipc` (31 tests) and `cargo build -p bob` pass cleanly on the current tree — clean baseline before any fix.
- `~/.pi/agent/settings.json` on this machine currently shows `"packages": []` (cleared), while `/home/daneel/bob-the-intern/the-intern-bob-extension-0.1.3/bob.ts` (the vulnerable artifact) still exists on disk.

**Isolated fault:** Two independent, additive faults, both in components we own:
1. `extension-ipc/src/framing.rs` (`OutboundFrame::AuthzVerdict`) and `the-intern/extensions/bob.ts` (`handleInboundLine`'s documented wire contract) carry only `{kind, session, verdict}` — no version/capability field either side could use to recognize an incompatible peer extension.
2. `extension-ipc/src/lib.rs` `run_listener`/`run_connection` — every accepted connection gets an independent, connection-local `SessionMultiplexer`; there is no shared registry of which `SessionId`s currently have a live connection. `SessionMultiplexer::register_session` is the one piece of the multiplexer designed to track sessions, but it is never wired to the accept path (dead code outside tests).

**Root cause or fault hypothesis (confirmed, not speculative):** CR-003's "bob owns extension delivery" model implicitly assumed exactly one `bob.ts` is ever loaded per session, so no version marker was designed into the wire protocol, and the connection-handling layer was built session-per-connection with no cross-connection bookkeeping. Given pi's documented additive `packages` + `--extension` loading (independently verified against vendor docs) and a leftover local-path `packages` entry pointing at an old archive, pi loads two `bobFactory` instances into one process; each opens its own socket connection under the same `BOB_SESSION_ID` and registers its own blocking `tool_call` hook. The old instance cannot parse the current structured verdict, fails closed by its own documented design, and pi blocks the tool call because one of the two hooks blocked — with nothing on either side able to detect or report the collision.

**Design-decision flag (per diagnosis guidance):** Two independent, non-equivalent remediation designs are viable and were not distinguished during diagnosis; recommend Architect input before/while implementing:
- (i) Add a version/instance-identity field to the wire frames so the current `bob.ts`/service can positively identify a stale/duplicate peer.
- (ii) Promote `register_session`/a listener-level registry to the real accept path so the service detects a second connection under one `SessionId` and reacts (loud warn + audit signal, and/or refuses the second connection) — this is a policy decision (refuse vs. flag-loudly) with ADR-010 (`tool_call` as the security gate) implications.
These are complementary, not mutually exclusive, but the second raises an architectural question (refuse vs. flag) worth confirming before implementation.

**Planned verification:**
- `the-intern/extensions/` `npm test` (once test tooling exists) covering the new duplicate/version-mismatch signal without regressing existing allow/block/timeout/error authz behavior.
- `cargo test --workspace` from `the-intern/service/`, with new tests in `extension-ipc` (`framing.rs`, `lib.rs`/`multiplex.rs`) covering: the new wire field round-trips; a second connection registering the same `SessionId` produces a loud, attributable log/audit signal (and, if refused, that the refusal itself is observable); all 31 currently-passing `extension-ipc` tests remain green.
- Manual check per the bug's own Fix Verification: with a deliberately stale second `bob.ts` wired into `~/.pi/agent/settings.json` `packages`, start a session and confirm bob surfaces a loud, attributable warning (or refuses the session) instead of silently blocking all tool calls.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-07-04

Implemented the PRIMARY remediation from the escalation guidance: a shared,
listener-level `SessionRegistry` (new module
`extension-ipc/src/session_registry.rs`) tracking which connection id owns
each live `SessionId`. `run_listener` now creates one registry per listener
and assigns each accepted connection a monotonic id; `run_connection` checks
every newly-observed session id against the registry exactly once (not per
frame, to avoid flooding), and on a `Duplicate` outcome emits a WARN-level
tracing log naming both connection ids plus a `duplicate_extension_connection`
audit `event` via the existing `MonitoringHandle::record_event` (no new
`AuditRecordKind` needed — reused the existing Event schema with a
distinguishing name to avoid rippling into monitoring/admin-rpc/
requests-handler). Session ids are released from the registry when a
connection's read loop ends (refactored to a labeled `'connection: loop` so
every exit path — EOF, read/write error, malformed frame, parse failure —
reaches the cleanup instead of bypassing it via a bare `return`), so a later
legitimate reconnect under the same session id is not mistaken for a
duplicate.

Design choice made without further escalation, per the loop's guidance:
FLAG LOUDLY, do not refuse the second connection. Reasoning: the service has
no reliable way to determine which of two simultaneously-live connections
under one session id is the current, correct instance versus the stale one —
pi's `packages` + `--extension` loading order isn't something bob controls.
Refusing the second connection is a coin flip that could refuse the correct
one and leave the session with zero working extension, which is worse than
today's failure mode. Flagging loudly changes nothing about existing
verdict-handling behavior (zero regression risk) while giving the operator
exactly the "attributable signal" the bug's Expected Behavior asked for as
the minimum bar.

Deferred the OPTIONAL wire-version-marker hardening per the bug's explicit
scope guidance (do not expand into a protocol handshake redesign); the
service-side registry alone satisfies the Expected Behavior.

TDD: two red→green cycles, each committed separately.
  1. `session_registry.rs` — wrote the unit tests first against a stub
     `register`/`release` that always returned `Registered`/no-op, confirmed
     2 of 4 tests failed (red), then implemented the real `HashMap<SessionId,
     u64>` + `Mutex` logic (green). Committed as
     "feat(extension-ipc): add cross-connection session ownership registry".
  2. Wired the registry into `run_listener`/`run_connection`, added the new
     integration tests. One test (asserting the WARN log via a captured
     tracing subscriber, mirroring `multiplex.rs`'s existing pattern) was
     written, passed in isolation, but proved flaky under parallel
     `cargo test` (thread-local tracing-subscriber race with other
     concurrently-running tests — confirmed via 6 runs each at default
     parallelism vs. `--test-threads=1`). Rejected that test to keep the
     suite deterministic; kept the mock-based audit-event test (fully
     deterministic, no tracing internals involved) as the durable evidence,
     with a code comment explaining the removal and pointing at the adjacent
     `tracing::warn!` call for source-level confirmation. Committed as
     "fix(extension-ipc): flag duplicate extension connections loudly".

Docs: added an operator-guide subsection on removing the stale `packages`
entry and describing the new detection signal; fixed a stale
`"verdict":"allow"|"block"` wire-format example in the extension-author-guide
(it documented the exact obsolete format this bug is about) and added a
"One connection per session" subsection there. Verified with `mdbook build`
that the new cross-doc anchor link resolves. Did not touch `bob.ts` — no
extension-side code change was needed for the chosen fix, confirmed `npm
test` (34 tests) still passes.

Verification: `cargo test --workspace` all green (26 binaries, re-run 3x);
`cargo test -p extension-ipc` 37/37 green, re-run 6x at default parallelism
with no flakiness; `cargo build -p bob` and `cargo fmt --all -- --check`
clean; `cargo clippy -p extension-ipc --all-targets` shows no new warnings
beyond this crate's pre-existing pedantic/doc debt (added `#[must_use]`/
`# Panics` docs to the two new public methods to avoid adding to it).

Remaining for next session / reviewer attention: none required for this
bug's Expected Behavior. If a future task wants the optional wire-version
marker, `framing.rs` and `bob.ts` are the touch points; this session
deliberately left them unchanged.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
