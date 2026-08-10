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
