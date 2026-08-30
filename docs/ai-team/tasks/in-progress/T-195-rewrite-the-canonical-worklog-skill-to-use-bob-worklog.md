---
id: T-195
title: Rewrite the canonical worklog skill to use bob worklog
status: pending
priority: medium
assigned-role: developer
created: '2026-08-30'
---

# Rewrite the canonical worklog skill to use bob worklog

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

Component 4: replace the `worklog` skill's raw-shell diary recipe with
instructions to call `bob worklog append` / `bob worklog list`. The command
is now the normative definition of the entry format and the owner of
first-run detection and reconciliation; the skill describes *when* to call
it and the item-identifier convention, and must not restate the format or
the reconciliation algorithm.

Rewrite these canonical (vendor-neutral) files under
`the-intern/bob-skills/skills/worklog/`:

- `SKILL.md` — the run shape becomes: call `bob worklog list` at the start
  of a run (it reconciles automatically) and `bob worklog append` once per
  item handled. Delete the "Determining whether this is the day's first
  executed run" section — the command does this. Keep "How an open item
  closes" as delegating to the consuming skill's policy. Rewrite "Tool
  usage": the skill's runtime surface is now `bash` invocations of
  `bob worklog append` / `bob worklog list` — no `read` of prior files, no
  `mkdir`/`>>`/`date`/`test`/`find`/`ls`. Also rewrite the frontmatter
  `description` (the skill's activation surface): it currently claims the
  skill "Defines where the diary lives, how to create what is missing, the
  per-item entry format, how to tell whether a run is the day's first
  executed run, how first-run reconciliation carries forward still-open
  items" — every one of those clauses moves to the command, matching
  `S-011`'s amended Responsibility row ("defers to the `bob worklog`
  command for entry format, first-run detection, and reconciliation").
  And rewrite the **Location** section so it states the *invoking* working
  directory **strictly**, with no upward search and no override (ADR-015) —
  the current "`<workspace>` is the run's own working directory" wording
  reads as compatible with an ancestor-searching resolver.
- `references/entry-format.md` — describe the entry shape the command
  writes (`## <HH:MM> — <item-identifier>` + `Done`/`Left`/`Next`) as
  reference only, explicitly deferring to `bob worklog` as the definition.
  Delete the `NOW=$(date +%H:%M)` / `mkdir -p worklog` / `cat >>
  worklog/$TODAY.md` recipe and all `<NOW>` placeholder guidance.
- `references/reconciliation.md` — state that `bob worklog` reconciles
  automatically and idempotently on every call against the nearest prior
  worklog file that exists, and reports today's carried-forward set. Remove
  the manual "walk `worklog/*.md` backward" procedure and the "most recent
  worklog file with open items" phrasing.

All three must stay free of this project's internal identifiers (S-011
constraint: no spec/task/bug/ADR numbers in shipped skill content).

Also update `the-intern/bob-skills/test_worklog_entry_format_timestamp.sh`:
it is a B-039 regression test asserting the now-deleted `date +%H:%M` /
`<NOW>` prose in `entry-format.md`. Replace its assertions with ones that
match the rewritten content (e.g. that `entry-format.md` instructs calling
`bob worklog append` and contains no raw `>> worklog/` redirect), or remove
the script if no meaningful file-level assertion remains — state which in
the Work Log.

Do **not** run the packaging script here — pi-package regeneration is
T-199, after the email-triage canonical edits (T-196) are also in.

## Acceptance Criteria

AC-1: The canonical `worklog` `SKILL.md` — its frontmatter `description`,
its Location section, and its body — shall instruct the reader to use
`bob worklog list` and `bob worklog append`, shall state cwd-strict
resolution of the worklog (no upward search, no override), and shall
contain no `mkdir`, `>>`, `date +%H:%M`, `test -f`, or `cat` shell recipe
for the worklog and no claim that the skill owns entry format, first-run
detection, or reconciliation.

AC-2: WHERE `references/entry-format.md` describes the entry shape THE
SYSTEM SHALL present it as derived from `bob worklog` and SHALL NOT contain
the `NOW=$(date +%H:%M)` recipe or the `<NOW>` placeholder guidance.

AC-3: The rewritten `references/reconciliation.md` shall state that
`bob worklog` performs reconciliation automatically against the nearest
prior worklog file that exists, and shall not instruct the reader to walk
`worklog/*.md` manually.

AC-4: IF any of the three rewritten files contains a project-internal
identifier (a spec, task, bug, or ADR number) THEN the task is not
complete.

AC-5: WHEN `test_worklog_entry_format_timestamp.sh` is run against the
rewritten files THE SYSTEM SHALL exit 0, whether by updated assertions or
by the script's removal being reflected in the verification step.

## Dependencies

- `T-193` — the `bob worklog append` / `list` surface the rewritten skill instructs callers to use must exist and be stable

## Files to Touch

- `the-intern/bob-skills/skills/worklog/SKILL.md` — rewrite to call the command
- `the-intern/bob-skills/skills/worklog/references/entry-format.md` — reference-only entry shape, recipe deleted
- `the-intern/bob-skills/skills/worklog/references/reconciliation.md` — automatic-reconciliation description, manual walk deleted
- `the-intern/bob-skills/test_worklog_entry_format_timestamp.sh` — updated to match, or removed

## Verification

```bash
cd the-intern/bob-skills
! test -f test_worklog_entry_format_timestamp.sh || ./test_worklog_entry_format_timestamp.sh
! grep -REn 'S-[0-9]{3}|T-[0-9]{3}|B-[0-9]{3}|ADR-[0-9]{3}|date \+%H:%M|mkdir -p worklog|>> worklog/' skills/worklog/
grep -RIl 'bob worklog' skills/worklog/
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-30

Read the (empty) Work Log on the canonical task file before starting; this is the first implementation session. Worked the task as three TDD cycles, assertion-first, one commit per cycle, on `task/T-195-rewrite-the-canonical-worklog-skill-to-use-bob-worklog`. Read S-015, ADR-015, the merged `bob worklog` implementation (`cli/commands/worklog.rs`, `worklog/store.rs`, `worklog/reconcile.rs`), the B-039 bug file, and `skills/tasks/SKILL.md` (as the precedent for a skill deferring to a `bob` command) for context.

Cycle 1 — `references/entry-format.md` + the B-039 script. Rewrote `test_worklog_entry_format_timestamp.sh` first (RED: 0/4 against the old recipe-based prose), then rewrote `entry-format.md` to GREEN (4/4). The file is now a reference-only description that states in its opening that it is "not the definition" and that `bob worklog` "is the sole definition of the format"; the `NOW=$(date +%H:%M)` / `mkdir -p worklog` / `cat >> worklog/$TODAY.md` heredoc recipe and every `<NOW>` transcription instruction are gone. The only fenced block that remains is a plain (non-`bash`) illustration of the `## <HH:MM> — <item-identifier>` + `Done`/`Left`/`Next` shape, plus a one-line `bob worklog append --item ... --done ... --left ... --next ...` call shape that points at `--help` for current syntax.

Cycle 2 — `references/reconciliation.md`. Wrote scratch AC-3 assertions (RED), then rewrote to GREEN. New "Reconciliation is automatic" section: both `bob worklog list` and `bob worklog append` reconcile today's file themselves on every call, against the nearest prior worklog file that *exists* (a fully-closed nearest file still counts and stops the search — no walk further back, no "most recent file with open items" filter), presence-tested so repeat calls the same day are idempotent, and every call reports today's full carried-forward set regardless of which call wrote it. Removed the manual "walk `worklog/*.md` from today backward" procedure entirely. Kept the domain-neutral "Open items are tracked in the worklog only" section verbatim and rewrote "How an open item closes" to describe the command's carry-forward instead of a hand-run reconciliation.

Cycle 3 — `SKILL.md`. Wrote scratch AC-1 assertions (RED), then rewrote to GREEN. Deleted the "Determining whether this is the day's first executed run" section. New run shape is three bullets: call `bob worklog list` at the start (it reconciles automatically and its output is the carried-forward set to act on), do the consuming skill's domain work, call `bob worklog append` once per item handled. "Tool usage" now names only `bash` running the two `bob worklog` subcommands and explicitly disclaims reading prior worklog files, creating the directory/file, and looking up the time/date — all of which the command does internally; it also notes one prefix-anchored allow-rule set admits the whole surface. "Location" now states cwd-strict resolution: exactly `<cwd>/worklog/<YYYY-MM-DD>.md`, "no search upward through parent directories", and "no flag, environment variable, or configuration key" override, with the wrong-directory case surfacing as a `bob worklog list` error rather than a foreign/empty diary. The frontmatter `description` and the body opening no longer claim the skill owns the diary location, creation of missing files, the entry format, first-run detection, or reconciliation — each is now a disclaimer attributing that ownership to `bob worklog` — while still keeping the skill's two real jobs (say WHEN to journal; teach the item-identifier convention) and its domain-policy disclaimer. Kept "How an open item closes" delegating to the consuming skill's policy.

B-039 script decision: kept and rewrote it rather than removing it. The original defect class (a hand-transcribed or placeholder timestamp) is now structurally impossible because `bob worklog` stamps every entry from its own clock, so the old extraction-based assertions had no recipe block left to inspect. The rewritten script keeps a meaningful file-level regression guard on `entry-format.md`: it must instruct calling `bob worklog append`, and must contain no `date +%H:%M` lookup, no `<NOW>` placeholder, and no `mkdir` / `>> worklog/` redirect — i.e. it must never drift back into a hand-run append recipe. Verified RED (4/4 fail) against the pre-rewrite file and GREEN against the rewrite.

Considered and rejected: removing the B-039 script (loses the "don't reintroduce a hand-run recipe" guard the task explicitly prefers keeping); adding assertions over `SKILL.md`/`reconciliation.md` to the same script (the script is named and scoped to the entry-format regression, and the task's Verification block already covers the other two files via the identifier/recipe grep and the `bob worklog` presence grep).

Verification: the task's three Verification lines all pass (B-039 script exit 0; forbidden-token grep finds nothing; `bob worklog` is referenced in all three files). Broad identifier scan over `skills/worklog/` is clean. `cargo test --workspace` from `the-intern/service/` passes with 0 failures — unaffected because `init_assets.rs` embeds the packaged `.pi/skills/` tree, which this task does not touch.

What remains: the packaged copy under `the-intern/bob-skills/.pi/skills/worklog/` is now intentionally out of sync with the canonical `skills/worklog/` files; regenerating it via the packaging script is T-199 (after T-196's email-triage canonical edits land), per this task's own instruction not to run packaging here. `test_package_pi_skills.sh` will report that drift until T-199 runs; it is not part of this task's Verification block and CI does not run it.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-30

PASS

Both review stages pass. Diff reviewed: `git diff dev-agent...task/T-195-rewrite-the-canonical-worklog-skill-to-use-bob-worklog` — exactly the 4 files named in Files to Touch (`skills/worklog/SKILL.md`, `skills/worklog/references/entry-format.md`, `skills/worklog/references/reconciliation.md`, `test_worklog_entry_format_timestamp.sh`), 3 commits, no Rust/`Cargo`/`.pi/` changes. `.pi/` drift and `test_package_pi_skills.sh` are out of scope (T-199) and were not assessed.

Stage 1 — acceptance criteria:
- AC-1 (met): `SKILL.md` frontmatter `description` now instructs `bob worklog list` at start and `bob worklog append` per item, and explicitly disclaims ownership of entry format, day-file location, first-run detection, and carry-forward ("the `bob worklog` command owns all of that"). The "Determining whether this is the day's first executed run" section is deleted. "Tool usage" lists only `bash` running the two subcommands and drops the `read`-prior-files surface. Location section states `<cwd>/worklog/<YYYY-MM-DD>.md` with "no search upward through parent directories" and "no flag, environment variable, or configuration key" override. No `mkdir`/`>>`/`date +%H:%M`/`test -f`/`cat` worklog recipe remains (targeted greps clean; the sole `date` token is the disclaimer "never looks up the time or the date itself").
- AC-2 (met): `references/entry-format.md` opens by stating it is "**not** the definition" and that `bob worklog` "is the sole definition of the format". No `NOW=$(date +%H:%M)` recipe and no `<NOW>` placeholder guidance (regression script asserts both).
- AC-3 (met): `references/reconciliation.md` "## Reconciliation is automatic" states both `bob worklog list` and `bob worklog append` reconcile today's file on every call against "the nearest prior worklog file that exists". The manual "walk `worklog/*.md` backward" procedure and the "most recent worklog file with open items" phrasing are gone (grep for walk/backward/`worklog/*.md` clean).
- AC-4 (met): no `S-NNN`/`T-NNN`/`B-NNN`/`ADR-NNN` in any of the three `.md` files (verification grep and a broader scan clean; only false positive is the word "specific").
- AC-5 (met): `test_worklog_entry_format_timestamp.sh` runs 4/4 PASS, exit 0. Work Log records the keep-and-rewrite decision; the script retains a meaningful guard (entry-format.md must instruct `bob worklog append` and must never reintroduce a `date +%H:%M` lookup, `<NOW>`, `mkdir -p worklog`, or `>> worklog/` redirect).

Verification block (run from `the-intern/bob-skills` on the task branch): all three lines pass — regression script exit 0; forbidden-token grep no matches; `bob worklog` referenced in all three `skills/worklog/` `.md` files. `cargo test --workspace` from `the-intern/service/`: 788 passed, 0 failed, exit 0 (unaffected — no Rust changed).

Stage 2 — content quality:
- Domain/vendor neutral: no email-triage or other consumer specifics (scan for email/triage/himalaya/imap/etc. clean); examples ("a specific reply arriving", "blocked by the action-authorization gate") stay generic.
- Consistent with `bob worklog` behaviour, cross-checked against `crates/bob/src/cli/commands/worklog.rs`, `worklog/reconcile.rs`, `worklog/store.rs`: entry shape matches `render_entry_block`; carried-forward `Left`/`Next` copied verbatim and `Done` naming the source file matches `carried_forward_done`; nearest-prior-existing-file source that stops at a fully-closed nearest file matches `nearest_prior_existing_date` and its tests; presence-tested idempotence and "reports today's carried-forward set regardless of which call wrote it" match `report_carried_forward`; `bob worklog list` erroring and never inventing `worklog/` matches `require_worklog_dir`; cwd-strict resolution matches `WorklogStore::new` and the module docs (ADR-015); timestamp from the command's own clock matches `Local::now()`.
- Reads as coherent skill guidance: the three-bullet run shape, the narrowed tool surface, and the two reference files marking themselves non-normative all hang together.

Minor observations (non-blocking, no fix required):
- `SKILL.md` run-shape bullet phrases the source as "the most recent prior day"; `reconciliation.md` then states the precise rule ("Do not assume the nearest prior file is yesterday's" / nearest file that exists). The two files are consistent read together.
- `SKILL.md` Location says a run in the wrong directory "gets an error from `bob worklog list` ... rather than a silently empty or foreign diary". True whenever the wrong directory has no `worklog/` (the common case); a wrong directory that itself contains a `worklog/` would be read rather than error. The load-bearing claims (cwd-strict, no upward search, no override, runs in different directories never share) are accurate.

Next owner: Development Loop.
