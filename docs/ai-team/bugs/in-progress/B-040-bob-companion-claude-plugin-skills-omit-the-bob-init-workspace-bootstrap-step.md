---
id: B-040
title: bob-companion Claude plugin skills omit the bob init workspace-bootstrap 
  step
severity: medium
status: in-progress
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
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
