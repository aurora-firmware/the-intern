---
id: T-163
title: Add Claude packaging target generating a Claude-shaped skill package from
  the canonical source
status: pending
priority: medium
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Add Claude packaging target generating a Claude-shaped skill package from the canonical source

## Description

S-011 Implementation Order Phase 2/3. S-011's Purpose and System Diagram
require per-vendor packaging targets so "the same skill content is loadable
by both supported vendors from one source tree" — today only a pi target
exists (T-153/T-156). Add a second packaging target that generates a
Claude Code-shaped skill package from the canonical source under
`the-intern/email-skills/skills/{himalaya,email-triage,worklog}/`, with no
independent copy of body content. This is a **new, separate** packaging
target under `the-intern/email-skills/` (e.g.
`the-intern/email-skills/claude/`) — S-011's Exclusions explicitly state it
must not modify or absorb `the-intern/bob-companion/claude` (different
audience/release cadence). Use the frontmatter and layout conventions
already visible in `the-intern/bob-companion/claude/skills/*/SKILL.md` as
the reference shape for what a Claude Code skill file looks like (a
different concern — bob operator tooling — but the same vendor's file
format), and confirm the exact conventions against Claude Code's own skill
documentation rather than assuming this repo's example is exhaustive.

## Acceptance Criteria

AC-1: The system shall provide a packaging script that generates a Claude
      Code-shaped skill package (one `SKILL.md` per skill, following Claude
      Code's skill frontmatter/layout conventions) from the canonical
      source under `the-intern/email-skills/skills/`.
AC-2: The generated package shall live under a new location within
      `the-intern/email-skills/` (e.g. `the-intern/email-skills/claude/`)
      and the system shall not modify any file under
      `the-intern/bob-companion/claude/`.
AC-3: WHEN the Claude packaging script runs THE SYSTEM SHALL produce output
      for all three canonical skills (`himalaya`, `email-triage`, `worklog`)
      — including each skill's full `references/` tree (e.g.
      `email-triage/references/categories/*`) — whose content is
      byte-for-byte identical to the canonical source.
AC-4: The system shall provide a Claude Code plugin manifest at
      `the-intern/email-skills/claude/.claude-plugin/plugin.json`, mirroring
      the shape of `the-intern/bob-companion/claude/.claude-plugin/plugin.json`
      with this package's own name and description, carrying no skill body
      content (manifest and layout only, per S-011's Design Principles).

## Dependencies

- `T-151` — canonical himalaya source must exist
- `T-152` — canonical email-triage source must exist
- `T-154` — canonical worklog source must exist
- `T-155` — the last task that changes canonical content; generating this
  target before the email-triage reduction lands would commit a Claude
  package carrying pre-reduction diary content that no later task
  regenerates (Gate 2 dependency correction, 2026-08-09)

## Files to Touch

- `the-intern/email-skills/package-claude-skills.sh` (or equivalent) — new
  packaging script
- `the-intern/email-skills/claude/skills/himalaya/SKILL.md` — new generated
  output
- `the-intern/email-skills/claude/skills/email-triage/SKILL.md` — new
  generated output
- `the-intern/email-skills/claude/skills/worklog/SKILL.md` — new generated
  output
- `the-intern/email-skills/claude/skills/*/references/**` — new generated
  output (full reference trees for all three skills)
- `the-intern/email-skills/claude/.claude-plugin/plugin.json` — new manifest

## Verification

```bash
cd the-intern/email-skills && ./package-claude-skills.sh && \
  test -f claude/.claude-plugin/plugin.json && \
  test -f claude/skills/himalaya/SKILL.md && \
  test -f claude/skills/email-triage/SKILL.md && \
  test -f claude/skills/worklog/SKILL.md && \
  diff -r skills/himalaya/references claude/skills/himalaya/references && \
  diff -r skills/email-triage/references claude/skills/email-triage/references && \
  diff -r skills/worklog/references claude/skills/worklog/references
```

The reference trees are compared with `diff -r` against the canonical source
rather than asserted as named files, because T-155 (a dependency of this
task) may delete `skills/email-triage/references/worklog.md` — a named
`test -f claude/skills/email-triage/references/worklog.md` would then fail a
correct implementation. `diff -r` stays correct either way, and additionally
proves AC-3's byte-for-byte identity and catches stale files in the
generated tree (Gate 2 verification correction, 2026-08-09).

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-10

Implemented T-163's Claude packaging target across six TDD cycles, one commit each on `task/T-163-claude-packaging-target`. T-151/T-152/T-154/T-155 had already landed the canonical vendor-neutral skill source under `the-intern/email-skills/skills/{himalaya,email-triage,worklog}/`, post email-triage reduction; this session added a second, independent packaging target alongside T-153's pi target, per S-011's "same source, multiple vendor-shaped outputs" requirement.

Before writing any code, fetched Claude Code's own skill documentation (`code.claude.com/docs/en/skills.md` and `plugins-reference.md`, via `.md`-suffixed doc URLs which return plain markdown instead of the JS-rendered HTML page) rather than assuming `the-intern/bob-companion/claude/skills/*/SKILL.md` was an exhaustive example, per the task's explicit instruction. Confirmed: (1) SKILL.md frontmatter only requires `description` to be useful, and `name`/`compatibility` are both valid Agent-Skills-spec fields Claude Code accepts as-is — the canonical source's existing frontmatter (`name`, `description`, `compatibility` on himalaya) needs zero vendor-specific additions, unlike pi's `allowed-tools` requirement; (2) a skill is a directory with `SKILL.md` plus optional `references/` etc., matching the canonical layout already; (3) a `.claude-plugin/plugin.json` at a skill-bearing directory's root turns it into an installable plugin, with `name` as the only required field and `description`/`version`/`author`/`homepage`/`repository`/`license`/`keywords` as recognized metadata fields — exactly the shape `bob-companion/claude/.claude-plugin/plugin.json` already uses.

This confirmation simplified the implementation considerably relative to T-153's pi script: `package-claude-skills.sh` does a plain `rm -rf` + `cp -r` per skill (regenerate-from-scratch, same rationale as the pi script) with no frontmatter awk pass, so AC-3's byte-for-byte identity requirement holds by construction rather than needing a stripped-line diff like the pi target's AC-2 test does. The plugin manifest is separate, script-owned static content (S-011 Design Principles: "manifest and layout only, no skill body content") — not derived from any skill's canonical source — written as a heredoc with name `email-skills`, its own description, and the same top-level key set as `bob-companion`'s manifest (`version`, `author`, `homepage`, `repository`, `license`, `keywords`).

TDD cycles, each committed separately: (1) AC-1 — script copies each canonical skill dir into `claude/skills/<name>/`, tested via presence of `SKILL.md` + `references/` for all three skills in an isolated `mktemp -d` copy; genuine red→green (script didn't exist yet). (2) AC-3 (byte identity) — `diff -r` against canonical source for all three skills; this test passed immediately once written, since the AC-1 implementation's straight copy already satisfies it — no artificial red step forced, documented here explicitly rather than silently skipped, mirroring T-153's own documented precedent for its analogous no-red AC. (3) AC-3 (regeneration removes stale output) — same no-red situation, since `rm -rf` was already present from the first minimal implementation; added retroactively to formally cover behavior that was already written, again following the T-153 precedent of not skipping test coverage just because there was no red step available. (4) AC-2 — script never touches `bob-companion/claude`: built an isolated copy mirroring the real repo's sibling layout (`<tmp>/the-intern/{email-skills,bob-companion}`), snapshotted `bob-companion`'s file hashes before and after running the script, asserted no diff; also no red step (true by construction, since the script only ever resolves paths under its own directory via `BASH_SOURCE`), documented the same way. (5) AC-4 — plugin manifest: genuine red→green, the only cycle needing new production code. Test asserts the manifest exists, is valid JSON (via `python3 -c "import json..."`, `python3`/`jq` both confirmed present in this environment), has the same top-level key set as `bob-companion`'s manifest, has a non-empty `name` different from `"bob-companion"`, and does not contain any of the three canonical skills' own description-opener text (proving no skill body content leaked into the manifest). (6) Ran the script against the real repo tree and committed the generated `claude/` output as its own commit, then re-ran the task's own Verification block and an independent `diff -r` per skill directory — both clean.

Confirmed scope discipline: `git diff --stat dev-agent...task/T-163-claude-packaging-target -- . ':(exclude)the-intern/email-skills'` is empty (nothing touched outside `the-intern/email-skills/`), and `git diff --stat ... -- the-intern/bob-companion` is empty (bob-companion untouched, satisfying AC-2's exclusion requirement literally, not just via the isolated test). Confirmed `the-intern/email-skills/claude/` is not caught by the root `.gitignore`'s unanchored `.claude` rule (that pattern matches a path component literally named `.claude`, not `claude` or `.claude-plugin`) — same as the already-tracked `bob-companion/claude/.claude-plugin/plugin.json` precedent.

Rejected: touching `README.md`'s package-layout section to document the new `claude/` target. T-153 updated `README.md` because it was explicitly listed in that task's `Files to Touch`; T-163's `Files to Touch` list does not include `README.md`, and no acceptance criterion needs it, so left it untouched rather than expanding scope on independent judgment — noting this here in case the reviewer or a follow-up task wants that documentation added deliberately.

Confirmed pre-existing, unrelated failures in `tests/test_the_intern_structure.sh` (flags `the-intern/email-skills` itself as an "unexpected top-level directory" — pre-dates this task), `tests/test_workflows.sh`, `tests/test_coding_guidelines.sh`, and `tests/test_roadmap.sh` are identical on `dev-agent` before this branch's changes (checked via a throwaway `git worktree add` against `dev-agent`), so nothing in this session introduced new breakage; out of this task's scope to fix. Also re-ran `test_package_pi_skills.sh` (T-153's suite) as a regression check — still 4/4 passing, untouched by this session.

Nothing remains for T-163's acceptance criteria. Files touched, all under `the-intern/email-skills/`: `package-claude-skills.sh` (new), `test_package_claude_skills.sh` (new, beyond the task's listed Files to Touch — justified above), `claude/.claude-plugin/plugin.json` (new, generated), `claude/skills/{himalaya,email-triage,worklog}/SKILL.md` + `references/**` (new, generated).

Obstacles Encountered:
- No `mise.toml` was present in this checkout despite CLAUDE.md describing one; `python3` (3.13.5) and `jq` (1.7) were both available directly on PATH and used only in the test suite (not the packaging script itself, which stays dependency-free bash matching the pi script's convention).
- The default `docs.claude.com`/`code.claude.com` pages are JS-rendered; used the documented `.md`-suffixed raw-markdown endpoints (`https://code.claude.com/docs/en/skills.md`, `.../plugins-reference.md`) to get plain-text doc content instead.
- Several of AC-2/AC-3's tests had no genuine red step available (the behavior they check was already true from the first minimal AC-1 implementation, since the Claude target needs no per-skill transformation unlike the pi target). Followed T-153's own documented precedent: wrote and kept the test for coverage, and explicitly noted the absence of a red step rather than silently skipping it.
- Deliberately did not update `README.md`'s package-layout section (unlike T-153, which had it in `Files to Touch`) since T-163's `Files to Touch` omits it and no AC needs it — flagged in case a reviewer or follow-up task wants it added.

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

**Claim verification 1 — Claude Code frontmatter needs no vendor-specific transformation:**
independently confirmed against Claude Code's own documentation, not just the
Developer's summary. Fetched `https://code.claude.com/docs/en/skills.md` and
`https://code.claude.com/docs/en/plugins-reference.md` directly.

- `skills.md`'s frontmatter reference table lists `name`, `description`, and
  `compatibility` as recognized SKILL.md fields, none required ("All fields
  are optional. Only `description` is recommended so Claude knows when to use
  the skill."). `compatibility` is documented as "Environment requirements
  for the skill... Claude Code accepts the field but doesn't act on it" —
  exactly the pass-through behavior the canonical `himalaya/SKILL.md`'s
  `compatibility` field needs. This is a real difference from the pi target:
  pi requires `allowed-tools` to be added (T-153), Claude Code does not
  require any field to be added.
- `plugins-reference.md` confirms the generated layout matches the documented
  plugin shape exactly: a `skills/<name>/SKILL.md` directory layout (`Skills`
  row, File locations reference table) and a `.claude-plugin/plugin.json`
  manifest where `name` is stated as "the only required field" (Required
  fields section). The generated `claude/.claude-plugin/plugin.json` supplies
  `name` plus the same optional metadata keys (`description`, `version`,
  `author`, `homepage`, `repository`, `license`, `keywords`) already used by
  `bob-companion/claude/.claude-plugin/plugin.json`, all of which are
  documented, recognized fields.
- Conclusion: the Developer's claim holds. A byte-for-byte `cp -r` with no
  frontmatter transformation is correct for this vendor, and no
  Claude-specific required field is missing.

**Claim verification 2 — `test_package_claude_skills.sh` not in Files to Touch:**
reasonable, not scope creep, for the same reason T-153's analogous addition
was accepted in that task's own review: the `tdd` skill's Output Format
requires "test files ... covering all acceptance criteria," the added file
tests only `package-claude-skills.sh` (a listed Files-to-Touch item), and it
adds no production behavior of its own. `package-claude-skills.sh` has real
control flow (regenerate-from-scratch, a plugin-manifest heredoc, a
missing-source error branch) that only a dedicated test file can exercise —
a diff-only verification check would not cover it.

**Stage 1 — Acceptance Criteria:**
- AC-1 (packaging script generates one `SKILL.md` per skill from
  `the-intern/email-skills/skills/`, Claude Code layout/conventions): met.
  Ran `./package-claude-skills.sh` against the real repo tree (via an
  isolated `git worktree`) — `claude/skills/{himalaya,email-triage,worklog}/SKILL.md`
  all present. `test_ac1_generates_expected_tree` covers this in an isolated
  `mktemp -d` copy; passed.
- AC-2 (output lives under a new `the-intern/email-skills/` location; no file
  under `the-intern/bob-companion/claude/` modified): met.
  `git diff --stat dev-agent...task/T-163-claude-packaging-target -- the-intern/bob-companion`
  is empty. Confirmed `the-intern/email-skills/claude/` is tracked and not
  matched by the root `.gitignore`'s unanchored `.claude` rule (the tracked
  directory is named `claude`, and its plugin metadata directory is named
  `.claude-plugin`, neither of which is a path component literally named
  `.claude`) via `git check-ignore -v` (exit 1, no match) and `git ls-files`.
  `test_ac2_does_not_modify_bob_companion_claude` independently proves this
  with a before/after `sha256sum` snapshot of an isolated copy of
  `bob-companion`; passed.
- AC-3 (output for all three skills, including full `references/` trees,
  byte-for-byte identical to canonical source): met. Ran the task's own
  Verification block (`./package-claude-skills.sh && test -f ... && diff -r
  skills/<name>/references claude/skills/<name>/references` for all three
  skills) against the real repo tree — clean, exit 0. Re-running the script
  against the already-committed output produced zero `git status` diff (no
  drift between committed output and what the script produces today).
  `test_ac3_output_byte_identical_to_canonical_source` and
  `test_ac3_regeneration_removes_stale_generated_files` (regen-from-scratch,
  proven via a planted stale file that is gone after re-run) both passed.
- AC-4 (Claude Code plugin manifest at
  `claude/.claude-plugin/plugin.json`, mirroring `bob-companion`'s manifest
  shape with this package's own name/description, no skill body content):
  met. Verified the committed manifest's top-level keys match
  `bob-companion/claude/.claude-plugin/plugin.json`'s exactly (`name`,
  `description`, `version`, `author`, `homepage`, `repository`, `license`,
  `keywords`), with `name: "email-skills"` and its own description.
  Manually confirmed no skill body content leaked — the manifest's
  description is generic package-level prose, not any skill's own
  description text. `test_ac4_plugin_manifest_present_and_shaped` also
  greps for each skill's description-opener text to guard this; passed.
- Files touched match "Files to Touch" plus the justified
  `test_package_claude_skills.sh` addition (see claim verification 2 above):
  `package-claude-skills.sh` (new), `claude/skills/{himalaya,email-triage,worklog}/SKILL.md`
  + `references/**` (new, generated), `claude/.claude-plugin/plugin.json`
  (new). No files outside `the-intern/email-skills/` touched
  (`git diff --stat dev-agent...task/T-163-claude-packaging-target -- . ':(exclude)the-intern/email-skills'`
  empty). `README.md` correctly left untouched — it is not in this task's
  Files to Touch and no AC needs it (unlike T-153, which had it listed).
  Dependencies `T-151`, `T-152`, `T-154`, `T-155` all confirmed completed
  before this task started.

**Stage 2 — Code Quality:**
- Correctness: `package-claude-skills.sh`'s logic is sound — `rm -rf` +
  `cp -r` per skill for regenerate-from-scratch (matching the AC-3
  regeneration requirement and T-153's precedent), a heredoc-owned plugin
  manifest carrying no skill content, `set -euo pipefail` throughout, and a
  clear missing-canonical-source guard that exits 1 with a stderr message.
- Tests: `test_package_claude_skills.sh`'s 5 tests all pass independently
  (`mktemp -d` `WORK_DIR`/`WORK_DIR2` with an `EXIT` trap cleanup) and
  deterministically; re-ran the suite directly (not just trusting the Work
  Log) — `Results: 5 passed, 0 failed`.
- Security: N/A — no secrets, no untrusted external input; the script only
  reads a fixed, repo-local canonical directory and writes to a fixed
  repo-local destination.
- Readability: names are descriptive (`canonical_dir`, `claude_skills_dir`,
  `plugin_manifest_dir`), comments explain non-obvious choices (regen-from-
  scratch rationale, manifest being script-owned static content), no dead
  code.
- Performance: N/A — small, bounded directory copies over three skill
  directories.
- Minor, non-blocking observation: the commit
  `feat(email-skills): generate Claude plugin manifest from packaging script`
  is 73 characters, one over the git-conventions skill's documented
  "≤ 72 chars total" for `<type>(<component>): <description>`. Trivial and
  not worth a review cycle on its own; worth keeping in mind for the next
  commit on this task or a future one.

Next owner: active Development Loop.
