---
id: T-225
title: Add the pi_agent_model config key and reject model flags in pi_agent_args
status: in-progress
priority: high
assigned-role: developer
created: '2026-09-29'
---

# Add the pi_agent_model config key and reject model flags in pi_agent_args

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

Add the service-wide `pi_agent_model` configuration key and the
`pi_agent_args` restriction (CR-015; S-002 v0.2, Configuration → "pi-agent
process settings"). Motivation: GitHub issue #104 — without an explicit
`--model`, pi picks its model from its own saved settings and silently falls
back when that model disappears; with an explicit `--model` it fails loudly.

In `crates/bob/src/config.rs`, `BobConfig` and the raw deserialized struct gain
an optional `pi_agent_model` (top-level `snake_case` key, ADR-002; the existing
`env_overrides` mapping makes `BOB_PI_AGENT_MODEL` work automatically). The
value is a pi model pattern passed through verbatim — bob does not interpret,
list, default, or check it against pi. `validate()` additionally rejects any
`pi_agent_args` entry that selects a model: `--model`, `--models`, or
`--provider`, whether as a separate argument or in `--flag=value` form, so the
model is settable in exactly one place.

Also add the **single shared builder** S-002 requires: one `BobConfig` method
returning the pi arguments shared by pool workers and interactive sessions —
`["--model", <value>]` when set, empty when unset. T-226 wires it into both
spawn paths; this task only adds and unit-tests it. The unset-model startup
warning is T-226's, not this task's.

Rejecting a blank value (AC-2) guards against `--model ""`, which pi could
treat as no model and silently fall back; say so in a one-line code comment.
`crates/bob/tests/shell_e2e.rs` `client_cfg()` builds `BobConfig` field by
field (it cannot use the `#[cfg(test)]` `test_base()`), so it must gain
`pi_agent_model: None` or the integration test stops compiling.

## Acceptance Criteria

AC-1: The system shall parse an optional top-level `pi_agent_model` key (also
      settable through `BOB_PI_AGENT_MODEL`) into `BobConfig`, verbatim.
AC-2: IF `pi_agent_model` is set to an empty or whitespace-only value THEN THE
      SYSTEM SHALL fail configuration loading with an error naming
      `pi_agent_model`.
AC-3: IF `pi_agent_args` contains `--model`, `--models`, or `--provider`, as a
      separate argument or in `--flag=value` form, THEN THE SYSTEM SHALL fail
      configuration loading with an error that names the offending flag and
      says to set the model with `pi_agent_model`.
AC-4: The system shall provide one `BobConfig` method returning the shared pi
      arguments: `--model <value>` when `pi_agent_model` is set, and no
      arguments when it is unset.
AC-5: WHILE `pi_agent_model` is unset THE SYSTEM SHALL load configuration
      successfully with the model left unset.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — `pi_agent_model` field
  (`BobConfig`, raw struct, defaults, test base), validation of the value and
  of `pi_agent_args`, the shared-arguments method, and unit tests
- `the-intern/service/crates/bob/tests/shell_e2e.rs` — add
  `pi_agent_model: None` to `client_cfg()`

## Verification

```bash
cd the-intern/service && cargo test -p bob config && cargo fmt --all -- --check
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
