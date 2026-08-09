---
id: T-161
title: Update operator guide and quickstart to the skill install-path deployment
  model
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Update operator guide and quickstart to the skill install-path deployment model

## Description

S-011 Implementation Order Phase 5, depends on the model actually working end
to end (T-155 reduced email-triage, T-156 worklog packaged, T-159 config
wired, T-160 extension answering). Update
`the-intern/docs/src/operator-guide/index.md`'s "Deploying the
`email-triage` scheduled job" section (the real heading — verified at
`operator-guide/index.md:739`; there is no "Deploying email-skills"
section) and `the-intern/docs/src/quickstart/index.md`'s "Recommended
starting configuration" to replace the per-workspace deployed-copy procedure
(`cp -r the-intern/email-skills/. "$WORKSPACE/"`, working-directory-scoped
`arg_matchers` patterns like `{ field_path = "path", pattern =
"/abs/workspace/.pi/skills/email-triage/SKILL.md" }`) with the install-path
model: installing the packaged skill content once to `skill_install_path`
(or its default), and a single stable set of action rules scoped to that
install path rather than duplicated per deployment. Re-validate that the
documented action-rule set still matches the runtime tool-call payload
shapes (read rules on `arguments.path`, bash rules on `arguments.command`,
as already established by T-139/T-140) under the new path.

The operator guide's step 3 (pi's project-trust gate, `~/.pi/agent/trust.json`,
`operator-guide/index.md:783-812`) is asserted almost verbatim by
`the-intern/docs/test_operator_guide_email_triage_trust.sh`. Whether that
step survives, changes, or is removed depends on T-150's finding about
whether the trust gate also blocks extension-contributed
`resources_discover` paths — update the script to match whatever this task
ends up documenting.

Several locations also carry a stale claim, predating the 2026-08-06 S-002
amendment, that `pi_agent_cwd` governs skill discovery — S-002 as amended
states "Skills are **not** affected by this key." Correct all of them, not
just the deployment section.

## Acceptance Criteria

AC-1: The system shall replace the per-workspace deployed-copy procedure in
      the operator guide's "Deploying the `email-triage` scheduled job"
      section with the install-path deployment procedure.
AC-2: The system shall replace the working-directory-scoped `arg_matchers`
      examples with a single stable action-rule set scoped to the configured
      or default `skill_install_path`.
AC-3: The system shall correct the stale `pi_agent_cwd`-governs-skills claim
      at `quickstart/index.md:138`, `operator-guide/index.md:249`,
      `operator-guide/index.md:269`, and the security note at
      `operator-guide/index.md:557`, to match S-002's 2026-08-06 amendment.
AC-4: The system shall document the `skill_install_path` config key itself
      (absolute-only, ADR-009 `data`-bucket default alongside the extension,
      fail-open on a missing/nonexistent path) alongside the existing
      `pi_agent_cwd`/`extension_path` documentation.
AC-5: The system shall update `the-intern/docs/test_operator_guide_email_triage_trust.sh`
      so its assertions match the rewritten deployment section (including
      the project-trust step per T-150's finding), or state explicitly why
      the trust step and script are unaffected.

## Dependencies

- `T-150` — determines whether/how the project-trust step changes (AC-5)
- `T-155` — reduced email-triage skill (final content shape to document)
- `T-156` — worklog skill packaged (now a third skill to document)
- `T-159` — supervisor wiring (so the documented model is actually live)
- `T-160` — extension answering `resources_discover` (so the documented
  model is actually live)

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — "Deploying the
  `email-triage` scheduled job" section, the stale `pi_agent_cwd` claims at
  lines 249/269/557, and the new `skill_install_path` documentation
- `the-intern/docs/src/quickstart/index.md` — "Recommended starting
  configuration" section and the stale claim at line 138
- `the-intern/docs/test_operator_guide_email_triage_trust.sh` — update
  assertions to match the rewritten section (AC-5)

## Verification

```bash
grep -q "skill_install_path" the-intern/docs/src/operator-guide/index.md
grep -q "skill_install_path" the-intern/docs/src/quickstart/index.md
! grep -q 'cp -r the-intern/email-skills/\.' the-intern/docs/src/operator-guide/index.md
bash the-intern/docs/test_operator_guide_email_triage_trust.sh
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
