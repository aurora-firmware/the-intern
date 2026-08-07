---
id: T-143
title: Rewrite the escalation reference free of internal identifiers and add the missing-config path
status: pending
priority: high
assigned-role: developer
created: '2026-08-07'
---

# Rewrite the escalation reference free of internal identifiers and add the missing-config path

## Description

`references/escalation.md` in the email-triage skill carries 13 ai-team
artifact identifiers and one paragraph of repository-packaging detail, and its
missing-configuration path hard-stops where it should degrade.

Skill consumers have no access to this project's specifications, decision
records, tasks, or bugs, so skill text must be intelligible without them. Remove
every such identifier (`S-0NN`, `T-NNN`, `B-0NN`, `ADR-0NN`, `CR-0NNN`).

**This is a rewrite, not a deletion.** Most references to the action-gate
specification are behaviourally load-bearing: they carry the rule that a tool
call denied by policy is recorded and never worked around. Replace the
identifier with behavioural language — "the action-authorization gate", "denied
by policy" — and keep the surrounding rule intact. Deleting the sentence
because it names a spec would remove the single most safety-relevant behaviour
in this package.

Do not add cross-references to project artifacts in their place. Where a
reference only served to justify a design choice to an internal reader, drop
the justification and keep the instruction.

Three changes to this one file:

1. **Scrub the 13 identifiers** per the rule above.
2. **Delete the repository-packaging paragraph** (currently the one stating
   which configuration file is committed versus templated and where the real
   file lives). The consuming agent cannot act on it; it belongs in the package
   README.
3. **Replace the "missing or malformed `manager_address`" hard stop.** The run
   must still escalate, addressed to the mail account's own configured address,
   which is obtained from the `From:` header on the first line of
   `himalaya template write` invoked with no arguments (documented in the
   `himalaya` skill's command reference). The escalation email must also state
   that the configuration file was missing and the directory where it was
   expected. If the account's own address cannot be determined either, record
   that in the worklog and take no further action on that message this run — do
   not hard-stop the run, do not guess an address, and do not fall back to
   acting on the message autonomously.

Do not state a worklog requirement for this case beyond the above: the worklog
skill's general journaling discipline covers it.

## Acceptance Criteria

AC-1: The system shall contain no ai-team artifact identifier in
      `references/escalation.md`.

AC-2: The system shall retain, in behavioural language, the rule that a tool
      call denied by the action-authorization gate is recorded and never
      worked around.

AC-3: The system shall omit any description of which configuration files are
      committed, templated, or excluded from the repository.

AC-4: IF the skill-local configuration file is missing, or its address is
      absent or malformed, THEN THE SYSTEM SHALL escalate to the account's own
      address obtained from `himalaya template write`, stating in the email
      that the configuration was missing and where it was expected.

AC-5: IF the account's own address cannot be determined THEN THE SYSTEM SHALL
      record that in the worklog and take no further action on that message,
      without hard-stopping the run or guessing an address.

## Dependencies

- None.

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/escalation.md` —
  identifier scrub, packaging-paragraph removal, missing-config escalation path

## Verification

```bash
cd the-intern/email-skills/.pi/skills/email-triage/references

# AC-1 — expect no output:
grep -nE '\b(S-0[0-9]{2}|T-[0-9]{3}|B-0[0-9]{2}|ADR-0[0-9]{2}|CR-0[0-9]{3})\b' escalation.md

# AC-2 — expect the denial rule to survive in behavioural form:
grep -niE 'denied|blocked|authorization gate' escalation.md

# AC-4/AC-5 — expect the degraded path and the undeterminable-address fallback:
grep -niE "template write|account's own|worklog" escalation.md
```

## Work Log

### Session 1 — 2026-08-07

Rewrote `the-intern/email-skills/.pi/skills/email-triage/references/escalation.md`
end to end, in three commits mapping to the task's three described changes, each
verified with the task's grep-based acceptance checks before and after.

**Identifier scrub (AC-1, AC-2).** Removed all 13 ai-team artifact identifiers
(`ADR-004` x2, the config citation, the design-principles citations x2, the
action-gate spec x5, and the exclusions citation — the last one landed in the
packaging-paragraph deletion below). Where an identifier only cited a spec or
ADR to justify a design choice to an internal reader, the citation was dropped
and the substantive instruction kept in plain prose. Where the identifier named
the action-authorization gate itself, the reference was rewritten in
behavioural language throughout: the heading "If the escalation send is blocked
(S-004)" became "If the escalation send is denied"; "gated by bob's existing
S-004 default-deny action gate" became "gated by the action-authorization gate,
which denies by default"; and the core safety rule — a denied tool call is
recorded and never worked around — was made explicit as its own sentence ("A
call denied by policy is recorded and never worked around") rather than left
implicit across the surrounding bullets, since this is the single most
safety-relevant behaviour in the package.

**Packaging paragraph deletion (AC-3).** Deleted the paragraph stating which
configuration file is committed versus templated and where the real file lives
— pure repository-packaging detail the consuming agent cannot act on. It also
happened to carry the last artifact identifier.

**Missing-config degrade path (AC-4, AC-5).** Replaced the "hard stop the run"
behaviour under `## If manager_address is missing or malformed` (renamed `## If
the escalation configuration is missing or malformed`) with: (1) escalate
anyway, addressed to the mail account's own address obtained from the `From:`
header on the first line of `himalaya template write` invoked with no
arguments, citing the `himalaya` skill's command reference for the output
shape; (2) state in that escalation email, in addition to the usual escalation
content, that the configuration file was missing (or its address malformed) and
the directory where it was expected (`<workspace>/config/`); (3) if the
account's own address cannot be determined either (`template write` fails or
has no usable `From:` header), record that in the worklog and take no further
action on that message this run — no hard stop, no guessed address, no
autonomous fallback action. Per the task's instruction not to over-specify a
worklog format for this case, the text says only "record the problem in the
worklog", relying on `worklog.md`'s general journaling discipline rather than
restating entry-format rules.

**Tried and rejected:** considered keeping "not something this reference or spec
grants" verbatim (dropping only the identifier) but simplified to "does not
grant", since the word "spec" without an identifier is still a dangling
reference to an artifact the skill consumer has no access to. Considered
leaving the closing sentence of the missing-config section as a literal "hard
stop" callout (matching the old prose structure) but rewrote it as a "fallback
path applies to every message this run" statement, since the new behaviour is
explicitly not a hard stop.

**Remaining:** nothing outstanding against this task's scope. `worklog.md` and
`SKILL.md` in the same skill package still carry action-gate identifiers, but
they are out of this task's Files to Touch and were left untouched (they are
covered by T-144 and T-145).

Commits on `task/T-143-rewrite-escalation-reference`:

- `5b754ca` docs(email-skills): scrub ai-team identifiers from escalation reference
- `159248d` docs(email-skills): drop repository-packaging paragraph from escalation reference
- `c6c514a` docs(email-skills): degrade to account address when escalation config is missing

### Session 2 — 2026-08-07

Addressed the sole Stage 2 finding from review cycle 1 (Stage 1 content review
was a full PASS and required no changes to `escalation.md`). Two of the three
commit subjects on `task/T-143-rewrite-escalation-reference` exceeded the
git-conventions 72-character limit for the full
`<type>(<component>): <description>` line.

Verified via `git ls-remote --heads origin task/T-143-rewrite-escalation-reference`
(empty output) and `git rev-parse @{u}` ("no upstream configured") that the
branch had never been pushed, confirming rewriting history in place was
permitted.

Tried the obvious approach first — `git rebase -i` against the base commit,
marking the two long-subject commits as `reword` — but this environment blocks
any git command with the `-i` flag, including `rebase -i`, even when scripted
non-interactively via `GIT_SEQUENCE_EDITOR`/`GIT_EDITOR`, since it is treated
as requiring interactive input that is not supported here. Rejected that path
and used an equivalent non-interactive sequence instead: `git reset --hard` to
the compliant base commit, then `git cherry-pick --no-commit` each of the two
non-compliant commits in original order, recommitting each with a shortened
subject and no other changes.

Old to new commit SHA mapping:

- `5b754ca` (`docs(email-skills): scrub ai-team identifiers from escalation reference`,
  71 chars) — unchanged, still `5b754ca`.
- `159248d` (`docs(email-skills): drop repository-packaging paragraph from escalation reference`,
  81 chars) → `349acf9` (`docs(email-skills): drop repository-packaging paragraph`,
  55 chars).
- `c6c514a` (`docs(email-skills): degrade to account address when escalation config is missing`,
  80 chars) → `eed3d48` (`docs(email-skills): degrade to account address on missing config`,
  64 chars).

Verified afterward: `git diff c6c514a HEAD` is empty and
`git rev-parse HEAD^{tree}` (`5451aa8fbcfaceb61c4e04f39ef699c8fff9014f`)
matches the pre-reword tip's tree hash exactly, confirming no file content
changed. All three commit subjects are now ≤72 chars (71, 55, 64). Confirmed
via `git log --stat dev-agent..HEAD` that each of the three commits touches
only `the-intern/email-skills/.pi/skills/email-triage/references/escalation.md`
— no task lifecycle file was touched on the task branch. The two original
over-length commit objects (`159248d`, `c6c514a`) remain reachable as dangling
objects in the local repo but are no longer on the branch tip; since nothing
was ever pushed, this has no shared-history impact.

Nothing remains for this task; ready for review cycle 2 (Stage 2 recheck only
— content/Stage 1 already passed and is unchanged).

## Review

### Review Verdict — 2026-08-07

FAIL

**Stage 1 — Acceptance criteria: all pass.**

Reviewed `the-intern/email-skills/.pi/skills/email-triage/references/escalation.md`
on `task/T-143-rewrite-escalation-reference` against `dev-agent`. Diff touches
exactly this one file (41 insertions, 42 deletions), matching Files to Touch.

- AC-1 (no ai-team artifact identifier): PASS. `grep -nE
  '\b(S-0[0-9]{2}|T-[0-9]{3}|B-0[0-9]{2}|ADR-0[0-9]{2}|CR-0[0-9]{3})\b'
  escalation.md` on the task-branch file produces no output. A broader
  `grep -niE 'ADR|S-0|T-1|B-0|CR-0|spec'` pass turns up only the substring
  "spec" inside "specific"/"classification"-adjacent prose — no artifact
  identifier survives.
- AC-2 (denial rule retained in behavioural language): PASS. "S-004" is
  replaced throughout with "the action-authorization gate" and the denial
  rule is stated as its own explicit sentence: "A call denied by policy is
  recorded and never worked around" (line 64). The heading and body under
  "If the escalation send is denied" preserve the full worklog/no-fallback
  rule.
- AC-3 (no repository-packaging description): PASS. The paragraph on which
  config file is committed vs. templated (`config/email-triage.example.toml`
  vs. the deployed-workspace copy) is deleted in full. A follow-up grep for
  `committed|example\.toml|repository|owner-only|deployed workspace|source
  of truth` on the new file returns nothing.
- AC-4 (degrade to account's own address on missing/malformed config): PASS.
  The rewritten "If the escalation configuration is missing or malformed"
  section escalates instead of hard-stopping, sources the address from "the
  `From:` header on the first line of `himalaya template write`, invoked
  with no arguments," and states in the escalation email that the config was
  missing/malformed and the expected directory (`<workspace>/config/`).
  Cross-checked against `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`
  lines 261-274: `template write` with no positional body/headers does print
  a `From:`-first template, consistent with what the reference now claims.
- AC-5 (undeterminable address → worklog + no further action, no hard stop,
  no guess): PASS. Covered verbatim by the paragraph starting "If the
  account's own address cannot be determined either... do not hard-stop the
  run and do not guess an address. Record the problem in the worklog and
  take no further action on that message this run." Matches the task's
  instruction not to over-specify a worklog format for this case.

No unspecified behaviour or cross-references to project artifacts were
added in place of the removed identifiers. Checked the four `references/categories/*.md`
files and `SKILL.md` that mention `escalation.md`/"blocked" — none link to
the file by heading anchor, so the heading renames ("If the escalation send
is blocked" → "...is denied", "If `manager_address` is missing or
malformed" → "If the escalation configuration is missing or malformed") do
not break any cross-reference; those other files are out of this task's
Files to Touch and were correctly left untouched.

**Stage 2 — Code quality: one failure.**

**FAIL — two of three commit messages exceed the git-conventions 72-character
limit.**

- **Where:** commits on `task/T-143-rewrite-escalation-reference` (`git log
  --format='%s' dev-agent..task/T-143-rewrite-escalation-reference`).
- **What is wrong:** `git-conventions` (`.claude/skills/git-conventions/SKILL.md`,
  "Commit Message Format") and `CLAUDE.md` ("Git model") both specify the
  full commit message (`<type>(<component>): <description>`) must be
  ≤ 72 chars total. Two of the three commits exceed that:
  - `159248d docs(email-skills): drop repository-packaging paragraph from escalation reference` — 81 chars.
  - `c6c514a docs(email-skills): degrade to account address when escalation config is missing` — 80 chars.
  The third, `5b754ca docs(email-skills): scrub ai-team identifiers from escalation reference`, is 71 chars and compliant.
- **What should change:** Shorten both subject lines to ≤ 72 chars total,
  e.g. `docs(email-skills): drop repository-packaging paragraph` and
  `docs(email-skills): degrade to account address on missing config`
  (illustrative — Developer's wording call). Neither commit has been pushed
  to a shared branch, so amending in place is fine per the "no amending
  pushed commits" rule; a rebase/`commit --amend` sequence on the task
  branch is sufficient. No content changes are needed — content review
  above is otherwise a full PASS.

**Minor observations (non-blocking):**

- The Work Log's "Tried and rejected" and per-change rationale sections are
  a good record of judgment calls (e.g. "does not grant" vs. keeping "not
  something this reference or spec grants" verbatim) — kept for reference,
  no action needed.
- `references/worklog.md` and `SKILL.md` in the same skill package still
  carry action-gate/spec identifiers; correctly left untouched as out of
  this task's scope (covered by T-144/T-145 per the Work Log).

### Review Verdict — 2026-08-07 (cycle 2)

PASS

**Scope of this cycle.** Cycle 1 was a full Stage 1 PASS with a single Stage 2
finding: two of the three commit subjects on
`task/T-143-rewrite-escalation-reference` exceeded the git-conventions
72-character limit. Session 2's Work Log describes a non-interactive
`reset --hard` + `cherry-pick --no-commit` + `commit -m` reword (`git rebase -i`
being blocked in this environment). Verified that fix independently, plus a
re-check of Stage 1 to the depth warranted by a claimed no-content-change
history rewrite.

**History-rewrite integrity — verified.**

- Commit SHA mapping matches the Work Log exactly: `git log --format='%H %s'
  dev-agent..task/T-143-rewrite-escalation-reference` shows `5b754ca`
  (unchanged), `349acf9` (was `159248d`), `eed3d48` (was `c6c514a`), in that
  order.
- Subject-line lengths, measured directly (`${#subj}` per commit): `5b754ca`
  71 chars, `349acf9` 55 chars, `eed3d48` 64 chars. All three ≤ 72 chars —
  the sole cycle-1 finding is resolved.
- Content identity: `git rev-parse task/T-143-rewrite-escalation-reference^{tree}`
  = `5451aa8fbcfaceb61c4e04f39ef699c8fff9014f`, matching the Work Log's
  claimed pre-reword tree hash exactly. `git diff c6c514a
  task/T-143-rewrite-escalation-reference` (old tip vs. new tip) is empty.
  Confirms no file content changed as a side effect of the reword — the tree
  is byte-identical to what cycle 1 reviewed.
- File scope: `git log --stat` on each of the three commits, and `git diff
  --name-only dev-agent...task/T-143-rewrite-escalation-reference` for the
  branch as a whole, touch only
  `the-intern/email-skills/.pi/skills/email-triage/references/escalation.md`.
  No task lifecycle file or other path was touched. Overall diff stat (41
  insertions, 42 deletions) matches cycle 1's recorded figure exactly, and a
  content hash of the full `dev-agent...tip` diff was taken for the record
  (`a5e7b98705c2438c8241cbc3867d63301bca86bb` via `git hash-object`).
- Shared-history safety: `git ls-remote --heads origin
  task/T-143-rewrite-escalation-reference` returns nothing and the branch has
  no configured upstream, confirming the branch was never pushed before the
  rewrite (rewriting in place was safe, matching the Work Log's own check).
  The two superseded commit objects (`159248d`, `c6c514a`) are no longer
  reachable from any local branch (`git branch --contains` returns empty for
  both) — no orphaned reference to the old subjects remains on the branch.

**Stage 1 re-confirmation.** Given the tree-hash equivalence above proves the
working-tree content is byte-for-byte what cycle 1 already reviewed line by
line, a full re-review was not warranted; re-ran the task's own
Verification block against the file as checked out from the new tip as an
independent spot check rather than relying solely on the hash match:

- AC-1: `grep -nE '\b(S-0[0-9]{2}|T-[0-9]{3}|B-0[0-9]{2}|ADR-0[0-9]{2}|CR-0[0-9]{3})\b' escalation.md` — no output. PASS.
- AC-2: `grep -niE 'denied|blocked|authorization gate' escalation.md` — the
  action-authorization-gate language and "A call denied by policy is
  recorded and never worked around" are present. PASS.
- AC-3: no repository-packaging paragraph present (confirmed by cycle 1;
  unaffected by the reword since it only touched commit messages). PASS.
- AC-4/AC-5: `grep -niE "template write|account's own|worklog" escalation.md`
  shows the `From:`-header-via-`himalaya template write` degrade path, the
  "record ... in the day's worklog" language, and the "cannot be determined
  either ... do not fall back" no-hard-stop/no-guess language all intact.
  PASS.

**Stage 2 — Code quality: no remaining failures.** The sole finding from
cycle 1 (commit-subject length) is resolved as shown above. No new Stage 2
issues identified: the reword touched only commit messages via a documented,
justified non-interactive procedure (with the standard `rebase -i` path
correctly ruled out and explained), and left tree content untouched.

**Minor observations (non-blocking):**

- The Work Log's documentation of the blocked `rebase -i` path, the
  alternative procedure used, and the exact SHA mapping is thorough and
  made this cycle's independent verification straightforward.
