---
id: B-016
title: Extension rejects structured authz verdicts as transport errors
severity: critical
status: in-progress
created: '2026-06-30'
---

# Extension rejects structured authz verdicts as transport errors

## Summary

The Bob TypeScript extension rejects valid authz verdict frames emitted by the
Rust `extension-ipc` subsystem because the two sides disagree on the wire shape
of `verdict`. Rust sends a structured `PolicyVerdict` object, while the
extension expects the literal string `"allow"` or `"block"`. As a result,
interactive pi-agent sessions fail closed and report `authz verdict error`,
blocking tool calls before the policy outcome can be applied correctly.

## Reproduction Status

Status: confirmed

The issue was observed in an interactive session against the dev Bob service.
The code path was traced from the TypeScript extension verdict parser to the
Rust outbound frame encoder, confirming the schema mismatch.

## Evidence

- Interactive session output:

  ```text
  write ~/projects/the-intern/.tmp/bob-logs.md

  2026-06-30 00:00:00 +0000 : I asked the rubber duck for advice, and it billed me by the quack.

  authz verdict error

  Warning: authz: unparseable or transport-error verdict - blocking tool call
  ```

- Rust outbound frame schema:
  `the-intern/service/crates/extension-ipc/src/framing.rs` defines
  `OutboundFrame::AuthzVerdict { session, verdict: PolicyVerdict }`, so encoded
  replies have a structured `verdict` object such as:

  ```json
  {
    "kind": "authz_verdict",
    "session": "...",
    "verdict": {
      "allow": false,
      "reason": "no action rule permits tool 'bash' with the supplied arguments"
    }
  }
  ```

- TypeScript extension parser:
  `the-intern/extensions/bob.ts` currently accepts only
  `frame.verdict === "allow" || frame.verdict === "block"`, resolving any other
  verdict shape as `"error"`.

## Reproduction Steps

1. Start the dev Bob service with `scripts/bob-dev.sh serve`.
2. Start an interactive pi-agent session through Bob.
3. Ask the agent to perform a tool-backed write, for example writing a line to
   `/home/daneel/projects/the-intern/.tmp/bob-logs.md`.
4. Observe that the tool call is blocked with `authz verdict error` and the
   extension warning about an unparseable or transport-error verdict.

## Expected Behavior

The extension should parse Bob's authz verdict reply, distinguish allowed and
blocked tool calls from malformed transport failures, and present the real
policy outcome to pi-agent.

## Actual Behavior

The extension treats the structured Rust verdict object as malformed because it
expects `verdict` to be a string. The tool call is fail-closed with
`authz verdict error` even when Bob returned a syntactically valid
`authz_verdict` frame.

## Environment

- OS / platform: Linux auroralab 6.12.90+deb13.1-amd64
- Language / runtime version: Rust workspace and TypeScript extension via
  `scripts/bob-dev.sh`
- Relevant dependencies: `pi` on PATH, Bob dev service, extension
  `the-intern/extensions/bob.ts`
- Branch / commit: `dev-agent` at `1c9e1b8`

## Related

- Task: unknown
- Specification: S-004 policy-control pre-flight admission and blocking
  tool-call authorization path

## Suspected Area

- `the-intern/extensions/bob.ts`
- `the-intern/service/crates/extension-ipc/src/framing.rs`
- `the-intern/service/crates/extension-ipc/src/multiplex.rs`

## Fix Verification

```bash
cargo test -p extension-ipc
cargo test -p bob shell_e2e
```

Manual verification:

1. Start `scripts/bob-dev.sh serve`.
2. Start an interactive Bob chat session.
3. Trigger a tool call.
4. Confirm the extension no longer reports `authz verdict error`.
5. Confirm allowed tool calls run when policy permits them and denied tool calls
   show the policy denial reason rather than a transport/parser error.

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-06-30

Reproduction status: confirmed from interactive session output and code
inspection.

Evidence captured: the interactive session emitted `authz verdict error` and
`authz: unparseable or transport-error verdict - blocking tool call`.
`the-intern/service/crates/extension-ipc/src/framing.rs` encodes
`OutboundFrame::AuthzVerdict` with `verdict: PolicyVerdict`, while
`the-intern/extensions/bob.ts` accepts only string verdict values `"allow"` or
`"block"`.

Isolated fault: `handleInboundLine` in `the-intern/extensions/bob.ts` rejects
the structured `verdict` object emitted by Rust `extension-ipc`.

Root cause or fault hypothesis: the TypeScript extension's documented and
implemented inbound wire contract drifted from the Rust service contract. The
extension expects `"verdict":"allow"|"block"`, but the service sends
`"verdict":{"allow":bool,"reason":string|null}`.

Planned verification: add or update extension-side tests to cover structured
Rust verdict frames; run `cargo test -p extension-ipc`; perform a manual
interactive Bob session and confirm a tool call no longer fails with
`authz verdict error`.

### Diagnosis 2 — 2026-06-30

Reproduction status: confirmed — the defect is reproducible via code inspection and
the existing Rust integration test, which directly demonstrates the wire mismatch.

Evidence captured:

1. `cargo test -p extension-ipc` — 31 passed, 0 failed. The test
   `connection_authz_frame_returns_deny_verdict_with_same_session`
   (`the-intern/service/crates/extension-ipc/src/lib.rs` line 405) sends an
   `authz` frame over a Unix socket pair and asserts the reply satisfies
   `reply["verdict"]["allow"] == false` and `reply["verdict"]["reason"].is_string()`.
   This confirms the Rust service has always emitted a structured object for `verdict`.

2. `framing.rs` lines 40-47 — `OutboundFrame::AuthzVerdict { session, verdict: PolicyVerdict }`
   is serialised with `#[serde(tag = "kind", rename_all = "snake_case")]` on the enum.
   `PolicyVerdict` (`bob-core/src/types/records.rs` lines 9-15) is a plain struct with
   `pub allow: bool` and `pub reason: Option<String>`, no field rename attributes.
   Serialised wire shape: `{"kind":"authz_verdict","session":"<uuid>","verdict":{"allow":true|false,"reason":"..."|null}}`.

3. `bob.ts` `handleInboundLine` (lines 149-153) checks
   `(frame.verdict === "allow" || frame.verdict === "block")`.
   Because `frame.verdict` is always an object `{allow,reason}` in the actual wire
   stream, this equality is never true. The else branch fires unconditionally and
   calls `resolve("error")`, which `handleToolCall` maps to
   `{ block: true, reason: "authz verdict error" }`.

4. `bob.ts` line 18 doc comment still documents the old wire contract
   `"verdict":"allow"|"block"` — a string that was never serialised by the Rust side.

5. S-004 Component 4 specifies the multiplexer produces `AuthzVerdict` using `PolicyVerdict`;
   Component 5 specifies `bob.ts` consumes it. The spec names the Rust type and makes no
   mention of a string-only encoding. The Rust implementation is aligned with the spec;
   the TS implementation is not.

Isolated fault: `handleInboundLine` in `the-intern/extensions/bob.ts` (lines 149-153).
The function's verdict guard uses string equality against `"allow"` / `"block"`, which
cannot match the structured `PolicyVerdict` object the Rust service always sends.
The stale doc comment at line 18 is a secondary documentation fault.

Root cause: The TypeScript extension's inbound wire contract was written against an
earlier design where `verdict` was a plain string. The Rust service was implemented
with a structured `PolicyVerdict` object (`{allow: bool, reason: string|null}`), but
the TS extension was never updated to match. The Rust side is the correct side per
S-004 and per its own tests.

Planned fix (TS extension only — no Rust changes required):

1. Update `handleInboundLine` to parse `frame.verdict` as a structured object
   `{allow: boolean, reason?: string | null}` rather than comparing it to plain strings.
   - `verdict.allow === true`  → resolve the allow outcome.
   - `verdict.allow === false` → resolve a block outcome carrying `verdict.reason`.
2. Extend `VerdictOutcome` (or use a companion field) so the block reason from the
   policy can be threaded to `handleToolCall`'s `{ block: true, reason: "..." }` return,
   replacing the current hardcoded `"blocked by policy"` string.
3. Correct the stale wire-contract doc comment at line 18 to reflect the structured shape.

Planned verification:
  cargo test -p extension-ipc       (must remain green — no Rust changes)
  cargo test -p bob shell_e2e       (end-to-end pass)
  Manual: start dev bob service, trigger a tool call, confirm the extension no longer
  emits "authz verdict error", confirmed allowed calls run and denied calls surface
  the actual policy reason rather than "authz verdict error".

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-30

Filed the bug after diagnosing an interactive Bob session where every tool call
failed closed with `authz verdict error`. Traced the authz reply path and found
the TypeScript extension and Rust service disagree on the `authz_verdict`
payload shape. No production code was changed.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
