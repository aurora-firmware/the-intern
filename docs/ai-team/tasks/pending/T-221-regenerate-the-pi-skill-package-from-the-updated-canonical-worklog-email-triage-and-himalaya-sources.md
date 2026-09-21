---
id: T-221
title: Regenerate the pi skill package from the updated canonical worklog, 
  email-triage, and himalaya sources
status: pending
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Regenerate the pi skill package from the updated canonical worklog, email-triage, and himalaya sources

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

`T-217`–`T-220` rewrite the canonical (`skills/`) worklog, email-triage,
and himalaya skill sources. The `.pi/skills/` tree is generated output
(`package-pi-skills.sh`); regenerate it so the packaged skills bob actually
installs match the rewritten canonical content, per `T-210`'s precedent for
the equivalent earlier change. Also rebuild `bob` so the freshly
regenerated package is re-embedded via the existing build wiring
(`build.rs` walks `bob-skills/.pi/skills` at build time; no hand-maintained
asset table to edit).

## Acceptance Criteria

AC-1: WHEN `package-pi-skills.sh` runs THE SYSTEM SHALL produce
`.pi/skills/worklog/`, `.pi/skills/email-triage/`, and
`.pi/skills/himalaya/` content byte-identical to the rewritten canonical
`skills/` source (`SKILL.md` files aside from the injected `allowed-tools`
line).

AC-2: The system shall not leave any generated file under these three
trees containing the word `Left` or `Next` (matched at a word boundary, so
both bullet form — `Left:`/`Next:` — and prose form — "`Done`, `Left`, and
`Next` values" — are caught), or the flags `--left`/`--next`.

AC-3: The system shall pass the package's own existing verification test
(`test_package_pi_skills.sh`) unchanged in shape, run against the
regenerated output.

AC-4: WHEN `cargo build -p bob` runs against the regenerated package THE
SYSTEM SHALL succeed and its `init_assets` tests SHALL pass, confirming the
new content is embedded.

AC-5: WHEN the regenerated `.pi/skills/email-triage/` content is inspected
THE SYSTEM SHALL state that the item-identifier includes a
`Message-ID`-derived discriminator — the mechanical check that `T-218`'s
identifier fix reached the packaged, installable skill before this task's
build/embed step completes, since neither `T-214`/`T-215`'s `Done`-only
narrowing nor `T-218`'s discriminator is safe to ship alone.

## Dependencies

- `T-217` — rewritten canonical `worklog` skill source
- `T-218` — rewritten canonical `email-triage` `SKILL.md`/`worklog.md`
- `T-219` — rewritten canonical `email-triage` `escalation.md`
- `T-220` — rewritten canonical `himalaya` command reference

## Files to Touch

- `the-intern/bob-skills/.pi/skills/worklog/` — regenerated, not
  hand-edited
- `the-intern/bob-skills/.pi/skills/email-triage/` — regenerated, not
  hand-edited
- `the-intern/bob-skills/.pi/skills/himalaya/` — regenerated, not
  hand-edited

## Verification

```bash
cd the-intern/bob-skills && ./package-pi-skills.sh && ./test_package_pi_skills.sh
grep -rn "\bLeft\b\|\bNext\b\|--left\|--next" .pi/skills/worklog .pi/skills/email-triage .pi/skills/himalaya
# expect no output from the grep
grep -n "Message-ID" .pi/skills/email-triage/SKILL.md .pi/skills/email-triage/references/worklog.md
# expect at least one match
cd ../service && cargo build -p bob && cargo test -p bob init_assets
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
