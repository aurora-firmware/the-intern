---
id: T-034
title: Add pi-agent RPC prompt routing
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-18'
spec: S-001
---

# Add pi-agent RPC prompt routing

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

Add supervisor prompt delivery over pi-agent RPC mode. The pi RPC documentation
defines a `prompt` command as one JSON object per line on stdin:
`{"id":"...","type":"prompt","message":"..."}`. Responses and events arrive as
JSONL records on stdout; a `success: true` response means the prompt was
accepted, queued, or handled immediately.

This task should expose a supervisor handle method for routing prompt text to a
specific `SessionId`. It may create a session by acquiring a worker if none is
active for that id. Admin/chat integration remains a later task.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: WHEN `Handle::send_prompt(session_id, message)` is called for an active session THE SYSTEM SHALL send an RPC JSONL command with `type: "prompt"` and the provided message to that session's worker.
AC-2: WHEN `Handle::send_prompt(session_id, message)` is called for a session without an active worker THE SYSTEM SHALL acquire a worker for that session before sending the prompt.
AC-3: WHEN the worker returns a successful `response` for the prompt command THE SYSTEM SHALL return `Ok(())` from `send_prompt`.
AC-4: IF the worker returns an unsuccessful `response` for the prompt command THEN THE SYSTEM SHALL return `ServiceError::ChildProcess` with safe detail text.
AC-5: WHILE prompt events continue streaming after acceptance THE SYSTEM SHALL keep the worker alive and available for subsequent prompts.

## Dependencies

- `T-033` — session registry and warm-pool allocation

## Files to Touch

- `the-intern/service/crates/pi-agent-supervisor/src/rpc.rs` — new RPC command/response helpers for prompt delivery
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs` — add `Handle::send_prompt` and actor command handling
- `the-intern/service/crates/pi-agent-supervisor/src/process.rs` — expose worker send/read primitives needed by prompt routing

## Verification

```bash
cd the-intern/service && cargo test -p pi-agent-supervisor rpc
cd the-intern/service && cargo test -p pi-agent-supervisor send_prompt
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-18

Implemented T-034 in two TDD cycles. First cycle added `rpc.rs` with `PromptCommand` generation (`id`, `type: "prompt"`, `message`) and response parsing helpers, with unit tests validating command shape, matching/non-matching response handling, and invalid response-shape errors. Second cycle started red by adding `send_prompt` tests in `lib.rs`; compile failed because `Handle::send_prompt` did not exist. Implemented actor command handling plus pool-level prompt routing that acquires a session when absent, writes prompt JSONL to the bound worker, then reads stdout JSONL records until it finds the matching `response` for that command id. On `success: true`, it returns `Ok(())`; on `success: false`, it returns `ServiceError::ChildProcess` with safe detail text. Non-response/event records and non-matching response ids are ignored so trailing event streams do not break subsequent prompts; verified by sending two prompts through a worker that emits response then event on each command.

Tried and rejected: implementing prompt routing only inside `lib.rs` without pool changes; that was not viable because active workers are owned privately by `SessionPool`. I made the minimal extension in `pool.rs` to keep worker ownership/lifecycle coherent and avoid duplicate registry logic.

Remaining work: none for task acceptance criteria; ready for reviewer.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-05-18
PASS

Stage 1 passed: AC-1 through AC-5 are satisfied in `rpc.rs`, `pool.rs`, and `lib.rs`, including session auto-acquire, prompt JSONL routing, success/failure response handling, and continued availability across trailing event records.

Stage 2 passed: targeted tests and verification commands succeeded (`cargo test -p pi-agent-supervisor rpc` and `cargo test -p pi-agent-supervisor send_prompt`), and no blocking correctness, security, readability, or performance issues were found in scope.
