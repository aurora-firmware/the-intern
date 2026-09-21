---
id: T-214
title: Narrow bob worklog's entry storage and same-day duplicate check to Done 
  only
status: pending
priority: high
assigned-role: developer
created: '2026-09-21'
---

# Narrow bob worklog's entry storage and same-day duplicate check to Done only

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

`S-015` (amended by `CR-014`, v0.6) narrows the worklog entry format from
`Done`/`Left`/`Next` to `Done` alone, and narrows same-day duplicate
suppression to compare `Done` only. `crates/bob/src/worklog/store.rs`'s
`WorklogEntry`/`RecordedEntry` structs, its entry-writing `format!`, and its
`- Left:`/`- Next:` line parsing drop those two fields;
`crates/bob/src/worklog/reconcile.rs`'s `is_same_day_duplicate` compares
`Done` alone. A day's file already holding entries written under the prior
three-bullet shape must still parse for its header and `Done` (the parser
already defaults an absent bullet to empty, per its existing lenient
design); its `Left`/`Next` lines are neither read nor rewritten, and stay in
the file untouched.

The same change removes `--left`/`--next` from `WorklogCommand::Append`'s
clap definition and doc comments (`cli/mod.rs`), from the `worklog_append`
facade (`cli/commands.rs`), from `DispatchRuntime::worklog_append` and both
its `ProductionRuntime` and test `FakeRuntime` implementations (`lib.rs`),
and from `WorklogEntryOutput`/`AppendedEntryOutput` and the text renderer
(`cli/commands/worklog.rs`); `crates/bob/tests/non_serve.rs`'s worklog block
is rewritten to the `--item`/`--done` shape, keeping its fresh-directory-
creation and missing-`worklog/`-directory coverage as-is and dropping only
their `Left`/`Next` assertions. This is one task, not the originally planned
three (`T-215`/`T-216`, retired into this one), because these are every file
in the workspace naming `WorklogEntry`/`RecordedEntry`/`worklog_append`:
removing two struct fields invalidates all of their call sites
simultaneously, and Rust's whole-crate compilation means no smaller split
compiles on its own — confirmed during implementation (Architect escalation
review, 2026-09-21).

This task and `T-218` (the matching `email-triage` skill-content change,
adding a `Message-ID`-derived discriminator to the item-identifier) close
the same gap `CR-014`'s Architecture Consistency Review identified — this
narrowing must not be treated as safe to deploy on its own ahead of `T-218`,
since a caller still using the old non-unique identifier convention against
`Done`-only suppression can silently lose entries for two distinct messages
sharing a subject and sender. `T-221`, which depends on both this task and
`T-218`, mechanically checks that the corrected identifier reached the
packaged skill before the binary that embeds it is rebuilt.

## Acceptance Criteria

AC-1: WHEN append's same-day duplicate check runs for an item-identifier
whose most recent entry already in today's file has a `Done` value
identical (after the store's existing whitespace-trim rule, no
case-folding) to the incoming entry's `Done` THE SYSTEM SHALL write nothing.

AC-2: WHEN the incoming entry's `Done` differs from that item-identifier's
most recent entry in today's file, or today's file has no entry yet for
that item-identifier, THE SYSTEM SHALL append the incoming entry as a new
entry.

AC-3: The system shall write a new entry as a header line plus exactly one
`- Done: …` bullet with no `- Left:` or `- Next:` bullet, and shall not
include a `left` or `next` field in `bob worklog append` or `bob worklog
list` output in either text or JSON form.

AC-4: WHEN `bob worklog append` is invoked with `--left` or `--next` THE
SYSTEM SHALL exit non-zero with an unknown-argument error; WHEN invoked
with `--item` and `--done` alone THE SYSTEM SHALL accept the call.

AC-5: IF today's file holds an entry written under the prior three-bullet
shape THEN THE SYSTEM SHALL read that entry's header and `Done` value only,
and SHALL NOT modify its `Left`/`Next` lines.

## Dependencies

- None

## Files to Touch

- `the-intern/service/crates/bob/src/worklog/store.rs` — done (`bc4d976`) —
  narrow `WorklogEntry`/`RecordedEntry` to `Done` only; update the
  entry-writing format string and the day-file parser; update the module's
  own tests
- `the-intern/service/crates/bob/src/worklog/reconcile.rs` — done
  (`3df0da5`) — narrow `is_same_day_duplicate` to compare `Done` alone;
  update the module's own tests
- `the-intern/service/crates/bob/src/cli/mod.rs` — drop `--left`/`--next`
  from `WorklogCommand::Append`; update doc comments to the `--item`/
  `--done` shape; update the module's own tests
- `the-intern/service/crates/bob/src/cli/commands/worklog.rs` — drop
  `left`/`next` from `run_append`/`run_append_with_context` signatures,
  their `reject_entry_field` calls, and the `WorklogEntry` construction;
  drop the fields from `WorklogEntryOutput` and its
  `From<&RecordedEntry>` impl; drop the `- Left:`/`- Next:` lines from
  `write_worklog_day_text`; update the module's own tests
- `the-intern/service/crates/bob/src/cli/commands.rs` — drop `left`/`next`
  from the `worklog_append` facade
- `the-intern/service/crates/bob/src/lib.rs` — drop `left`/`next` from
  `DispatchRuntime::worklog_append` and both the `ProductionRuntime` and
  test `FakeRuntime` implementations; update the module's own tests
- `the-intern/service/crates/bob/tests/non_serve.rs` — rewrite the worklog
  block's invocations and assertions for the `Done`-only shape; add the
  unknown-argument-rejection test

## Verification

```bash
cd the-intern/service && cargo build -p bob && cargo test -p bob --lib worklog && cargo test -p bob --test non_serve worklog && cargo fmt --all -- --check
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-21

Read the task file's Work Log (empty — first session) and the AC/Description/Files-to-Touch/Verification sections. Also read the sibling pending task T-215 ("Update the bob worklog CLI layer to drop --left/--next"), since its description directly bears on T-214's scope boundary.

Implemented the narrowing in both in-scope files using TDD: for `store.rs`, first stripped `left`/`next` from the test module's `WorklogEntry`/`RecordedEntry` usages and confirmed a compile-time red (`E0063: missing fields left and next`), then narrowed the structs, the `render_entry_block` format string (single `- Done:` bullet), and `parse_entries` (silently skips any `- Left:`/`- Next:` line instead of storing it — satisfies AC-4's "read header and Done only, don't modify Left/Next" since `read_day` never writes back). Added two new tests: one confirming `read_day` correctly parses a hand-seeded legacy three-bullet day file down to header+Done, and one confirming `append` leaves an existing legacy entry's Left/Next lines byte-for-byte untouched when a new entry is appended after it. Committed as `bc4d976`.

For `reconcile.rs`, narrowed `is_same_day_duplicate` to compare only `.done.trim()`, dropped the two tests that specifically exercised Left/Next divergence (no longer meaningful once those fields don't exist), and kept/renamed the remaining tests (done-matches, no-entry-yet, done-differs, only-latest-entry-consulted, whitespace-but-not-case). Committed as `3df0da5`.

Then ran the task's Verification command and found the whole `bob` crate fails to compile: `crates/bob/src/cli/commands/worklog.rs` (not in T-214's Files to Touch) directly builds `WorklogEntry { ..., left, next }` and reads `RecordedEntry.left`/`.next` for its JSON/text output rendering. A workspace-wide grep confirmed this file is the *only* other consumer of these two types anywhere in `service/`. That file is explicitly T-215's target, and T-215 explicitly depends on T-214 — so this is a known, already-planned follow-on task, but its existence means T-214 alone cannot produce a crate that type-checks, which the task's own Verification command requires. I considered doing a minimal compensating patch to `cli/commands/worklog.rs` myself (just enough to compile, not the full flag-removal T-215 describes) but decided that's a scope call for the Architect, not something to decide unilaterally — it's exactly the "task can only be completed by modifying a file not listed under Files to Touch" boundary-violation condition the tdd skill flags for escalation without retries.

Also noted in passing: the Verification command as literally written (`cargo test -p bob worklog::store:: worklog::reconcile::`) isn't valid `cargo test` syntax — it only accepts one `TESTNAME` filter — so even absent the compile issue, it needs a wording fix.

Both commits are on the task branch and both files individually satisfy every AC in the code and are covered by tests; what remains is an Architect decision on how to resolve the cross-task compile coupling with T-215 before the Verification command can be run to green and this task can be handed to review.

**Escalated to the Architect** (dev-loop Phase 1 consultation). Resolution: fold `T-215` and `T-216` into this task — removing `left`/`next` from `WorklogEntry`/`RecordedEntry` is a single indivisible Rust compile unit spanning every file naming those types or `worklog_append`, so no smaller split compiles; this is a structural difference from the `CR-013`-era `T-202`/`T-203`/`T-204` split this task's breakdown was mirrored from, which never changed the struct's field set, only reconciliation behavior. Task amended on `dev-agent` accordingly (Files to Touch, ACs, Verification all updated); `T-215`/`T-216` retired.

### Session 2 — 2026-09-21

Picked up the coordinator's message resolving the prior escalation and re-read the amended canonical T-214 on `dev-agent` fresh, per instruction (did not rely on the stale pre-escalation copy). Confirmed the Architect's root-cause finding matches what I'd already isolated: removing `left`/`next` from `WorklogEntry`/`RecordedEntry` invalidates every call site across the same Rust compile unit, and no smaller split builds — hence T-215/T-216 folded into T-214, Files to Touch now lists all 7 files, ACs consolidated to 5 (new AC-3 covers output no longer carrying `left`/`next`; new AC-4 covers the CLI rejecting `--left`/`--next`), and the Verification command fixed to a sandbox-safe, syntactically valid form.

Worked through the remaining 5 files in the dependency order the Architect suggested. Since `cli/mod.rs` → `cli/commands/worklog.rs` → `cli/commands.rs` → `lib.rs` form one genuinely indivisible compile unit (confirmed again empirically — no partial state among these four compiles), I treated them as a single TDD cycle: updated every test in all four files first to the narrowed `--item`/`--done` shape (producing pattern-match/arity compile errors against the still-old production code — the practical form of "red" for a whole-unit struct/signature narrowing), then updated the production code in all four files together, then verified `cargo build -p bob` and `cargo test -p bob --lib worklog` both green (44/44 passing, including two new AC-4 tests confirming clap rejects `--left`/`--next` as unknown arguments, and one new AC-3 test confirming `bob worklog list`'s text and JSON output never carry `left`/`next`). Committed as `48fd157`.

For `tests/non_serve.rs` (a separate test-only compile unit — it doesn't gate `lib.rs`'s own compilation), I ran the *original* tests against the newly-narrowed binary first and got a genuine, non-trivial red: 4 of the original 6 worklog e2e tests failed with clap's `unexpected argument '--left' found`, which doubles as live end-to-end confirmation of AC-4's CLI-level behavior. I then rewrote those tests' invocations and assertions to the `Done`-only shape, added the explicit AC-4 unknown-argument-rejection e2e test the task calls for (checks both `--left` and `--next` individually, non-zero exit, stderr naming the flag, and that no `worklog/` directory gets created), and left the unrelated `write_prior_day_open_item` legacy-shape helper (used only by the AC-3 cross-day-non-leakage test, not part of this task's scope) untouched — its legacy 3-bullet content is still valid input regardless of the narrowing, and incidentally exercises AC-5's legacy-tolerance at the full-stack level. Ran `cargo test -p bob --test non_serve worklog`: 7/7 green. Committed as `e7c9ccf`.

Finished by running the complete amended Verification command end-to-end from a clean state (not just the individual pieces) — build, both scoped test invocations, and `cargo fmt --check` all passed with no leftover diffs. Did a final workspace-wide grep to confirm no seventh consumer of `WorklogEntry`/`RecordedEntry`/`worklog_append`/`WorklogCommand` exists outside the 7 files the amended task lists, and confirmed the task lifecycle file itself was never touched on this branch (all edits are source/test files only, matching the "canonical on dev-agent" rule). Nothing remains outstanding for T-214 itself; the only follow-up is the Architect's separately-flagged, out-of-scope `reconcile_today`/`ReconcileOutcome` dead-code bug, which is explicitly not mine to act on here.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-21

PASS

Reviewed against the amended (post-escalation) scope: Description, AC-1..AC-5,
the 7-file Files to Touch list, and the current Verification command — not
the original two-file scope.

**Stage 1 — Acceptance Criteria**

- AC-1 (identical `Done` on same item-identifier same day suppresses the
  write): met. `reconcile::is_same_day_duplicate` compares only
  `latest.done.trim() == candidate.done.trim()`; covered by
  `is_same_day_duplicate_is_true_when_done_matches_the_items_latest_entry`
  and the e2e
  `worklog_append_twice_the_same_day_with_identical_fields_suppresses_the_second_write`.
- AC-2 (differing `Done`, or no entry yet today, appends a new entry): met.
  Covered by `is_same_day_duplicate_is_false_when_done_differs`,
  `is_same_day_duplicate_is_false_when_the_item_has_no_entry_yet_today`, and
  the e2e `worklog_append_twice_the_same_day_with_a_different_done_value_keeps_both_entries`.
- AC-3 (header + exactly one `- Done:` bullet; no `left`/`next` in
  append/list output, text or JSON): met.
  `render_entry_block`/`write_worklog_day_text` emit only `- Done:`;
  `WorklogEntryOutput` and `AppendedEntryOutput` carry no `left`/`next`
  fields; confirmed by
  `worklog_list_output_never_includes_left_or_next_fields_in_text_or_json`
  and the non_serve e2e assertions (`content`/`stdout` checked for absence
  of `- Left:`/`- Next:`).
- AC-4 (`--left`/`--next` rejected non-zero as unknown arguments; `--item`
  plus `--done` alone accepted): met. `WorklogCommand::Append`'s clap
  definition no longer declares those fields, so clap itself rejects them;
  unit-level (`worklog_append_rejects_the_left_flag_as_an_unknown_argument`,
  ...`_next_...`) and e2e-level
  (`worklog_append_rejects_the_retired_left_and_next_flags_as_unknown_arguments`,
  asserting non-zero exit, stderr naming the flag, and no `worklog/`
  directory created) coverage both present.
- AC-5 (a legacy three-bullet day file's `Left`/`Next` lines read as absent,
  never modified): met. `store::parse_entries` silently skips any line that
  isn't `- Done:` (no `left`/`next` fields exist on `RecordedEntry` to write
  into), and `append` only ever appends a new block, never rewrites existing
  lines. Directly verified by
  `read_day_parses_a_legacy_three_bullet_entrys_header_and_done_only` and
  `append_does_not_modify_an_existing_legacy_entrys_left_and_next_lines`
  (byte-for-byte prefix assertion on the legacy content after an unrelated
  append).

No unspecified behavior was added. `git diff --stat` against `dev-agent`
touches exactly the 7 files listed under Files to Touch, no more, no fewer.
A repo-wide grep for `WorklogEntry`/`RecordedEntry` confirms no eighth
consumer was missed. The task's own Description/AC/Files-to-Touch/
Verification content matches `S-015` v0.6 (CR-014) verbatim on the
`--left`/`--next` unknown-argument behavior and the legacy-entry tolerance
clause — the amended scope is faithful to the approved spec, not an
invention of the escalation resolution.

**Stage 2 — Code Quality**

- Correctness: narrowing is consistent across storage, reconciliation, CLI
  parsing, dispatch, and rendering; legacy-shape tolerance is handled at the
  single parse site rather than defensively re-implemented per caller.
- Tests: ran the full amended Verification command from a clean checkout of
  the task branch:
  - `cargo build -p bob` — clean, no warnings.
  - `cargo test -p bob --lib worklog` — 44/44 passed.
  - `cargo test -p bob --test non_serve worklog` — 7/7 passed.
  - `cargo fmt --all -- --check` — clean (exit 0).
  Tests cover both success and failure paths (empty-field rejection,
  unknown-argument rejection, duplicate-suppression true/false, legacy-shape
  tolerance) and use per-test `tempdir()`s with no shared mutable state.
- Security: N/A — no secrets, no external network/DB input; existing
  `reject_entry_field` validation on `item`/`done` is preserved unchanged.
- Readability: names and the new `parse_entries` comment clearly state the
  legacy-line-is-skipped-not-stored design; no dead code or commented-out
  blocks introduced.
- Performance: no new loops, blocking calls, or resource leaks; parsing
  remains a single linear pass.

Not a bug fix, so the Bug Fix Addendum does not apply.

One minor, non-blocking observation, out of scope for this verdict: the
canonical task file's frontmatter still reads `status: pending` even though
the file lives under `tasks/in-progress/` (introduced by the `ade3329`
move-to-in-progress commit, which moved the file but didn't update the
field) — a lifecycle-tooling nit, not something introduced by this task's
diff, and the task file itself was correctly left untouched on the task
branch per the "canonical state lives on dev-agent" rule.

Both stages pass. Ready for integration.
