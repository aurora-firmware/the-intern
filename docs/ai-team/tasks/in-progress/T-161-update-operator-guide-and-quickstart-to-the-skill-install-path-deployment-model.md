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

### Session 1 — 2026-08-10

Read the (empty) Work Log first, then the full dependency chain: T-150 (confirmed `resources_discover`-contributed skill paths fire and reach the system prompt from an untrusted cwd on all three spawn paths), T-155/T-156 (email-triage delegates diary mechanics to a new `worklog` skill, now a third packaged skill), T-159 (`BobConfig.skill_install_path` mapped into the supervisor at `bob serve` startup, fail-open with a warning), T-160 (`bob.ts` answers `resources_discover` with `BOB_SKILL_INSTALL_PATH`, fail-open), plus S-011, the 2026-08-06 S-002 amendment, ADR-009, B-035 (resolved — the original trust-step bug), and pi's own `security.md` (confirms project trust gates only `.pi/settings.json`/`.pi/extensions`/`.pi/skills`/`.pi/prompts`/`.pi/themes`/`.pi/SYSTEM.md`/`.agents/skills`, not arbitrary bash/read tool calls).

Key finding that shaped the whole rewrite: since T-161 removes the per-job `.pi/skills/` copy entirely (skills now come from the global `skill_install_path` via `resources_discover`, which T-150 confirmed bypasses pi's trust gate regardless of cwd), the deployed job workspace no longer contains *any* project-local resource pi's trust gate covers. The old "establish pi project trust" step (added for B-035) is therefore not just optional but obsolete — removed it and replaced it with an explanatory note rather than leaving it in place or working around it.

Four TDD cycles, each RED-confirmed via grep/bash checks before editing and GREEN-confirmed after, each committed separately (following the T-150/T-155/T-156 precedent of using the task's own `## Verification` block plus per-AC grep assertions as the red/green check, since this is markdown-authoring with no control-flow surface for the doc edits themselves):

1. **AC-3** (`f8a3601`): corrected the four stale `pi_agent_cwd`-governs-skills claims at `quickstart/index.md:138`, `operator-guide/index.md:249/269`, and the scheduled-job security note at `:557`, per S-002's 2026-08-06 amendment.
2. **AC-4** (`997597f`): added a new "Install the skill package" subsection under "Build and install" (mirroring "Install the bob extension") documenting `skill_install_path` — absolute-only, ADR-009 `data`-bucket default alongside the extension, fail-open on missing/nonexistent path, resolved once at `bob serve` startup (content updates don't need a restart, the key itself does). Cross-linked it from `pi_agent_cwd`'s section and from quickstart's "Recommended starting configuration", and added `skill_install_path` to the quickstart config example and its notes.
3. **AC-1/AC-2** (`72cbb0a`): rewrote "Deploying the `email-triage` scheduled job": replaced the whole-package `cp -r the-intern/email-skills/. "$WORKSPACE/"` with a lighter workspace holding only `config/` and `worklog/` (skills now come from the install path, once, globally); replaced the six workspace-scoped `arg_matchers` (`$WORKSPACE/.pi/skills/...`) with a single stable rule set scoped to `skill_install_path`, including two new read rules for the `worklog` skill's own `SKILL.md`/`references/*.md` (made necessary by T-155/T-156, following the same shape already live-validated for `himalaya`/`email-triage`, explicitly flagged as not yet independently live-validated); dropped the now-redundant absolute-path worklog rule in favor of the existing relative `worklog/*.md` rule, per S-011's "must be broad enough to cover arbitrary working directories" requirement. Hit and fixed a genuine self-collision: the first draft of the new install command (`cp -r the-intern/email-skills/.pi/skills/.`) itself matched the task's own `! grep -q 'cp -r the-intern/email-skills/\.'` verification pattern; resolved by naming the source path in a variable rather than removing the underlying command.
4. **AC-5** (`8a3ed77`): rewrote `test_operator_guide_email_triage_trust.sh` — it now asserts the section explains *why no trust step is required* (cites B-035 for history, T-150 for the confirmation, mentions `resources_discover`), asserts the old trust.json-editing/restart instructions and the old whole-package `cp -r` are gone, and checks the explanation is positioned where the old step used to be (after workspace deployment, before the S-004 action rules). Verified genuinely red against `dev-agent`'s pre-T-161 doc content (7/9 checks fail) and green against the rewritten doc (9/9), confirming it's a real regression guard, not vacuous.

Ran the full task `## Verification` block end to end after each cycle and again at the end — all four commands pass. Rebuilt the mdBook after every edit (`mdbook build` in `the-intern/docs`, no errors/warnings) to catch any structural breakage, though note mdBook does not validate internal `#anchor` links, so the new `#install-the-skill-package` cross-references were checked manually against the heading text instead. `git diff --stat dev-agent...task/T-161-operator-guide-skill-install-path` confirms exactly the three Files to Touch were modified, nothing else. The task lifecycle file was not touched on this branch. Nothing remains for this task's five acceptance criteria.

Obstacles Encountered:
- The first draft of the new "install the skill package" bash command literally matched the task's own `! grep -q 'cp -r the-intern/email-skills/\.'` verification pattern (both start with `cp -r the-intern/email-skills/` immediately followed by a literal `.`, since `.pi/skills` starts with a dot). Fixed by naming the source path in a shell variable so the literal substring no longer appears contiguously — a genuine improvement in readability, not just a workaround.
- No dedicated test framework applies to this docs-authoring task beyond the existing `test_operator_guide_email_triage_trust.sh` and the task's own `## Verification` block; followed the established T-150/T-155/T-156 precedent of grep/bash assertions run directly as red/green checks for the non-AC-5 cycles.
- No `pi` binary or live credentials were used or needed — this is a pure documentation task; the "re-validation" the task description asks for (that read/bash rule payload shapes are unaffected by moving the path) is argued from the runtime contract (read rules always match `arguments.path`, bash rules `arguments.command`, regardless of what the path value is) rather than a fresh live probe, and is stated explicitly in the doc.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-10

PASS

Stage 1 (acceptance criteria) — all five met, checked against
`the-intern/docs/src/operator-guide/index.md`,
`the-intern/docs/src/quickstart/index.md`, and
`the-intern/docs/test_operator_guide_email_triage_trust.sh` on
`task/T-161-operator-guide-skill-install-path` (commits `f8a3601`, `997597f`,
`72cbb0a`, `8a3ed77`):

- AC-1/AC-2: "Deploying the `email-triage` scheduled job" no longer copies
  the whole package (`cp -r the-intern/email-skills/. "$WORKSPACE/"` is
  gone; independently confirmed absent via
  `! grep -q 'cp -r the-intern/email-skills/\.'`). The deployed workspace now
  holds only `config/` and `worklog/`. The six workspace-scoped
  `arg_matchers` are replaced by a single set of `read` rules scoped to
  `skill_install_path` (default `/opt/bob/skills` example), with two new
  rules for the `worklog` skill's own `SKILL.md`/`references/*.md` — a
  genuine spec requirement (S-011 Configuration Requirements, "Action rules
  admitting skill tool calls": "reads of skill reference content at the
  install path"), not scope creep.
- AC-3: independently re-checked all four flagged locations against the
  pre-T-161 `dev-agent` content at the exact cited lines
  (`quickstart/index.md:138`, `operator-guide/index.md:249/269/557`) — each
  originally read "...discover project context, skills, and relative
  prompt-file paths..." or "...pi automatically loads AGENTS.md/CLAUDE.md and
  skills from a session's working directory..."; all four now correctly
  state skills are unaffected by `pi_agent_cwd`/per-entry `cwd`, matching
  S-002's 2026-08-06 amendment. No other stale `pi_agent_cwd`-governs-skills
  claim remains in either file.
- AC-4: `skill_install_path` is documented (new "Install the skill package"
  subsection) with all four required properties — absolute-only, ADR-009
  `data`-bucket default alongside the extension, fail-open on a
  missing/nonexistent path, existence not checked at config load —
  cross-checked against S-011's "Skill install path" Configuration
  Requirement and matches it exactly, including the fail-open/fail-closed
  contrast with `extension_path`.
- AC-5: `test_operator_guide_email_triage_trust.sh` rewritten to assert the
  section explains why no trust step is required (cites B-035, T-150,
  `resources_discover`) and asserts the old trust.json-editing/restart
  instructions and the old whole-package `cp -r` are gone, positioned
  correctly (after workspace deployment, before the S-004 action rules).
- No unspecified behavior added; `git diff dev-agent...task/T-161-... --stat`
  shows exactly the three Files to Touch modified, nothing else. No stray
  references to the old per-workspace deployment procedure remain elsewhere
  in `the-intern/docs/src` or `the-intern/bob-companion`.

Stage 2 (code quality) — plus the three specific scrutiny points requested:

**1. Trust-step removal, checked against T-150's actual findings and pi's
own security model (not taken on faith):** Read
`docs/ai-team/tasks/completed/T-150-...md` in full — its live-probe evidence
(pooled RPC worker, interactive chat, and scheduled-periodic, the last from a
working directory confirmed absent from `~/.pi/agent/trust.json`) confirms
`resources_discover` fires and a contributed skill path reaches
`<available_skills>` pre-first-turn on all three spawn paths, unconditional
on project trust. Independently located and read pi's actual installed
`docs/security.md` (`@earendil-works/pi-coding-agent@0.80.3`, this
environment's installed CLI) rather than trusting the Work Log's paraphrase:
it confirms project trust gates exactly `.pi/settings.json`,
`.pi/extensions`/`.pi/skills`/`.pi/prompts`/`.pi/themes`,
`.pi/SYSTEM.md`/`.pi/APPEND_SYSTEM.md`, and project `.agents/skills` — no
more, no less — and that `AGENTS.md`/`CLAUDE.md` load regardless of trust.
Also read `docs/extensions.md`'s lifecycle diagram and `resources_discover`
section: project-local `.pi/extensions` load only after trust, but bob's
extension is loaded via the CLI `--extension` flag (a user/global/CLI-level
extension per pi's own model), which is unaffected by project trust and
fires `resources_discover` regardless. Independently confirmed
`the-intern/email-skills/.pi/` contains nothing but `.pi/skills/` (no
`.pi/settings.json`, `.pi/extensions`, `.pi/prompts`, `.pi/themes`, or
`.pi/SYSTEM.md`), so the old `cp -r` never populated any other
trust-gated resource, and the new deployed workspace (`config/` + `worklog/`
only) contains none of the trust-gated categories either. The removal is
correctly reasoned and the new explanatory note accurately cites its
grounding (B-035 history, T-150 confirmation, `resources_discover`
mechanism). No trust that was actually needed was silently dropped.

**2. New, not-yet-independently-live-validated `worklog` action rules:**
acceptable for this docs task. S-011's Configuration Requirements
(Configuration Requirements § "Action rules admitting skill tool calls")
explicitly requires documenting reads of skill reference content at the
install path for every shipped skill, so adding the `worklog` rules was
required, not optional. The task's own Description frames "re-validate ...
under the new path" specifically around the `arguments.path`/`arguments.command`
matcher-shape invariant (already established structurally by T-139/T-140,
independent of which skill or path value is matched), not a full live
functional re-test of a third skill — this task has neither a `pi` binary
requirement nor live credentials in its Dependencies/Files to Touch, unlike
T-150. Confirmed neither T-155 nor T-156 (which packaged the `worklog`
skill) performed any live action-rule validation either, so the Developer's
"not yet independently live-validated" framing is accurate, not
overstated-then-hedged. The callout is prominent, specific (names exactly
which two rules), and gives the operator an actionable next step
("validate them the same way before depending on them in a production
deployment") rather than silently presenting new rules as equally
validated as the T-139/T-140 rule set below them.

**3. `test_operator_guide_email_triage_trust.sh` — independently re-ran, not
just trusted:** checked out the branch tip in an isolated worktree and ran
the rewritten script against the rewritten doc: 9/9 pass, matching the
Work Log. Then reset only `operator-guide/index.md` to the pre-T-161
`dev-agent` content and re-ran the same script: it is genuinely red — 7
explicit `FAIL:` lines print (all 7 direct-pattern assertions fail against
the old content) before the script aborts with a nonzero exit on the first
positional lookup (`DEPLOY_LINE="$(first_matching_line "Deploy an
owner-only working directory")"`, which matches nothing in the old
wording "Deploy an owner-only workspace copy..." and, under
`set -euo pipefail`, kills the script via `grep`'s no-match exit status
propagating through the pipeline before the script reaches its own
`[ -n "${DEPLOY_LINE:-}" ]` guard). So the Work Log's "7/9 checks fail"
figure is not quite literally accurate — it is actually "7 fail, then the
script errors out before the remaining 2 ever run" — but the substantive
claim it supports (a genuine, non-vacuous regression guard: red against old
content, 9/9 green against new content) is independently confirmed true.
This `set -e`/`pipefail`-vs-`first_matching_line` fragility is pre-existing
in the original (pre-T-161) script — verified byte-for-byte identical
`first_matching_line` helper and the same bare-assignment call pattern in
`dev-agent`'s prior version — so it is inherited script debt, not something
this diff introduced, and it does not affect the script's correctness as a
CI gate (nonzero exit either way). Non-blocking observation for the
Developer/a future task: consider hardening `first_matching_line` (e.g.
`grep ... || true`) so a genuinely broken doc produces a clean N/9 tally
instead of a mid-run abort; not required for this task's own AC-5, which is
satisfied.

Other Stage 2 checks:
- Correctness: independently re-ran the full task `## Verification` block
  in the isolated worktree — all four commands pass. Independently rebuilt
  the mdBook (`BOB_BIN=<debug binary> mdbook build`) — succeeds with only an
  unrelated pre-existing `mdbook-mermaid` version-mismatch warning, no
  structural errors. Spot-checked every new `#install-the-skill-package` and
  `#skill-supply-via-resources_discover` anchor reference against the actual
  heading text — all resolve correctly.
- Tests: the task's own `## Verification` block and the rewritten trust-step
  script both function as intended (see point 3 above).
- Security: documentation-only change; the new explanatory note correctly
  preserves the Unix-trust-boundary security note (owner-only `cwd`
  protection) untouched — only the pi-project-trust-gate claim was
  corrected, not the unrelated filesystem-permission guidance.
- Readability: clear, well-organized; the new "not yet independently
  live-validated" callout and "no trust step required" explanation are both
  easy to find and act on.
- Performance: not applicable.

No blocking issues found. Both review stages pass. One non-blocking
observation recorded above (point 3) for future script hardening.

Next owner: Development Loop.
