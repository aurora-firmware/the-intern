---
id: T-234
title: Make the manual pages readable as skill references
status: pending
priority: medium
assigned-role: developer
created: '2026-10-13'
---

# Make the manual pages readable as skill references

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

Make the hand-written manual pages read correctly as plain-markdown skill
references and list the five installed skills (CR-016 item 7; S-007 v0.2
Component 2; S-011 v0.3 "no internal artifacts").

The pages under `the-intern/docs/src/` are now also copied into the
`the-intern-docs` skill and read by an agent as plain markdown, where the
CLI-reference page does not exist (it is a stub populated at docs build
time and is not copied). Three links point at it: end-user guide (~line 11),
quickstart (~line 249), operator guide (~line 327). Reword each so it still
makes sense without that page — e.g. keep the link for the mdBook site but
also say "or run `bob <command> --help`". Confirm no page links to internal
project material (`project/docs/`, `docs/ai-team/`, specs, ADRs, task/bug
IDs); remove any such link found.

Also update the two hand-written lists of installed skills to name all five
(`himalaya`, `email-triage`, `worklog`, `tasks`, `the-intern-docs`):
quickstart ~lines 96–97 and operator guide ~line 193. Do not touch the
operator guide's upgrade / `--skills-only` / action-rule sections — T-237
owns those. mermaid blocks are fine. Follow
`docs/ai-team/docs/coding-guidelines-skills.md` §1–2.

`the-intern/docs/test_operator_guide_email_triage_trust.sh` already fails: it
asserts the internal IDs "B-035" and "T-150" appear in the operator guide
(~lines 84–87), which S-007 v0.2 now forbids. Drop those two assertions
(keep the rest) so the test passes again.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: Each manual sentence that links to the CLI reference shall also direct
      the reader to `bob --help` / `bob <command> --help`.
AC-2: The manual pages under `the-intern/docs/src/` (excluding the
      CLI-reference stub) shall contain no links to internal project
      material and no internal task/bug/spec/ADR/issue IDs.
AC-3: The quickstart and operator guide lists of installed skills shall name
      all five skills, including `the-intern-docs`.
AC-4: WHEN the docs are built THE SYSTEM SHALL build without errors.
AC-5: WHEN `test_operator_guide_email_triage_trust.sh` runs THE SYSTEM SHALL
      pass without asserting any internal ID.

## Dependencies

- None

## Files to Touch

- `the-intern/docs/src/end-user-guide/index.md` — CLI-reference link wording
- `the-intern/docs/src/quickstart/index.md` — CLI-reference link wording; five-skill list
- `the-intern/docs/src/operator-guide/index.md` — CLI-reference link wording (~line 327); five-skill list (~line 193)
- `the-intern/docs/test_operator_guide_email_triage_trust.sh` — drop the two internal-ID assertions

## Verification

```bash
mdbook build the-intern/docs
grep -n "cli-reference" the-intern/docs/src/end-user-guide/index.md the-intern/docs/src/quickstart/index.md the-intern/docs/src/operator-guide/index.md
grep -n "the-intern-docs" the-intern/docs/src/quickstart/index.md the-intern/docs/src/operator-guide/index.md
! grep -rnE "project/docs|docs/ai-team|\b(T|B|S|CR)-[0-9]{3}\b|ADR-[0-9]{3}" the-intern/docs/src --include=index.md
bash the-intern/docs/test_operator_guide_email_triage_trust.sh
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-10-14

I started with the failing `test_operator_guide_email_triage_trust.sh` (7 passed,
2 failed). The two failures were the "B-035" and "T-150" assertions, which
S-007 v0.2 now forbids. I removed them and the test went green (7 passed,
0 failed), and I committed that on its own.

Next I reworded the three links to the CLI-reference page. The end-user guide
and quickstart now add "or run `bob --help` / `bob <command> --help`". The
operator guide now also says to run `bob task --help` and
`bob task <subcommand> --help`, since its sentence is about the task board. I
kept the mdBook links so the site still works. I also updated the two
hand-written skill lists, in the quickstart and the operator guide, to name
`himalaya`, `email-triage`, `worklog`, `tasks`, and `the-intern-docs`. I did not
touch the operator guide's upgrade, `--skills-only` or action-rule sections.

The forbidden-pattern grep over the pages was already clean, and I found no
links to specs, ADRs or other internal material. The GitHub links in the
quickstart and operator guide are public product and `pi` links, so I left
them. I did not add a new test for the doc wording, because the task's
verification commands (grep and the shell test) already cover it. The test
script's own messages still say "S-004"; it is a test file, not shipped
content, so I left it.

Verification: `mdbook build the-intern/docs` clean (only the existing
mdbook-mermaid version-mismatch warning); forbidden-pattern grep empty;
`init_assets` 6/6 including the byte-identical drift test; full workspace suite
green via `./scripts/cargo-dev.sh`; no orphaned fixtures. Nothing is left to do.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-10-14
PASS

Stage 1: AC-1 met (all three CLI-reference links now also point to `bob --help` / `bob <command> --help`). AC-2 met (forbidden-pattern grep over all of `the-intern/docs/src` is empty; remaining links are public GitHub/pi.dev). AC-3 met (quickstart and operator guide name all five skills; upgrade/--skills-only/action-rule sections untouched). AC-4 met (`mdbook build` clean apart from the pre-existing mermaid version warning). AC-5 met (test script: 7 passed, 0 failed; B-035/T-150 assertions removed). Only the four listed files changed.
Stage 2: wording is clear, edits minimal, no dead code. `init_assets` drift test passes 6/6.

Non-blocking: the test script's own messages still mention "S-004" (not shipped content).
