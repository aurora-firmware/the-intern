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

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
