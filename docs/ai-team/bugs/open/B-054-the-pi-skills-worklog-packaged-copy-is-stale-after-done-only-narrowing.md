---
id: B-054
title: the .pi/skills/worklog packaged copy is stale after Done-only narrowing
severity: medium
status: open
created: '2026-09-21'
task: T-217
---

# the .pi/skills/worklog packaged copy is stale after Done-only narrowing

## Summary

`the-intern/bob-skills/.pi/skills/worklog/` is a generated packaging copy of
the canonical `the-intern/bob-skills/skills/worklog/` skill source, produced
by `the-intern/bob-skills/package-pi-skills.sh` and checked in separately
(see commit `cf01d24`, "regenerate pi skill package from canonical worklog
and email-triage sources"). `.pi/skills/` is pi's cwd-relative skill
discovery path — it is the copy an actual `pi` session reads at runtime, not
the canonical source. T-217 narrowed the canonical `skills/worklog/SKILL.md`,
`references/entry-format.md`, and `references/reconciliation.md` to
Done-only entries (per `CR-014`/`S-015`, v0.6), but T-217's scope was
limited to those three canonical files, so the packaged
`.pi/skills/worklog/` copy was never regenerated. Until
`package-pi-skills.sh` is re-run and its output committed, any `pi` session
that loads the worklog skill from `.pi/skills/worklog/` still gets the old
three-field `Done`/`Left`/`Next` entry shape and the four-flag
`--item/--done/--left/--next` append call, so the CR-014 narrowing has no
effect on real runs even after T-217 is reviewed and merged.

## Reproduction Status

Status: confirmed

`diff` between the canonical and packaged worklog skill trees shows the
packaged copy still contains `Left`/`Next` language that the canonical
source no longer has.

## Evidence

- Logs / stack traces / failing assertions: n/a (content staleness, not a
  crash)
- Screenshots or recordings: n/a
- Failing command or test:
  ```bash
  git -C /home/daneel/projects/the-intern diff --stat \
    the-intern/bob-skills/skills/worklog \
    the-intern/bob-skills/.pi/skills/worklog
  # non-empty diff after T-217 lands; .pi copy still has Left/Next and the
  # four-flag append call
  grep -rn "Left\|Next\|--left\|--next" \
    the-intern/bob-skills/.pi/skills/worklog
  # matches, even though the same grep against
  # the-intern/bob-skills/skills/worklog is clean
  ```
- First diagnostic step if not yet reproduced: n/a, already reproduced above

## Reproduction Steps

1. Land T-217's narrowing of `the-intern/bob-skills/skills/worklog/` to
   Done-only entries.
2. Run
   `grep -rn "Left\|Next\|--left\|--next" the-intern/bob-skills/.pi/skills/worklog`.
3. Observe that the packaged copy still matches — it was not regenerated
   from the updated canonical source.

## Expected Behavior

After the canonical `skills/worklog` source is narrowed to Done-only
entries, the packaged `.pi/skills/worklog` copy that `pi` actually loads at
runtime should also teach the Done-only shape, so a real `pi` session's
`bob worklog append` guidance matches the canonical skill.

## Actual Behavior

The packaged `.pi/skills/worklog` copy still teaches the pre-T-217
three-field `Done`/`Left`/`Next` entry shape and the four-flag
`--item/--done/--left/--next` append call, because T-217 only touched the
canonical `skills/worklog` source and the packaging script was not re-run.

## Environment

- OS / platform: Linux (dev sandbox); not platform-specific
- Language / runtime version: n/a (markdown skill content + bash packaging
  script)
- Relevant dependencies: `the-intern/bob-skills/package-pi-skills.sh`
- Branch / commit: `dev-agent`, after `task/T-217-...` merges

## Related

- Task: `T-217`
- Specification: `S-015` (`CR-014`, v0.6)

## Suspected Area

`the-intern/bob-skills/.pi/skills/worklog/` (generated packaging output);
fix is to re-run `the-intern/bob-skills/package-pi-skills.sh` and commit its
regenerated output, not to hand-edit the packaged copy.

## Fix Verification

```bash
cd the-intern/bob-skills && ./package-pi-skills.sh
grep -rn "Left\|Next\|--left\|--next\|three field" \
  the-intern/bob-skills/.pi/skills/worklog/SKILL.md \
  the-intern/bob-skills/.pi/skills/worklog/references/entry-format.md \
  the-intern/bob-skills/.pi/skills/worklog/references/reconciliation.md
# expect no output
diff <(grep -v '^allowed-tools: Read Bash$' the-intern/bob-skills/.pi/skills/worklog/SKILL.md) \
     the-intern/bob-skills/skills/worklog/SKILL.md
# expect no diff
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
