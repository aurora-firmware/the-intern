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

### Session 1 — 2026-09-14

Implemented T-201 end to end in three TDD cycles on `task/T-201-invoke-bob-init-skills-only-from-install-sh`.

Cycle 1 (AC-1, AC-2, AC-4): extended `test-install.sh`'s shared `make_bundle` stub `bob` script so it can log its own invocation args (`BOB_STUB_INVOCATION_LOG`), print a fake `init --skills-only` report, and exit with a controllable status (`BOB_STUB_SKILLS_ONLY_EXIT`) — all opt-in via env vars so every pre-existing test keeps its old default (silent, exit 0) behavior. Added `test_invokes_installed_binary_directly_for_skills_only_refresh` (proves `install.sh` calls `$install_binary_path` even when a different `bob` shadows it earlier on `PATH`, reusing the same PATH-shadow scenario the existing shadow-warning test already sets up), `test_never_passes_force_to_skills_only_invocation`, and `test_skills_only_success_output_is_not_suppressed`. Confirmed all three failed for the expected reason, then added the minimal `install.sh` line — `"$install_binary_path" init --skills-only` right after the extension copy — which made all three pass. Along the way found and fixed a pre-existing bug in `assert_contains`/`assert_not_contains`: `grep -Fq "$pattern"` without a `--` separator treats a `--force`-shaped pattern as an option and errors out; added `--` to both helpers.

Cycle 2 (AC-3): added `test_skills_only_failure_warns_and_does_not_block_install`, which forces the stub to exit 7 for `init --skills-only` and asserts `install.sh` still exits 0, still reports the binary/extension as installed, and prints a warning naming the failure. First draft of the test had a bug — capturing `$?` right after a negated `if ! (subshell); then` clobbers the value with the `if`'s own boolean result, not the subshell's real exit code, so `status` was always read as 0 — caught this because the test failed with an unexpected assertion message rather than the expected one; rewrote it using the same `if (...); then status=0; else status=$?; fi` shape already used by `test_abort_when_overwrite_prompt_hits_eof`. Confirmed genuine red (install.sh was exiting 7 due to `set -e` propagating the unguarded call's failure), then wrapped the invocation in `if ... ; then :; else skills_only_status=$?; printf 'Warning: ...' >&2; fi`, which made the test pass without affecting any other test.

AC-5 was a docs-only change: added a note in "Install the skill package" stating that a zip-based `install.sh` run already performs this refresh automatically (never passing `--force`, warning and continuing on failure) so a manual `bob init --skills-only` is only needed for non-zip upgrade paths (`mise`, source build), plus a one-line cross-reference from "Upgrading a running install" pointing at that note. Verified with `mdbook build` (clean, no new warnings).

After all three commits, did a manual end-to-end check per the task's Verification section using a real `cargo build -p bob` debug binary in an isolated `$HOME`: a fresh `./install.sh` run populated `skill_install_path` with all four skill packages and no separate `bob init --skills-only` call, streaming the subcommand's own `created:` report; a second run with a stub `bob` that exits 3 for `init --skills-only` still installed the binary/extension successfully and printed only the expected warning to stderr, with `install.sh`'s own exit code staying 0.

Nothing was rejected or deferred; all five acceptance criteria are implemented and covered by automated tests plus the manual verification above. Nothing remains for this task.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-14

PASS

Reviewed branch `task/T-201-invoke-bob-init-skills-only-from-install-sh` (3
commits: ea89a4e, b3bdbf2, 2b7fc06) diffed against `dev-agent`, against S-013
v0.3 (CR-012) and this task's five acceptance criteria.

**Stage 1 — Acceptance criteria (all met, with evidence):**
- AC-1: `install.sh` invokes `"$install_binary_path" init --skills-only`
  (not a PATH-resolved `bob`), placed after the binary replace + extension
  copy, before the `pi`/PATH checks — matching the flow order the task
  description specifies. Verified `test_invokes_installed_binary_directly_for_skills_only_refresh`
  genuinely catches a regression: swapping in an unqualified `bob` call
  made the test fail (the PATH-shadowing stub is never invoked; the
  install-path binary's own invocation log goes missing).
- AC-2: no `--force` is passed. Verified `test_never_passes_force_to_skills_only_invocation`
  passes and is a real check (asserts against the stub's invocation log).
- AC-3: the call is guarded with `if ... ; then :; else skills_only_status=$?; printf 'Warning: ...' >&2; fi`,
  so a non-zero exit only warns (naming the failure) and never propagates
  through `set -e`. Verified `test_skills_only_failure_warns_and_does_not_block_install`
  forces exit 7, asserts `install.sh` still exits 0, still installs the
  binary/extension, and prints the warning to stderr.
- AC-4: no output redirection on the invocation, so `bob init --skills-only`'s
  own report streams to stdout. Verified `test_skills_only_success_output_is_not_suppressed`.
- AC-5: `the-intern/docs/src/operator-guide/index.md`'s "Install the skill
  package" section now states a zip-based `install.sh` run performs this
  refresh automatically (never `--force`, warns and continues on failure),
  with a cross-link from "Upgrading a running install". Confirmed both
  anchors exist and `mdbook build` (with `BOB_BIN` pointed at a freshly
  built debug binary) completes cleanly — the only warning present is the
  pre-existing, unrelated mdbook-mermaid version-mismatch notice.

Exactly the three files listed in "Files to Touch" were modified (stat:
`install.sh` +15, `test-install.sh` +190/-3, `operator-guide/index.md` +16).
No unspecified behavior or scope creep.

**Stage 2 — Code quality:** Correctness confirmed by running
`bash the-intern/install-bundle/test-install.sh` (exits 0; all 4 new tests
plus the full pre-existing suite ran, confirmed via targeted regression
breaks above). Tests are independent (each uses its own `mktemp -d`) and
cover the success, PATH-shadow, `--force`-absence, non-suppressed-output,
and non-blocking-failure paths. No secrets or unvalidated external input.
Naming and comments are clear; the guard block's rationale is documented
inline. No dead code. Commit history is clean and matches the work log
narrative (cycle 1 adds the unguarded call + AC-1/2/4 tests, cycle 2 adds
the non-blocking guard + AC-3 test, cycle 3 is docs-only).

Minor non-blocking observation: commit ea89a4e also fixes a pre-existing
`assert_contains`/`assert_not_contains` bug (`grep -Fq "$pattern"` treating
a `--force`-shaped pattern as an option) by adding a `--` separator. This is
in scope — it was required to write the AC-2 test in the same file already
listed under "Files to Touch" — and is minimal.

Manual verification section of the task's Work Log (real `cargo build -p bob`
debug binary, isolated `$HOME`, fresh install + forced-failure re-run) is
consistent with the automated evidence above.

Next owner: Development Loop.
