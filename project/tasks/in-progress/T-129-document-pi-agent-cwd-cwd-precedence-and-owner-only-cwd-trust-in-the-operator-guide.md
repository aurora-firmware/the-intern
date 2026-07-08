---
id: T-129
title: Document pi_agent_cwd, --cwd, precedence, and owner-only cwd trust in the
  operator guide
status: pending
priority: medium
assigned-role: developer
created: '2026-07-05'
spec: S-007
---

# Document pi_agent_cwd, --cwd, precedence, and owner-only cwd trust in the operator guide

## Description

Document the CR-005 working-directory feature in the operator guide
(`the-intern/docs/src/operator-guide/index.md`). Cover: the service-wide
`pi_agent_cwd` config key (absolute-only, default = inherit launch cwd); the
per-entry `--cwd` flag on `bob schedule add` and its appearance in `bob schedule
list`; the precedence rule (per-entry `cwd` → `pi_agent_cwd` → inherited); that
`bob chat` uses its invocation cwd and ignores `pi_agent_cwd`; and the trust
guidance — the scheduled cwd is trusted and un-checked, pi auto-loads
`AGENTS.md`/`CLAUDE.md` and skills from it, so operators must keep it owner-only
like `schedules.json` (filesystem permissions are the gate). The mdBook must
build cleanly.

## Acceptance Criteria

AC-1: The operator guide shall document the `pi_agent_cwd` config key, the `--cwd`
      schedule flag, and the per-entry → service-wide → inherited precedence rule.
AC-2: The operator guide shall state that the scheduled working directory is
      trusted and un-checked and that operators must keep it owner-only because pi
      loads context files and skills from it.
AC-3: WHEN the user-docs mdBook is built THE SYSTEM SHALL build without errors
      including the new content.

## Dependencies

- `T-119` — `pi_agent_cwd` config key (behaviour to document)
- `T-125` — `--cwd` CLI flag and list rendering (behaviour to document)

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — schedule + configuration + trust
  guidance for the working-directory feature

## Verification

```bash
mdbook build the-intern/docs
```

## Work Log

### Session 1 — 2026-07-08

Read the (empty) Work Log first, then read the task file, its two dependencies
(T-119, T-125, both completed), and the full CR-005 change-request chain
(CR-005, CR-005-amendment-drafts.md, S-002, S-009, ADR-012) to ground every
claim in the approved, applied spec text rather than guessing at wording.
Cross-checked the exact shipped mechanics against source: `BobConfig.pi_agent_cwd`
and its absolute-path validation (`crates/bob/src/config.rs`), the
per-entry→service-wide→inherited precedence implemented in
`crates/bob/src/serve.rs::resolve_periodic_cwd` (T-127), and the `--cwd` CLI
flag / `validate_cwd` / `write_human_schedule` cwd rendering in
`crates/bob/src/cli/{mod.rs,commands/schedule.rs}` (T-125), to make sure every
command example, flag table row, and rendered-output sample in the guide
matches the real behavior exactly (field order, "cwd: <path>" suffix format,
etc.) rather than being invented.

While verifying the "`bob chat` ignores `pi_agent_cwd`" claim from the task
description, traced the full `bob chat` → `session.interactive.open` →
`InteractiveProcess::spawn` path end-to-end
(`crates/bob/src/cli/commands/chat.rs`, `crates/admin-rpc/src/lib.rs`,
`crates/pi-agent-supervisor/src/process.rs`) and found the approved CR-005
amendment's companion claim — "`bob chat` uses its invocation cwd" — does not
hold: the client's `session.interactive.open` request sends empty params, and
`InteractiveProcessConfig`/`InteractiveSessionConfig` have no cwd field at
all, so `InteractiveProcess::spawn` never calls `current_dir` and the
interactive session simply inherits whatever cwd the long-running `bob serve`
process itself has — not the directory `bob chat` was typed from. This is a
genuine implementation gap relative to the approved spec (no task among
T-118–T-130 ever wired this; CR-005's resolution recorded it as "(no
change)," i.e. assumed already correct). Filed this as bug B-021 via the
`new-bug` skill (medium severity, `--task T-129`), with full file/line
evidence and a suggested fix-verification test mirroring the existing
`spawn_sets_current_dir_on_child_when_worker_cwd_is_configured` pattern, then
documented the operator guide using the verified-true behavior ("`bob chat`
always inherits `bob serve`'s own launch cwd, ignoring `pi_agent_cwd`")
instead of repeating the unverifiable spec claim.

Made two commits on `task/T-129-document-pi-agent-cwd-precedence-in-operator-guide`:
1. `docs(operator-guide): document pi_agent_cwd cwd precedence and trust` —
   all content changes to `the-intern/docs/src/operator-guide/index.md`: the
   new "Working directory for pi-agent sessions" section (AC-1: `pi_agent_cwd`
   key, precedence rule, `bob chat` clarification), the `cwd` schedule-entry
   field/JSON example, the `--cwd` flag and its behavior, `bob schedule list`
   cwd rendering (rest of AC-1), and the expanded Security callout stating the
   scheduled cwd is trusted/un-checked and must be kept owner-only like
   `schedules.json` because pi auto-loads `AGENTS.md`/`CLAUDE.md`/skills from
   it (AC-2). Followed the T-112 precedent (the closest prior "document a
   scheduler feature in the operator guide" task) of landing all related
   acceptance criteria for a docs-only task in one cohesive commit rather than
   forcing artificial per-AC commit boundaries on a single prose file.
2. `chore(bugs): file B-021 bob chat cwd discrepancy` — the new out-of-scope
   bug report described above. Note: this bug-report file was committed on
   the task branch by necessity (Developer never commits to `dev-agent`
   directly per git-conventions); the Development Loop re-committed the
   identical file directly onto `dev-agent` (commit `39f0bbf`) so it is
   canonical there ahead of T-129's own merge, per the "task and bug files
   are canonical on dev-agent" rule.

Verified AC-3 by running `mdbook build` from `the-intern/docs` against a
freshly-removed `book/` output directory — succeeds with only the
pre-existing, unrelated mdbook-mermaid version warning (same warning T-112's
review noted as not an error). Also independently ran the CI's "Reject
internal project doc links" grep check (`grep -RInE 'project/(decisions|docs|specs)' src`)
against `the-intern/docs/src` — clean; all ADR/CR references in the new
content are by name only (matching the guide's existing style for
ADR-006/ADR-011/ADR-012), never as links into `project/`.

What remains: nothing within T-129's scope. All three acceptance criteria are
met and the mdBook builds cleanly. B-021 is filed and open for the Bug-Fix
Loop to pick up separately; it does not block T-129 since the operator guide
documents the actually-shipped behavior accurately regardless of how/whether
B-021 is eventually resolved.

**Obstacles Encountered:** The approved CR-005/S-002 spec text claims `bob
chat` "uses its invocation cwd," but this is not implemented anywhere in the
shipped code (verified end-to-end: the client sends no cwd in its RPC
request, and neither `InteractiveSessionConfig` nor `InteractiveProcessConfig`
carries a cwd field, so the interactive `pi` child is spawned with no
`current_dir` override and simply inherits `bob serve`'s own launch cwd).
Fixing this was out of scope for a docs-only task, so it was filed as bug
B-021 and the guide documents the verified-accurate behavior instead of
repeating the unverifiable spec claim, rather than silently fabricating a
false statement in an operator-facing document.

## Review

### Review Verdict — 2026-07-08

PASS

**Stage 1 — Acceptance Criteria**

- AC-1 (pi_agent_cwd, `--cwd`, precedence documented): Met. Verified every
  documented mechanic against the shipped source rather than trusting the
  diff's prose alone:
  - `pi_agent_cwd`: absolute-only validation and unset-by-default/inherit
    behavior match `crates/bob/src/config.rs` (`pi_agent_cwd.is_absolute()`
    check, `pi_agent_cwd: None` default, existence-not-checked-at-load
    covered by the `loads_successfully_when_pi_agent_cwd_names_a_nonexistent_directory`
    test).
  - Precedence (per-entry → service-wide → inherited): matches
    `crates/bob/src/serve.rs::resolve_periodic_cwd` and
    `start_periodic_dispatcher`'s `default_worker_cwd.or_else(std::env::current_dir)`
    fallback exactly.
  - `--cwd` flag: matches `crates/bob/src/cli/commands/schedule.rs`
    (`validate_cwd` absolute-path-only check, not-required-to-exist-at-add-time
    comment, `cwd` key added to params only when given). `bob schedule list`
    human/JSON rendering (`cwd: <path>` suffix, omitted when absent) matches
    `schedule_list_human_output_{includes,omits}_cwd...` and
    `schedule_list_json_output_includes_cwd_field_when_entry_has_one`.
- AC-2 (trust/owner-only guidance): Met. The expanded Security callout states
  the scheduled `cwd` is read with no ownership/permission check, is an
  injection path via auto-loaded `AGENTS.md`/`CLAUDE.md`/skills, and must be
  kept owner-only like `schedules.json`, with filesystem permissions as the
  gate — matches the task description's guidance verbatim in substance.
- AC-3 (mdBook builds cleanly): Met. Independently reran in a separate
  worktree (`BOB_BIN=<debug bob> mdbook build the-intern/docs` after `rm -rf
  book`) — builds cleanly with only the pre-existing mdbook-mermaid version
  warning (0.4.36 vs 0.4.52), no errors. Also independently reran the CI
  "reject internal project doc links" grep
  (`grep -RInE 'project/(decisions|docs|specs)' src`) against `the-intern/docs/src`
  from the task branch — clean, matching the Work Log's claim.
- Unspecified behavior / scope: The Developer substituted the verified-true
  "`bob chat` always inherits `bob serve`'s own launch cwd" for the task
  description's unverifiable "`bob chat` uses its invocation cwd" claim, and
  filed the discrepancy as B-021. Assessed as a reasonable, well-justified
  judgment call, not a deviation that should fail review: (1) AC-1's literal
  wording only requires documenting `pi_agent_cwd`, `--cwd`, and the
  precedence rule — it does not itself assert the `bob chat` claim; the task
  Description text repeating the CR-005/S-002 claim is not independently
  verified spec text, and CR-005's own resolution recorded it as "(no
  change)" (assumed pre-existing, never implemented by any task); (2) traced
  end-to-end and confirmed the claim is false in shipped code —
  `chat.rs` sends `"params": {}` with no cwd, `InteractiveSessionConfig` and
  `InteractiveProcessConfig` have no cwd field, and `InteractiveProcess::spawn`
  never calls `current_dir` (contrast with `RpcWorkerProcess::spawn`, which
  does); (3) this fact is directly security-relevant (it governs where pi
  auto-loads `AGENTS.md`/`CLAUDE.md`/skills from for interactive sessions,
  immediately adjacent to AC-2's trust guidance), so documenting the
  spec's false claim in an operator-facing doc would have been actively
  misleading rather than merely imprecise; (4) the fix itself was correctly
  kept out of scope and filed as B-021 with a complete evidence chain
  (confirmed reproduction status, file/line evidence, expected/actual,
  suggested fix-verification test) rather than silently expanding T-129 into
  a code change.
- Files touched: only `the-intern/docs/src/operator-guide/index.md` (in
  `Files to Touch`) and the new `project/bugs/open/B-021-...md` (expected,
  out-of-scope bug filing per the Work Log; confirmed identical between the
  task branch and `dev-agent`'s already-canonical `39f0bbf` — no net diff, as
  expected).

**Stage 2 — Code Quality**

- Correctness: every command example, flag-table row, and rendered-output
  sample checked against source (see above) — all accurate.
- Tests: N/A for a docs-only task; AC-3's mdBook build serves as the
  verification and was independently reproduced.
- Security: the expanded Security callout is accurate and consistent with
  the existing ADR-012 trust-boundary language already in the guide.
- Readability: new "Working directory for pi-agent sessions" section is
  well-organized, correctly placed, and its `#scheduled-jobs` cross-reference
  resolves (confirmed via the clean mdBook build, which fails on broken
  intra-book links).
- Performance: N/A (docs-only).

No blocking issues found. Minor, non-blocking observation: a couple of the
edited Markdown tables (Schedule Entry Fields, `bob schedule add` Flags) have
slightly inconsistent pipe-column alignment in the raw source; this is
cosmetic only and does not affect mdBook's rendered output.
