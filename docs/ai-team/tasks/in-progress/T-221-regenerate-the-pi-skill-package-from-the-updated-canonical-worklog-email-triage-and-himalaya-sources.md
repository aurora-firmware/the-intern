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
build/embed step completes, since neither `T-214`'s `Done`-only
narrowing nor `T-218`'s discriminator is safe to ship alone.

## Dependencies

- `T-214` — the `Done`-only CLI/binary narrowing this task rebuilds and
  re-embeds against (AC-4, AC-5)
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

### Session 1 — 2026-09-21

Picked up T-221 with an empty Work Log (mandatory read-first step was a no-op). Read T-210's completed Work Log and Review Verdict as the declared precedent, plus B-054 (which the task's coordinator note explicitly defers to this task) and the current `package-pi-skills.sh` / `test_package_pi_skills.sh` scripts — unchanged since T-210, no script edits needed.

Established the red signal before touching anything: `diff -rq` between canonical `skills/{worklog,email-triage,himalaya}` and the tracked `.pi/skills/` copies showed all eight non-`tasks` reference/SKILL files differing, and a word-boundary `Left`/`Next`/`--left`/`--next` grep against the stale `.pi/skills/` trees found 15 matches (three-field `Done`/`Left`/`Next` worklog language, the four-flag `--item/--done/--left/--next` append call, and matching `Left:`/`Next:` framing baked into `email-triage/SKILL.md`'s worked examples) — confirming the packaged copy still taught the pre-T-217–T-220 shape even though canonical `skills/` was already clean of that language.

Ran `./package-pi-skills.sh` (exit 0) then `./test_package_pi_skills.sh` (5/5 pass, same AC labels as T-210, script unmodified). Independently verified the regeneration rather than trusting the guard test alone (it runs against an isolated `mktemp` copy of canonical source, not the tracked tree, so it can't detect drift on its own — same finding T-210 recorded): diffed every regenerated file against canonical, confirming each `SKILL.md` is identical to canonical once the single injected `allowed-tools: Read Bash` line is stripped, and every other file is byte-identical; file sets matched 1:1 in all three trees. Re-ran the banned-word grep post-regen — zero matches (AC-2). Confirmed `Message-ID` discriminator language survived into the packaged `email-triage/SKILL.md` and `references/worklog.md` (AC-5) — this was the task's own mechanical check that T-218's identifier fix reached the installable package, not just the canonical source. `git diff --stat` on `.pi/skills` touched exactly the 7 files expected from `skills/worklog`, `skills/email-triage`, and `skills/himalaya`'s rewritten content (`himalaya/SKILL.md` itself was unchanged by T-220, only `references/command-reference.md` — expected, since T-220 only rewrote the command reference), matching declared Files to Touch with nothing else touched. Committed as `chore(bob-skills): regenerate pi skill package from canonical worklog, email-triage, and himalaya sources` (`c4a03a3`).

Also explicitly re-ran B-054's own Fix Verification block (scoped to `worklog` only, its narrower banned-word list plus the "three field" phrase, and the SKILL.md-minus-allowed-tools diff against canonical) — both checks pass cleanly, confirming this task's regeneration closes the exact gap B-054 documents. Did not touch the bug file itself, per the bug's own coordinator note and the task instructions — that's left for the loop coordinator once this task is reviewed/merged.

For AC-4, rebuilt the embedding step: `cargo build -p bob` from `the-intern/service/` succeeded (`build.rs` walks `bob-skills/.pi/skills` at build time with no hand-maintained asset table, so no manual edit was needed — same mechanism T-210 traced), then `cargo test -p bob init_assets` passed all three tests, including the byte-comparison test that positively confirms the newly regenerated content is what got embedded. `git status --porcelain` stayed empty after the build/test run (`OUT_DIR` is gitignored).

Re-ran the task's full Verification block end-to-end a second time from the committed state to confirm idempotency (`package-pi-skills.sh && test_package_pi_skills.sh`, both grep checks, `git status --porcelain`) — no further changes, confirming the committed diff is genuine, unedited script output and the regeneration is stable.

Nothing was tried and rejected — this was a single straightforward regeneration cycle with no ambiguity, following T-210's precedent exactly. Nothing remains: all three packaged skill trees are byte-identical derivations of the now-current canonical `skills/` source (plus the one injected `allowed-tools` line per `SKILL.md`), the packaging script's own test suite passes unchanged, the `Left`/`Next` language B-054 flagged is gone from all three packaged trees (not just `worklog`), the `Message-ID` discriminator is present in the packaged `email-triage` skill, and the `bob` binary build embeds the new content with `init_assets` tests green.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
