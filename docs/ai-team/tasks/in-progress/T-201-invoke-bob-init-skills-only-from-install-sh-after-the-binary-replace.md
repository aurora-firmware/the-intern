---
id: T-201
title: Invoke bob init --skills-only from install.sh after the binary replace
status: pending
priority: medium
assigned-role: developer
created: '2026-09-14'
spec: S-013
---

# Invoke bob init --skills-only from install.sh after the binary replace

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

Per S-013 v0.3 (CR-012), `install.sh` must invoke the `bob` binary it just
installed as `init --skills-only` immediately after the atomic binary
replace step, to refresh the shared skill package on every upgrade with no
separate manual step. This is purely additive to `install.sh`'s existing
flow (binary replace → extension copy → **new: skills refresh** → PATH/`pi`
checks → summary). It must invoke `$install_binary_path` directly (the file
`install.sh` just wrote), not a `PATH`-resolved `bob` — consistent with the
existing PATH-shadow-warning logic already in the script, which established
that another `bob` can shadow the one just installed. It must never pass
`--force`. Failure must be non-blocking: print a warning and continue: this
mirrors the existing `pi`-on-`PATH` check, which is already informational
and non-blocking.

The `bob init --skills-only` flag itself is already implemented, tested,
and merged (PR #88) — this task only wires `install.sh` to call it. See
`docs/ai-team/specs/S-013-cross-platform-bob-install-bundle-release-packaging.md`
(Component 3, Workflow, Configuration Requirements) for the full amended
contract, and `docs/ai-team/change-requests/CR-012-bob-init-skills-only-is-a-sanctioned-refresh-path-wired-into-install-sh.md`
for why this exists.

## Acceptance Criteria

AC-1: WHEN `install.sh` finishes replacing the `bob` binary THE SYSTEM SHALL
      invoke `$install_binary_path init --skills-only` — the binary
      `install.sh` just wrote, not a `PATH`-resolved `bob`.
AC-2: The system shall never pass `--force` to this invocation.
AC-3: IF the `bob init --skills-only` invocation exits non-zero THEN THE
      SYSTEM SHALL print a warning naming the failure and continue the
      install; `install.sh`'s own exit code SHALL be unaffected by this
      step's failure.
AC-4: WHEN the invocation succeeds THE SYSTEM SHALL not suppress its
      output — the operator sees `bob init --skills-only`'s own
      created/replaced/skipped report.
AC-5: The system shall state, in the Operator Guide's "Install the skill
      package" section, that `install.sh` performs this refresh
      automatically, so a zip-based upgrade needs no separate manual
      `bob init --skills-only` run.

## Dependencies

- None

## Files to Touch

- `the-intern/install-bundle/install.sh` — invoke `$install_binary_path init
  --skills-only` after the binary replace, non-blocking on failure
- `the-intern/install-bundle/test-install.sh` — regression tests for AC-1
  through AC-4 (success path, non-zero-exit path, `--force` never passed,
  output not suppressed)
- `the-intern/docs/src/operator-guide/index.md` — AC-5's documentation note

## Verification

```bash
bash -n the-intern/install-bundle/install.sh
bash the-intern/install-bundle/test-install.sh

# Manual: from an isolated temp HOME/XDG_CONFIG_HOME/XDG_DATA_HOME, run
# install.sh against a real bob binary build. Confirm skill_install_path
# is populated after install.sh finishes, with no separate `bob init
# --skills-only` invocation. Then replace $install_binary_path with a
# non-executable stub before re-running install.sh's skills-only step (or
# otherwise force it to fail) and confirm install.sh still reports success
# for the binary/extension install, with only a warning about the skill
# refresh.
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
