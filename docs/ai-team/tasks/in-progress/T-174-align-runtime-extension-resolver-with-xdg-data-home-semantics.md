---
id: T-174
title: Align runtime extension resolver with XDG data-home semantics
status: pending
priority: high
assigned-role: unassigned
created: '2026-08-15'
---

# Align runtime extension resolver with XDG data-home semantics

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

Implement the S-013 / CR-008 runtime half of the XDG data-home amendment in bob's
configuration loader. Today `the-intern/service/crates/bob/src/config.rs` treats any
present `XDG_DATA_HOME` literally for the default `extension_path`, including `""` and
relative values. That diverges from the amended installer contract and can make a fresh
bundle install unusable without an explicit `extension_path` override.

Change only the runtime default extension resolver and its tests: unset or empty
`XDG_DATA_HOME` resolves to the platform default extension path; non-empty absolute
`XDG_DATA_HOME` is honored as `$XDG_DATA_HOME/bob/extensions/bob.ts`; and non-empty
relative `XDG_DATA_HOME` fails configuration load with a clear error naming
`XDG_DATA_HOME`. Keep the existing explicit `extension_path` configuration override as
the operator-owned override path.

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

AC-1: WHEN `XDG_DATA_HOME` is unset or empty THE SYSTEM SHALL resolve the default
      `extension_path` to the platform default extension path.
AC-2: WHEN `XDG_DATA_HOME` is non-empty and absolute THE SYSTEM SHALL resolve the default
      `extension_path` to `$XDG_DATA_HOME/bob/extensions/bob.ts`.
AC-3: IF `XDG_DATA_HOME` is non-empty and relative THEN THE SYSTEM SHALL fail configuration
      load with a `Configuration` error naming `XDG_DATA_HOME`.
AC-4: WHERE an explicit `extension_path` configuration value is provided THE SYSTEM SHALL
      keep that value as the override path rather than replacing it with the default
      resolver output.

## Dependencies

- None — this runtime resolver change is independent of T-170's install script except for
  the shared amended S-013 contract.

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — update the default extension resolver and
  add/adjust configuration tests for unset, empty, absolute, relative, and explicit-override
  cases.

## Verification

```bash
cd the-intern/service
cargo test -p bob config::tests::
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-15

Implemented the runtime XDG resolver update in `the-intern/service/crates/bob/src/config.rs`. Default extension-path resolution now happens after configuration overrides merge: an unset or empty `XDG_DATA_HOME` uses the platform default, a non-empty absolute value is honored, and a non-empty relative value returns a Configuration error naming `XDG_DATA_HOME`; an explicit `extension_path` override remains authoritative. Added empty and relative-value tests and retained coverage of existing unset, absolute, and override behavior. Focused configuration tests passed (39 passed), as did `cargo fmt --all -- --check`. Implementation commit: `8dda7d2`.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
