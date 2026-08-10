---
id: T-157
title: Add skill_install_path config key to BobConfig
status: pending
priority: high
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Add skill_install_path config key to BobConfig

## Description

S-011 Implementation Order Phase 4, depends on Phase 1 (T-150). Add the
`skill_install_path` configuration key already specified in S-002's approved
"Skill install path" configuration requirement: an optional, flat top-level
`snake_case` key in `BobConfig` (`the-intern/service/crates/bob/src/config.rs`,
ADR-002), mirroring how `extension_path`/`pi_agent_cwd` are implemented in
the same file. When set it must be an absolute path (relative is a load-time
configuration error, the same pattern as `pi_agent_cwd`'s existing
validation). When unset it resolves to the ADR-009 `data` bucket default
alongside the extension (e.g. `$XDG_DATA_HOME/bob/skills`, mirroring
`default_extension_path_for_env`'s resolution pattern). This task adds only
the config surface and its load/validation logic — wiring the resolved value
into the supervisor happens in T-159, and using it to answer
`resources_discover` happens in T-160 via T-158's env var plumbing.

## Acceptance Criteria

AC-1: The system shall expose an optional top-level `skill_install_path` key
      parsed into `BobConfig`.
AC-2: IF `skill_install_path` is set to a relative path THEN THE SYSTEM SHALL
      fail configuration loading with a clear error naming the key.
AC-3: WHILE `skill_install_path` is unset THE SYSTEM SHALL resolve it to the
      ADR-009 `data` bucket default location alongside the extension.
AC-4: WHERE `skill_install_path` names a non-existent directory THE SYSTEM
      SHALL still load configuration successfully (existence is not checked
      at load time, matching `pi_agent_cwd`'s and `extension_path`'s
      fail-open posture for missing content per ADR-014 §4).

## Dependencies

- `T-150` — reconciled pi-agent version record and confirmed
  `resources_discover` behaviour must exist before code is built against it

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — add the `skill_install_path`
  field, TOML parsing, default resolution, and validation

## Verification

```bash
cd the-intern/service && cargo test -p bob config
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-10

Implemented T-157 via TDD, red→green→refactor, one commit per acceptance criterion.
Added `skill_install_path: PathBuf` to `BobConfig` in
the-intern/service/crates/bob/src/config.rs, mirroring `extension_path`'s
resolution pattern (a required, always-populated field, not `Option<PathBuf>`
like `pi_agent_cwd`) since AC-3 requires it to always resolve to a concrete
value rather than stay unset. Parsing/default plumbing: `RawBobConfig` gained
a `skill_install_path` field, `defaults_with_runtime_root` populates it via a
new `default_skill_install_path_for_env` function that copies
`default_extension_path_for_env`'s XDG_DATA_HOME/HOME-fallback logic but
joins `bob/skills` instead of `bob/extensions/bob.ts` (S-002, ADR-009 `data`
bucket). `validate()` gained an absolute-path check for `skill_install_path`,
mirroring `pi_agent_cwd`'s existing check, returning a Configuration error
naming the key on a relative value (AC-2). No existence check is added
anywhere (AC-4) — the fail-open, non-checked posture was already the default
because no such check exists in the codebase for this kind of path.

Four cycles / four commits:
1. `feat(bob-config): add skill_install_path key parsed into BobConfig` —
   field + RawBobConfig + default resolution + TOML override, covering AC-1.
   Verified failing first via compile error (`no field skill_install_path`).
2. `test(bob-config): cover skill_install_path default XDG data-bucket
   resolution` — two tests for AC-3 (XDG_DATA_HOME set, and HOME fallback
   when XDG_DATA_HOME is absent). Both already passed on first run because
   the default-resolution implementation was a necessary part of cycle 1
   (RawBobConfig's `skill_install_path` field has no `#[serde(default)]`, so
   `defaults_with_runtime_root` had to supply a value to compile). Documented
   here per the tdd skill's guidance for this exact pitfall: the tests are
   still meaningful coverage of AC-3's resolution rule, so they were kept
   rather than treated as a defect.
3. `fix(bob-config): reject relative skill_install_path at load time` — AC-2
   test written and confirmed failing (loaded successfully with the relative
   value instead of erroring), then the `validate()` absolute-path check was
   added to make it pass.
4. `test(bob-config): cover skill_install_path fail-open on missing
   directory` — AC-4 test, also passed immediately (same reasoning as cycle
   2: no existence check was ever added, so the fail-open posture was already
   correct); kept as a regression lock.

One incidental change outside `config.rs`: `crates/bob/tests/shell_e2e.rs`'s
`client_cfg()` test helper builds a `BobConfig` via an exhaustive struct
literal (no `..BobConfig::test_base()`), so adding the new required field
broke its compile. Added `skill_install_path: PathBuf::new()` there,
consistent with the file's existing stand-in-value style for unused fields.
This is the only file touched outside the task's `Files to Touch` list, and
the change is mechanical (one line, no behavior change) — needed to keep
`cargo test --workspace` green.

Verification: `cargo test -p bob config` (task's stated command) — 52
passed, 0 failed. Also ran `cargo test --workspace` and `cargo fmt --all --
--check` clean.

Nothing remains for this task. Wiring the resolved `skill_install_path` into
the supervisor (T-159) and using it to answer `resources_discover` (T-160,
via T-158's env var plumbing) are explicitly out of scope per the task
description and were not touched.

Obstacles Encountered:
- `crates/bob/tests/shell_e2e.rs`'s `client_cfg()` helper constructs `BobConfig` via an exhaustive struct literal (not `..BobConfig::test_base()`), so it broke compilation once the new required field was added. Fixed with a one-line stand-in value (`PathBuf::new()`), consistent with that helper's existing style — the only file touched outside the task's `Files to Touch` list, and purely mechanical (no behavior change).
- AC-3 and AC-4 tests passed on first run rather than failing red, because their underlying behavior was a necessary side effect of making AC-1's field compile (default resolver) and of the codebase never having an existence check for this kind of path (fail-open). No workaround was needed; this is recorded per the tdd skill's guidance for that exact pitfall.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
