---
id: T-073
title: Carry self-asserted application identity through the chat.send intake 
  path per ADR-005
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-22'
---

# Carry self-asserted application identity through the chat.send intake path per ADR-005

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

ADR-005 (`project/decisions/ADR-005-application-level-request-identity-is-self-asserted-within-the-local-socket-trust-boundary.md`)
decides that the socket's filesystem permissions are the transport trust gate,
and that each inbound request must declare its own application-level identity,
which is carried into `RequestContext.sender`.

The chat path currently violates this. T-071/T-072 wired `chat.send` end to end,
but the chat user-input frame's identity is sourced from the admin-RPC
`ConnectionRegistry`, which holds an anonymous, randomly-generated `UserId`
(`ConnectionRegistry::new`). Every chat message therefore reaches the
requests-handler pre-flight check with a meaningless sender.

Close the gap per ADR-005:

- `chat.send` shall accept an application-identity argument in its JSON-RPC
  params. The dispatcher validates it (present, non-empty, structurally valid as
  a `UserId`) and builds the chat user-input frame with it. The chat adapter
  already copies the frame identity into `RequestContext.sender` — no change
  there.
- An absent or malformed identity is a `chat.send` error; nothing is forwarded.
- The chat frame's identity must come solely from the request. Remove the
  now-obsolete OS-oriented peer-identity field/constructor/accessor on
  `ConnectionRegistry` (`peer_id`, `new_with_peer`, `peer_id()`). The listener's
  connection gate is unchanged by this task; its simplification is handled
  separately by T-074.
- The `bob chat` CLI shall send the identity it asserts: add an
  application-identity field to `BobConfig` for the chat client and include it
  in every `chat.send` request.
- The configured chat application identity must be stable and operator-visible.
  It must not be generated implicitly with `UserId::new()`, `UserId::default()`,
  or any other per-process/per-request random fallback, because that would
  preserve the current anonymous-identity bug under a new name.
- Update the user-facing documentation that describes chat identity as
  anonymous: the `bob chat` section of the root `README.md` and the chat note
  in `user_diagrams.md`.

Out of scope: reshaping `bob-core::UserId` to a human-readable form (a separate
F4 concern), and process-name capture for monitoring (a separate follow-up
task). Identity here is a `UserId` value asserted by the request.

## Acceptance Criteria

AC-1: WHEN a `chat.send` call includes a well-formed application-identity
      argument THE SYSTEM SHALL build the chat user-input frame with that
      identity and forward it to the chat adapter.

AC-2: IF a `chat.send` call omits the application-identity argument, or
      supplies one that is empty or not structurally valid as a `UserId`,
      THEN THE SYSTEM SHALL return a JSON-RPC error and forward no frame.

AC-3: The chat user-input frame's identity shall originate solely from the
      `chat.send` request arguments, and the admin-RPC `ConnectionRegistry`
      shall no longer hold or supply a peer identity.

AC-4: WHEN the `bob chat` CLI issues a `chat.send` request THE SYSTEM SHALL
      include the operator-configured, stable application identity in the
      request's arguments.

AC-5: The `bob chat` section of the root `README.md` and the chat note in
      `user_diagrams.md` shall describe chat as carrying a self-asserted
      application identity, with no remaining claim that chat frames use an
      anonymous identity.

## Dependencies

- None — builds on the completed S-006 chat path (T-068–T-072) and the
  accepted ADR-005. No pending task creates anything this task reads.

## Files to Touch

- `the-intern/service/crates/admin-rpc/src/dispatch.rs` — `chat.send` reads and
  validates the application-identity argument, builds the chat frame with it,
  and returns a JSON-RPC error on an absent/malformed identity; stop sourcing
  identity from `ConnectionRegistry`; update dispatch tests.
- `the-intern/service/crates/admin-rpc/src/subscriptions.rs` — remove the
  now-unused OS-oriented `ConnectionRegistry` peer-identity field, constructor,
  and accessor (`peer_id`, `new_with_peer`, `peer_id()`).
- `the-intern/service/crates/bob/src/config.rs` — add the chat client's
  application-identity field to `BobConfig` and its raw/defaults counterparts;
  reject absent or empty configuration rather than generating a random fallback.
- `the-intern/service/crates/bob/src/cli/commands/chat.rs` — include the
  configured application identity in every `chat.send` request's params.
- `README.md` — update the `bob chat` section so it no longer states that
  chat frames carry an anonymous identity.
- `user_diagrams.md` — update the chat note under "Current Implementation
  Notes" to match.

## Verification

```bash
cd the-intern/service
cargo test -p admin-rpc
cargo test -p bob
cargo test --workspace
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
