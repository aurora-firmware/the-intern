---
id: B-040
title: bob-companion Claude plugin skills omit the bob init workspace-bootstrap 
  step
severity: medium
status: resolved
created: '2026-08-15'
---

# bob-companion Claude plugin skills omit the bob init workspace-bootstrap step

## Summary

S-012 (`bob init`) shipped and its user-facing documentation (mdBook
quickstart and operator guide, via T-168) was updated accordingly, but the
`bob-companion/claude` Claude Code plugin — whose job is to teach Claude how
to drive bob correctly without a human pointing it at the mdBook docs — was
never updated. None of its four skills mention `bob init`. A Claude session
relying on this plugin to bootstrap or operate bob has no way to learn that
a workspace must be initialized before `bob serve`/`bob chat` are useful,
and no way to learn the command that does it.

## Reproduction Status

Status: confirmed

Evidence-backed status notes. Confirmed by inspecting the tracked plugin
files directly (`git ls-files the-intern/bob-companion`) and grepping for
`init` across the plugin tree, which returns zero matches.

## Evidence

- Logs / stack traces / failing assertions: n/a (documentation gap, not a runtime failure)
- Screenshots or recordings: n/a
- Failing command or test: `grep -rn "init" the-intern/bob-companion/claude/` returns no results
- First diagnostic step if not yet reproduced: n/a — already reproduced above

## Reproduction Steps

1. `grep -rn "init" the-intern/bob-companion/claude/` — zero hits.
2. Read `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` — the
   bootstrap walkthrough goes prerequisite → Rust toolchain → build →
   install extension → config file → local dev loop, and stops. It never
   describes creating/initializing a workspace.
3. Read `the-intern/bob-companion/claude/skills/bob-cli/SKILL.md` — the
   "Quick command map" table lists `status`, `sessions`, `audit`, `policy`,
   `schedule`, `chat`, `serve`, but omits `init`.

## Expected Behavior

The plugin's skills should cover `bob init` — at minimum, `bob-setup`
should mention that a workspace must be initialized with `bob init
<path>` before `bob serve`/`bob chat` are meaningful (linking or
summarizing what it creates), and `bob-cli`'s command map should list
`init` alongside the other subcommands.

## Actual Behavior

`bob init` is entirely unmentioned across all four skills
(`bob-setup`, `bob-cli`, `bob-health-check`, `bob-troubleshooting`) and
the plugin's own `README.md`.

## Environment

- OS / platform: n/a (documentation)
- Language / runtime version: n/a
- Relevant dependencies: n/a
- Branch / commit: main @ 75249d9 (post S-012/T-165–T-169 merge)

## Related

- Task: `T-168` (documented `bob init` for the mdBook docs, but not for bob-companion)
- Specification: `S-012-bob-init-workspace-scaffolding-subcommand.md`

## Suspected Area

`the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` and
`the-intern/bob-companion/claude/skills/bob-cli/SKILL.md`.

## Fix Verification

```bash
grep -n "bob init" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md
grep -n "init" the-intern/bob-companion/claude/skills/bob-cli/SKILL.md
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

### Diagnosis 1 — 2026-08-15
Reproduction status: Confirmed. `grep -rn "init" the-intern/bob-companion/claude/` returns zero
matches across all 8 tracked plugin files (plugin.json, README.md, and the SKILL.md +
references files for bob-setup, bob-cli, bob-health-check, bob-troubleshooting). Both Fix
Verification commands from the bug report also return no matches:
`grep -n "bob init" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` (exit 1) and
`grep -n "init" the-intern/bob-companion/claude/skills/bob-cli/SKILL.md` (exit 1).

Evidence captured:
- `git ls-files the-intern/bob-companion/claude/` — full file inventory.
- Read `bob-setup/SKILL.md` in full: numbered bootstrap walkthrough (1. pi prerequisite,
  2. Rust toolchain, 3. build, 4. install extension, 5. config file, 6. local dev loop,
  7. sandbox caveat) never covers workspace initialization or `bob init`.
- Read `bob-cli/SKILL.md` in full: intro subcommand list and "Quick command map" table both
  enumerate `serve, status, sessions, audit, policy, schedule, chat` but omit `init`.
- Read `bob-health-check/SKILL.md` and `bob-troubleshooting/SKILL.md` in full: neither
  mentions `init`.
- `grep -n "Init {" the-intern/service/crates/bob/src/cli/mod.rs` confirms `bob init <path>
  [--force]` is a real, tested subcommand (`Command::Init { path: String, force: bool }`,
  exercised by unit tests at lines 125 and 138 of that file).
- Read `the-intern/docs/src/quickstart/index.md` (lines 85-113): documents what `bob init`
  creates (`AGENTS.md`, `CLAUDE.md`, `config/email-triage.toml`, `worklog/`), that it writes
  the live `config.toml` at the platform default XDG/Application Support location, installs
  shared himalaya/email-triage/worklog skills once, and generates a permissive bootstrap
  policy that should be reviewed/narrowed before relying on it.
- `git status --short` on the bug branch is clean — no production files were changed to
  produce this evidence.

Isolated fault: Documentation-only gap in `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md`
(missing an `init` step before "6. Local dev loop") and
`the-intern/bob-companion/claude/skills/bob-cli/SKILL.md` (missing `init` from the intro
subcommand list and the "Quick command map" table). No source/runtime code is at fault —
`bob init` itself works correctly and is already covered in the mdBook docs (T-168); only the
Claude-facing plugin skills were never updated when S-012 shipped.

Root cause: Process gap, not a logic error. T-168 updated the mdBook user-facing docs for
`bob init` (S-012) but the `bob-companion/claude` plugin — a separate, purpose-built knowledge
package for Claude sessions driving bob without a human pointing them at the mdBook docs — was
out of that task's scope and was never updated in a follow-up. No later task closed that gap
until this bug was filed.

Planned verification (fix contract, to run after the tdd cycle):
```bash
grep -n "bob init" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md
grep -n "init" the-intern/bob-companion/claude/skills/bob-cli/SKILL.md
```
Both commands must return at least one match, and manual review must confirm `bob-setup`
explains that a workspace must be initialized with `bob init <path>` before `bob
serve`/`bob chat` are meaningful (summarizing what it creates, per the quickstart doc), and
that `bob-cli`'s command map/subcommand list includes `init` alongside the other subcommands.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-15

Implemented the fix contract from the Diagnosis Log: the `bob-companion/claude` plugin skills had zero mentions of `bob init` anywhere, even though `bob init` is the required first step to bootstrap a workspace (creating `AGENTS.md`, `CLAUDE.md`, `config/email-triage.toml`, `worklog/`, writing the live `config.toml`, and installing the shared skill package) before `bob serve`/`bob chat` mean anything against that workspace. This was a documentation-only gap left over from S-012/T-168, which updated the mdBook user-facing docs but never touched this plugin.

Confirmed the failing state first: `grep -rn "init" the-intern/bob-companion/claude/` returned no matches across all 8 tracked plugin files, and both Fix Verification commands from the bug report (`grep -n "bob init" .../bob-setup/SKILL.md` and `grep -n "init" .../bob-cli/SKILL.md`) exited 1.

Read the two authoritative sources named in the fix scope guidance — `the-intern/docs/src/quickstart/index.md` section "4. Initialize a workspace" and `the-intern/docs/src/operator-guide/index.md` section "Initialize a workspace with `bob init`" (around line 186) — and mirrored their content rather than re-deriving it from CLI source, so the plugin doesn't drift from the already-reviewed docs.

In `bob-setup/SKILL.md`, inserted a new numbered step "5. Initialize a workspace" right after the extension-install step (4) and before the config-file step, since a workspace needs to exist before the config file discussion is actionable; renumbered the two following sections (old 6 "Local dev loop" → 7, old 7 "Sandbox caveat" → 8) to keep the walkthrough sequential. The new section explains what `bob init <path>` creates, that it writes bob's live config.toml at the platform default path and installs the shared skill package (not a workspace-local `.pi/skills/` copy), that the generated config is a permissive bootstrap policy that should be reviewed/narrowed, and to set `manager_address` in the generated email-triage config before scheduling.

In `bob-cli/SKILL.md`, added `init` to the intro subcommand list (`bob` is a single binary with subcommands `init`, `serve`, `status`, ...) and added a "Bootstrap a new workspace" → `bob init <path>` row at the top of the "Quick command map" table, ahead of `bob status`, since bootstrapping logically precedes checking status.

Considered and rejected: touching `bob-health-check/SKILL.md`, `bob-troubleshooting/SKILL.md`, `references/command-reference.md`, or `plugin.json` — none needed a change to satisfy the fix contract, and the scope guidance explicitly said not to touch them without concrete necessity; found none.

No automated regression test was added. This repository has no test harness for Claude Code skill markdown content — these files are plain-text agent instructions consumed by Claude Code at skill-invocation time, not executable code exercised by `cargo test` or any other test runner in this repo. Verification is grep-based (confirmed failing before the fix, confirmed passing after) plus manual review of the added prose against the quickstart/operator-guide source of truth.

Verified after the edit: both `grep -n "bob init" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` and `grep -n "init" the-intern/bob-companion/claude/skills/bob-cli/SKILL.md` now return matches (lines 77/80 and 8/24 respectively). Committed as `2041159` (`docs(bob-companion): document bob init in setup and cli skills`) on `bug/B-040-bob-companion-claude-plugin-skills-omit-the-bob-init-workspace-bootstrap-step`. Nothing remains outstanding for this bug's scope.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-15
PASS

Stage 1 (bug criteria): Diagnosis Log entry (Diagnosis 1 — 2026-08-15) contains a complete
evidence chain — reproduction status (confirmed, with both Fix Verification greps re-run and
exit codes noted), evidence captured (file inventory, full reads of all four plugin skills,
confirmation `bob init` is a real tested subcommand, and a read of the quickstart doc), an
isolated fault (documentation-only gap in `bob-setup/SKILL.md` and `bob-cli/SKILL.md`), and a
root cause (process gap — T-168 updated the mdBook docs for S-012 but never touched the
`bob-companion/claude` plugin). The fix addresses exactly that isolated fault: `bob-setup`
gained a new numbered "5. Initialize a workspace" section (with the two following sections
renumbered 6→7, 7→8 to stay sequential) and `bob-cli` gained `init` in both the intro
subcommand list and the "Quick command map" table. Only the two named files were touched
(`git diff origin/dev-agent...bug/B-040-...` confirms this); no unrelated files or behavior
were changed.

Fix Verification: both commands from the bug file were re-run against the branch tip
(commit `2041159`) and pass —
`grep -n "bob init" the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` matches lines
77 and 80; `grep -n "init" the-intern/bob-companion/claude/skills/bob-cli/SKILL.md` matches
lines 8 and 24.

Content accuracy spot-check: compared the new `bob-setup` §5 prose and the `bob-cli` additions
against `the-intern/docs/src/quickstart/index.md` §"4. Initialize a workspace" (lines 78-113)
and `the-intern/docs/src/operator-guide/index.md` §"Initialize a workspace with `bob init`"
(lines 186-213). The plugin text mirrors both sources on every substantive point: the created
file/directory list (`AGENTS.md`, `CLAUDE.md`, `config/email-triage.toml`, `worklog/`), the
live `config.toml` being written at the platform default path rather than workspace-local, the
shared `himalaya`/`email-triage`/`worklog` skill package install (explicitly not a
workspace-local `.pi/skills/` copy), the permissive bootstrap policy description (`bash`,
`read`, `write`, `edit` allowed with everything else default-denied, needing review before
relying on it), and the reminder to set `manager_address` in the generated
`config/email-triage.toml` before scheduling. This confirms the Work Log's claim that the
content was mirrored from the already-reviewed doc sources rather than re-derived.

Regression test: none added. The Work Log's rationale — this repository has no test harness for
Claude Code skill markdown content (verified: no test/lint files under
`the-intern/bob-companion/`, and `.github/workflows/build.yml` has no step that touches
`bob-companion` or runs markdown linting) — holds up. Grep-based Fix Verification (confirmed
failing before the fix, passing after) plus the content spot-check above is the practical
equivalent here.

Stage 2 (code quality): the diff is minimal and scoped to the fix contract — no unrelated
refactoring, no changes to `bob-health-check`, `bob-troubleshooting`, `references/`, or
`plugin.json`, consistent with the Work Log's stated (and correct) decision to leave those
alone. Section renumbering in `bob-setup/SKILL.md` is internally consistent and the new §5's
cross-reference to "the config file section below" still resolves correctly to the renamed §6.
Prose is clear, uses the plugin's existing voice/format (numbered walkthrough steps,
command-map table rows), and introduces no dead links or broken markdown.

Both stages pass. No blocking issues found.
