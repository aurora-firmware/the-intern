---
id: B-054
title: the .pi/skills/worklog packaged copy is stale after Done-only narrowing
severity: medium
status: resolved
created: '2026-09-21'
task: T-217
---

# the .pi/skills/worklog packaged copy is stale after Done-only narrowing

**Note (coordinator, 2026-09-21):** this is expected to be resolved as a
side effect of `T-221` ("Regenerate the pi skill package from the updated
canonical worklog, email-triage, and himalaya sources"), already pending in
the same `CR-014` task queue this bug was found during. `T-221` was
deliberately scoped to regenerate `.pi/skills/` once after `T-217`–`T-220`
all land, rather than once per canonical-content task, mirroring `T-210`'s
precedent for the equivalent `CR-013` regeneration. Leave this open until
`T-221` completes; do not start independent bug-fix work on it in the
meantime — re-running the packaging script before `T-218`/`T-219`/`T-220`
land would just need re-running again, and `T-221`'s own AC-1–AC-5 already
cover this bug's Fix Verification exactly. Close with a reference to
`T-221`'s merge commit once it lands, rather than filing a separate fix.

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

### Diagnosis 1 — 2026-09-21

Reproduction status: confirmed (see Reproduction Steps above).
Evidence captured: `diff`/`grep` showing `.pi/skills/worklog` still carrying
`Left`/`Next` language after canonical `skills/worklog` was narrowed by
`T-217`.
Isolated fault: `the-intern/bob-skills/.pi/skills/` is generated output,
regenerated only by an explicit run of `package-pi-skills.sh`; no task in
the `CR-014` series had yet re-run it.
Root cause: this is expected, planned staleness, not a defect in any
landed task — `T-221` was deliberately scoped (during spec-breakdown) to
regenerate `.pi/skills/` exactly once, after all four canonical-content
tasks (`T-217`–`T-220`) land, rather than once per task, mirroring `T-210`'s
precedent for the equivalent `CR-013` regeneration.
Planned verification: `T-221`'s own AC-1–AC-5, which are a superset of this
bug's Fix Verification block (covering `email-triage` and `himalaya` too,
not just `worklog`).

## Work Log

### Session 1 — 2026-09-21

No separate fix implemented for this bug — `T-221` (already queued in the
same task series this bug was found during) closed it as a direct
consequence of its own, independently-planned scope. Re-ran this bug's own
Fix Verification block against `dev-agent` after `T-221`'s merge (`696c3a3`,
"chore(tasks): merge T-221 regenerate pi skill package"): the banned-word
grep against the packaged `worklog` tree returns no output, and the
`SKILL.md`-minus-`allowed-tools` diff against canonical is empty. Both pass.
Closing without a dedicated bug-fix branch, per this bug's own
coordinator note recorded when it was filed.

## Review

Not routed through the bug-fix loop — closed administratively by the
Development Loop coordinator once `T-221` landed and this bug's own Fix
Verification block was independently re-confirmed passing against
`dev-agent`. No separate Reviewer verdict; `T-221`'s own Review Verdict
(in `docs/ai-team/tasks/completed/T-221-...md`) already covers the same
regenerated content, including this bug's exact concern (its Reviewer was
explicitly asked to re-run this bug's Fix Verification block and confirmed
it passing).
