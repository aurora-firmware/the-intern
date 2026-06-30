---
id: T-116
title: Update scheduler docs and end-to-end coverage for JSON state
status: pending
priority: medium
assigned-role: unassigned
created: '2026-06-30'
---

# Update scheduler docs and end-to-end coverage for JSON state

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

Update user-facing scheduler documentation and end-to-end coverage after the
CR-004 implementation tasks land. Operators should no longer be told to edit
`[[schedule]]` in `config.toml` or copy scheduler-derived UUIDs into
`[policy].admitted_users`.

The docs should explain `schedules.json`, the default XDG state location, the
owner-only permission model, `bob schedule` as the normal mutation path, direct
file edit plus `bob schedule reload`, and the fact that tool-call
authorization still applies. E2E tests should cover the full JSON-store path
and prove an otherwise empty `admitted_users` list does not block scheduled
prompt delivery.

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

AC-1: The operator guide shall document `schedules.json` as the scheduler source
      of truth, including the Linux XDG state path and fallback.
AC-2: The operator guide shall not instruct operators to add scheduler-derived
      UUIDs to `[policy].admitted_users` for scheduled jobs.
AC-3: The operator guide shall state that scheduled jobs are admitted by the
      Unix trust boundary and trusted schedule store, while every resulting
      `tool_call` still uses S-004 action authorization.
AC-4: WHEN the scheduler execution e2e test runs with a valid JSON schedule
      entry and empty `[policy].admitted_users` THE SYSTEM SHALL deliver the
      scheduled prompt to the fake pi-agent worker.
AC-5: IF repository documentation still references `[[schedule]]` in
      `config.toml` as the active scheduler source of truth THEN THE SYSTEM
      SHALL update that reference or mark it as historical report content.

## Dependencies

- `T-113` — JSON schedule-store persistence exists.
- `T-114` — startup loads scheduler entries from JSON state.
- `T-115` — schedule RPC mutations persist to JSON state.
- `T-117` — scheduler firings no longer require UUID policy admission.

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — update scheduled-job
  configuration, policy, reload, and observability guidance.
- `the-intern/docs/src/architecture-overview/index.md` — update scheduler
  admission/source-of-truth wording.
- `the-intern/service/crates/bob/tests/scheduler_execution_e2e.rs` — update
  full-path scheduled prompt coverage for JSON state and empty admitted_users.

## Verification

```bash
cd the-intern/service && cargo test --test scheduler_execution_e2e -- --nocapture
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-30

_Loop note: an earlier session was interrupted by a session limit before committing anything; this work started from a clean branch._

Implemented all five acceptance criteria in a single TDD cycle.

**What was done:**

AC-1/AC-2/AC-3 — Rewrote the `operator-guide/index.md` "Scheduled jobs" section. The old "Configuring scheduled jobs in `config.toml`" subsection was replaced with "Schedule store (`schedules.json`)" that documents the JSON file as the authoritative source, its Linux XDG state path (`$XDG_STATE_HOME/bob/schedules.json`) and fallback (`~/.local/state/bob/schedules.json`), the JSON document shape, 0600 permissions, and atomic-write guarantees. The old "Policy admission for scheduled jobs" subsection — which instructed operators to copy scheduler-derived UUIDs into `[policy].admitted_users` — was replaced with "Admission of scheduled jobs" explaining the ADR-012 trust model: Unix trust boundary plus trusted schedule store, empty `admitted_users` does not block delivery, tool-call authorization still applies. The `bob schedule add/remove/reload` descriptions were updated to reference the JSON store rather than `config.toml`. The observability section was updated to remove the old claim about pre-flight verdict records being emitted for periodic events.

AC-4 — Replaced the two existing e2e tests with a single new test (`schedule_entry_from_json_store_is_delivered_when_admitted_users_is_empty`). The test writes a `schedules.json` file, reads it back with `read_schedule_store` (mirroring the production startup path from T-113/T-114), wires a requests-handler closure that replicates the production logic from `serve.rs` (Periodic events bypass `run_preflight` and are directly enqueued), uses empty `admitted_users`, and asserts byte-for-byte delivery to the fake sh worker.

AC-5 — All `[[schedule]]` references in the operator guide were updated or marked as migration notes. One reference was retained in a "Note on `[[schedule]]` in `config.toml`" box explicitly stating it is no longer read. The architecture-overview "Scheduler adapter" paragraph was rewritten to name the JSON store as source of truth.

**What was tried and rejected:**

Considered updating the two existing e2e tests in-place rather than replacing them. Rejected because the second test asserted the exact behavior that ADR-012 changed (periodic event denied by pre-flight), so updating it in-place would have turned it into a fundamentally different test with a misleading name. A clean replacement was clearer.

**What remains / reviewer attention:**

The extension-author-guide's "Shipped scheduler adapter" paragraph (`the-intern/docs/src/extension-author-guide/index.md`, line 153) still says "per configured `[[schedule]]` entry". This file is not in the task's Files to Touch list and was left unmodified; it is active guidance for adapter authors that arguably falls under AC-5 ("repository documentation still references `[[schedule]]` ... SHALL update or mark as historical"). Reviewer should decide whether this must be addressed within T-116 (e.g. a small in-scope fix or follow-up task). `cargo test --test scheduler_execution_e2e` passes (1 test); `cargo test --workspace` green; `cargo fmt --check` clean; `mdbook build` succeeded (one non-blocking mdbook-mermaid version-mismatch warning). Committed as `docs(operator-guide): update scheduler docs and e2e for JSON state` (`1732d5f`).

### Session 2 — 2026-06-30

**What changed.** The Reviewer (cycle 1) identified one remaining active `[[schedule]]` source-of-truth reference in `the-intern/docs/src/extension-author-guide/index.md` at line 153. The sentence "It creates one task per configured `[[schedule]]` entry and, on each cron tick, submits:" was updated to "It creates one task per entry in the JSON schedule store (`schedules.json`) and, on each cron tick, submits:". The surrounding bullet list and all other wording were left intact; only the source-of-truth noun phrase was corrected.

**Sweep results.** After the edit, `grep -rn "\[\[schedule\]\]" the-intern/docs/src` returned exactly two hits, both in `operator-guide/index.md` (lines ~395–397) inside the explicit migration callout box headed "Note on `[[schedule]]` in `config.toml`:" which states the TOML table is "no longer read by `bob serve`" and redirects to `schedules.json`. These are correctly marked historical and required no change.

**Verification.** `mdbook build` completed without errors (pre-existing mdbook-mermaid version warning only). `cargo test --test scheduler_execution_e2e` passed (1 test, 0 failures). Committed as `docs(extension-author-guide): name json schedule store as scheduler source` (`67eb991`).

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-06-30

FAIL

**Stage 1 — Acceptance Criteria**

- AC-1: PASS. `operator-guide/index.md` has a new "Schedule store (`schedules.json`)" subsection that documents `schedules.json` as the authoritative source, the Linux XDG state path (`$XDG_STATE_HOME/bob/schedules.json`), and the fallback (`~/.local/state/bob/schedules.json`).
- AC-2: PASS. The old "Policy admission for scheduled jobs" subsection (which instructed operators to copy scheduler-derived UUIDs into `[policy].admitted_users`) was entirely replaced. The new "Admission of scheduled jobs" subsection explicitly states: "Do not add scheduler-derived UUIDs to `[policy].admitted_users` for scheduled jobs."
- AC-3: PASS. The operator guide's admission section states scheduled jobs are admitted by the Unix trust boundary and the trusted schedule store, and explicitly states every `tool_call` still goes through S-004 action authorization. The architecture-overview paragraph was updated to match (ADR-012 reference, no per-job UUID required, S-004 applies).
- AC-4: PASS. The e2e test `schedule_entry_from_json_store_is_delivered_when_admitted_users_is_empty` writes a `schedules.json`, reads it back via `read_schedule_store`, uses an empty `PolicyConfig` (deny-all), and asserts byte-for-byte delivery to the fake sh worker. `cargo test --test scheduler_execution_e2e -- --nocapture` passes (1 test, 0 failed). `cargo test --workspace` passes (all 505+ tests across all crates, 0 failed).
- AC-5: FAIL. See below.

**AC-5 failure — active `[[schedule]]` reference in extension-author-guide**

Grep on the task branch confirms one remaining active (non-historical) `[[schedule]]` reference:

- **File:** `the-intern/docs/src/extension-author-guide/index.md`
- **Line:** 153
- **Current text:** `It creates one task per configured \`[[schedule]]\` entry and, on each cron tick, submits:`
- **What is wrong:** The "Shipped scheduler adapter" section describes current adapter behavior. Stating that the adapter creates tasks "per configured `[[schedule]]` entry" presents `[[schedule]]` in `config.toml` as the active scheduler source of truth. This is factually incorrect — the adapter now reads from `schedules.json` — and is active guidance for extension authors, not historical content. AC-5 requires that such a reference be updated or marked as historical.
- **What should change:** Update line 153 to name the JSON schedule store as the source. For example: `It creates one task per entry in the JSON schedule store (\`schedules.json\`) and, on each cron tick, submits:`

The operator-guide and architecture-overview `[[schedule]]` references were all correctly updated or explicitly marked as deprecated/historical on the task branch. Only this one line in the extension-author-guide remains.

**Stage 2 — Code Quality (checked, no additional issues)**

- The e2e test is well-structured: isolated temp dir, explicit JSON store write-then-read roundtrip mirroring production startup, production-like requests-handler closure (Periodic bypasses pre-flight), clear assertion messages, and a correct teardown sequence.
- The doc changes are accurate and internally consistent across operator-guide and architecture-overview.
- `cargo fmt --check` is clean. `mdbook build` succeeds (non-blocking mermaid version warning only).
- No unexpected files modified; no dead code or commented-out blocks added.

**Required fix before re-submit:** Update `the-intern/docs/src/extension-author-guide/index.md` line 153 to remove the active `[[schedule]]` reference (update to name `schedules.json` or mark as historical). This is the only blocking issue.
