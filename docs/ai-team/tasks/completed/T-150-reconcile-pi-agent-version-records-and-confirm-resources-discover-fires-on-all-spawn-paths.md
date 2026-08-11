---
id: T-150
title: Reconcile pi-agent version records and confirm resources_discover fires 
  on all spawn paths
status: completed
priority: high
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Reconcile pi-agent version records and confirm resources_discover fires on all spawn paths

## Description

S-011 Implementation Order Phase 1. Three pi-agent version records currently
disagree: the extension API version pinned and tested by
`the-intern/pi-extension/pi-agent-compat.test.ts` (0.75.3), the interactive
`pi` binary version verified for `bob chat` (0.79.10, T-103), and the
scheduled/periodic invocation path's verified version (0.65.2, T-139),
recorded in the root README's "pi-agent Version Compatibility" section.
Reconcile those three into one accurate record, and confirm against the
installed `pi` version that the extension's `resources_discover` event
actually fires during session initialisation on all three of bob's spawn
paths — pooled RPC worker, interactive chat (`bob chat`), and scheduled
periodic job — and that a path an extension contributes through it reaches
pi's system prompt before the first turn (per ADR-014). This is a
prerequisite for T-157–T-160, which build code against this event: if it
doesn't fire on one of the three paths today, that gap must be known before
those tasks start.

Critically, the scheduled-periodic probe must run from a working directory
that is **not** present in `~/.pi/agent/trust.json`. B-035 (resolved)
recorded that pi's non-interactive modes (`-p`, `--mode json`, `--mode rpc`)
silently ignore project-local resources from an untrusted cwd with no error
surfaced — if that same trust gate also applies to extension-contributed
`resources_discover` paths, S-011's core requirement fails on exactly the
scheduled path it depends on most, and this is the task that must catch it
before T-157–T-160 build against an assumption that doesn't hold.

Use a throwaway probe extension outside this repository's tree (the T-131
precedent, recorded in `the-intern/email-skills/README.md`) rather than
committing probe code. When rewriting the README compatibility section,
retain the literals `0.75.3` and `unsupported`/`compatibility error`
language that `the-intern/pi-extension/pi-agent-compat.test.ts` asserts
against — this task's own `npm test` verification will fail if that wording
regresses. No skill content changes; this is verification plus a README
update.

## Acceptance Criteria

AC-1: The system shall record, in the root README's "pi-agent Version
      Compatibility" section, a single reconciled pi-agent version (or
      documented per-path versions with a stated reason they still differ)
      that `resources_discover` was verified against.
AC-2: WHEN a probe extension registered for `resources_discover` runs a
      session through each of the three bob spawn paths (pooled RPC worker,
      interactive chat, scheduled periodic), with the scheduled-periodic
      probe run from a working directory absent from
      `~/.pi/agent/trust.json`, THE SYSTEM SHALL confirm the event fires on
      all three and record whether the contributed skill path reaches the
      system prompt under the untrusted-cwd condition, or THE SYSTEM SHALL
      document exactly which path(s) it does not fire on or does not reach
      the prompt from.
AC-3: IF `resources_discover` does not fire, or a contributed path does not
      reach the system prompt, on one or more of the three spawn paths
      (including the untrusted-cwd scheduled case) THEN THE SYSTEM SHALL
      record that gap in the README compatibility section and flag it as a
      blocker for T-157–T-160 before those tasks start.

## Dependencies

- None

## Files to Touch

- `README.md` — reconcile the three pi-agent version records into one, and
  record the resources_discover verification result

## Verification

```bash
grep -q "pi-agent Version Compatibility" README.md
grep -q "resources_discover" README.md
cd the-intern/pi-extension && npm test
```

The two greps are separate on purpose: the compatibility heading already
exists in `README.md` today, so a single alternation pattern
(`"resources_discover\|pi-agent Version Compatibility"`) passes before any
work is done. `resources_discover` appears nowhere in `README.md` today, so
requiring it separately is what actually gates AC-1–AC-3's recorded result
(Gate 2 verification correction, 2026-08-09).

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-10

Read the task file and its dependency chain (S-011 §"pi-agent version" Configuration Requirement, ADR-014, B-035 resolved, T-131's precedent in `the-intern/email-skills/README.md`) before writing anything. This task had no prior Work Log entries.

Confirmed the installed `pi` binary in this environment is `0.80.3` and that this environment has working model-provider credentials (unlike B-035's diagnosis sandbox), so live probing was possible rather than doc-inference-only.

Reconstructed each of bob's three spawn paths' exact `pi` invocation shape directly from the Rust source (not guessed): pooled RPC worker and scheduled-periodic both build `pi --mode rpc --extension <path>` (`pi-agent-supervisor/src/process.rs` `RpcWorkerProcess::spawn`, `pool.rs` `worker_process_config_for_session`/`_for_cwd_session`), differing only in the `current_dir` passed to the child (scheduled uses the schedule entry's `--cwd`, never trust-seeded, matching B-035's exact scenario); interactive chat builds `pi --extension <path>` with no `--mode` flag at all (`process.rs` `InteractiveProcess::spawn`, `serve.rs` `build_interactive_session_config`, confirmed via its own unit test asserting `args.is_empty()`). None of the three pass `--approve`/`-a`.

Built a throwaway probe extension (never committed, per the task's explicit instruction and the T-131 precedent) that registers `resources_discover` (logs firing + contributes a marker `skillPaths` entry) and `before_provider_request` (dumps the rebuilt system prompt so the marker skill's presence in `<available_skills>` can be checked). Iterated through two false leads before landing on a working test: (1) the extension factory must be a default export, not a named `activate` export — pi's loader error message named the exact requirement; (2) the first correctness check looked for the marker's SKILL.md *body* text in the system prompt and wrongly read as a negative — only a skill's frontmatter `name`/`description` appear in `<available_skills>` pre-first-turn, the body loads on demand via `read`, so the check was switched to the skill's registered name and confirmed with a `--skill` CLI-flag control run first (proving the marker skill itself was well-formed) before trusting the `resources_discover`-driven result.

Ran the probe extension through all three reconstructed spawn shapes: pooled-RPC-worker shape from `/home/daneel/projects/the-intern` (`--mode rpc`), scheduled-periodic shape from a freshly-created directory confirmed absent from `~/.pi/agent/trust.json` (`--mode rpc`, per the task's mandatory untrusted-cwd condition), and interactive-chat shape (`--extension <path>`, no `--mode`) driven through a real pty via a small Python `pty.spawn`-based driver script (bash tool has no real TTY) since `bob chat`'s ink TUI needs raw-mode terminal semantics. All three fired `resources_discover` (confirmed via stderr) and all three surfaced the contributed marker skill before the first turn — for the two `--mode rpc` runs via the `before_provider_request` event's `payload.instructions` containing `<skill><name>t150-probe-marker</name>...`, and for interactive chat via the rendered `[Skills] gh-cli, git-conventions, pr-review, t150-probe-marker` startup banner. Critically, the scheduled-periodic-shape run from the untrusted cwd still worked — extension-contributed `resources_discover` paths are evidently not subject to the same non-interactive project-trust gate that `B-035` found blocks `.pi/skills/`-based auto-discovery, so there is no gap to flag for T-157–T-160.

Updated the root `README.md`'s "pi-agent Version Compatibility" section: kept the extension-API pin at `0.75.3` unchanged (required verbatim by `pi-agent-compat.test.ts`'s literal/regex assertions) but explicitly reframed it as a compile-time API-surface pin, decoupled from the runtime CLI version; reconciled the two previously-disagreeing runtime records (interactive `0.79.10`/T-103, scheduled `0.65.2`/T-139) plus the previously-unrecorded pooled-RPC-worker path into one shared, revalidated record — `pi 0.80.3` — and recorded the `resources_discover`/system-prompt/untrusted-cwd verification result and its "no blocker" conclusion inline. Confirmed the AC-1 grep gate was red before the edit (`resources_discover` absent from README.md) and green after, then ran the full verification block (`npm test` in `the-intern/pi-extension`) green (38/38 tests). Single commit for the cycle, since all three ACs are satisfied by one cohesive edit backed by the probe evidence gathered beforehand: `a1ba007 docs(pi-agent): reconcile version records and verify resources_discover`.

While reconciling the version numbers, found that `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` duplicates the old interactive-pi number (`0.79.10`) directly in its own prose rather than only deferring to the root README, and is now stale relative to this task's reconciled `0.80.3` record. That file is outside this task's Files to Touch (`README.md` only), so rather than editing it, filed `B-038` (severity low) via the `new-bug` skill with full evidence and a fix-verification grep. The loop has committed that bug file to `dev-agent` (`cf19328 chore(bugs): file B-038 — stale interactive pi version in bob-setup skill`).

Nothing remains for this task's own scope: all three ACs are met and verified, the probe extension/skill artifacts are outside the repository tree and were never committed, and no other stale version references exist in tracked docs (checked `the-intern/email-skills/README.md`'s `0.65.2` mention separately — it's a historical validation note that already explicitly defers to the root README as canonical, so it was correctly left untouched).

Result: PASS

Summary:
- All three acceptance criteria met: reconciled the three disagreeing pi-agent version records into the root README's "pi-agent Version Compatibility" section (extension-API pin kept at 0.75.3 as compile-time-only, runtime CLI unified at 0.80.3 across all three bob spawn paths), and live-verified (with a throwaway, never-committed probe extension, against the actual reconstructed invocation shape of each spawn path) that `resources_discover` fires and a contributed skill path reaches the system prompt's `<available_skills>` on all three, including the mandatory untrusted-cwd scheduled-periodic case. No blocker found for T-157–T-160.

Artifacts:
- `README.md` — reconciled "pi-agent Version Compatibility" section (commit `a1ba007` on `task/T-150-reconcile-pi-agent-version-records`)
- `docs/ai-team/bugs/open/B-038-bob-setup-companion-skill-duplicates-a-now-stale-interactive-pi-version-number.md` — new bug report for an out-of-scope stale-doc defect discovered during this task; committed to `dev-agent`

Evidence:
- `grep -q "pi-agent Version Compatibility" README.md` → pass
- `grep -q "resources_discover" README.md` → red before edit, green after
- `cd the-intern/pi-extension && npm test` → 2 files, 38/38 tests passing (both before, unaffected, and after the edit)
- Live probe runs (this session, pi 0.80.3, real model credentials): pooled-RPC-worker shape (`pi --mode rpc --extension <probe>` from repo root) — `resources_discover` fired, marker skill present in `before_provider_request` instructions; scheduled-periodic shape (`pi --mode rpc --extension <probe>` from a fresh directory confirmed absent from `~/.pi/agent/trust.json`) — same result; interactive-chat shape (`pi --extension <probe>`, no `--mode`, driven via a real pty) — `resources_discover` fired (stderr) and marker skill appeared in the rendered `[Skills]` startup banner before any turn

Obstacles Encountered:
- `pi`'s `--extension` factory function contract wasn't obvious from the extension-events doc alone — had to read the actual load-error message (`Extension does not export a valid factory function`) and `bob.ts`'s own `export default function` shape to get the probe extension loading at all.
- The first correctness check for "did the contributed skill reach the prompt" was wrong: it checked for the SKILL.md body's marker text in `before_provider_request`, which is never present pre-first-turn (only `name`/`description` populate `<available_skills>`; body loads on demand). Caught via a `--skill` CLI-flag control run before trusting a false negative from `resources_discover`.
- `bob chat`'s interactive-mode invocation shape has no real TTY available through the bash tool; built a small Python `pty.spawn`-based driver to give `pi` a pseudo-terminal for that one probe run rather than skipping the interactive path.
- Discovered `the-intern/bob-companion/claude/skills/bob-setup/SKILL.md` now disagrees with the reconciled README record; out of this task's Files to Touch, so filed `B-038` instead of editing it.
- Live probing used real API credits (small, on the order of $0.01 per short prompt across ~4 runs) since this environment has working model-provider credentials, unlike the B-035 diagnosis sandbox.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-10

PASS

Stage 1 (acceptance criteria) — all three met, checked against `README.md`
(commit `a1ba007` on `task/T-150-reconcile-pi-agent-version-records`):
- AC-1: The "pi-agent Version Compatibility" section now records a single
  reconciled runtime `pi` version (`0.80.3`) shared across all three bob
  spawn paths, plus a stated, explicit reason the extension-API pin
  (`0.75.3`) is kept separate (compile-time TypeScript surface pin vs.
  runtime executable version) — satisfies the "or documented per-path
  versions with a stated reason" clause.
- AC-2: Work Log documents a probe extension registered for
  `resources_discover` run through all three spawn paths, with the
  scheduled-periodic probe run from a directory confirmed absent from
  `~/.pi/agent/trust.json`. The event fired and a contributed skill path
  reached `<available_skills>` pre-first-turn on all three; the result is
  recorded in the README.
- AC-3: No gap was found, and the README explicitly states "No gap is
  recorded and no blocker is raised for T-157–T-160," satisfying the
  conditional criterion's documentation requirement.
- No unspecified behavior added; only `README.md` was modified
  (`git diff dev-agent...task/T-150-... --stat` shows one file, 23
  insertions / 7 deletions), matching Files to Touch. The probe extension
  was never committed (confirmed clean worktree, no stray probe files in
  history). The out-of-scope stale-version duplicate found in
  `bob-companion/claude/skills/bob-setup/SKILL.md` was correctly filed as
  `B-038` rather than edited inline, keeping this task's diff scoped to its
  stated Files to Touch.

Stage 2 (code quality):
- Correctness: independently spot-checked the Work Log's spawn-path
  reconstruction against the actual Rust source rather than taking it on
  faith — `pi-agent-supervisor/src/lib.rs:47` confirms the default
  `worker_args: vec!["--mode", "rpc"]` used by both the pooled worker
  (`pool.rs::worker_process_config_for_session`) and the cwd-scoped
  scheduled worker (`worker_process_config_for_cwd_session`, which only
  overrides `worker_cwd`), and `bob/src/serve.rs:153-161` /
  `build_interactive_session_config` confirms interactive chat always
  passes `args: Vec::new()` (no `--mode`), independent of configured
  `pi_agent_args` — matching the Work Log's claims exactly.
- Tests: re-ran the task's full verification block in a clean worktree
  checked out at the task branch tip — `grep -q "pi-agent Version
  Compatibility" README.md` (pass), `grep -q "resources_discover"
  README.md` (pass), `cd the-intern/pi-extension && npm test` (2 files,
  38/38 tests passing, matching the Work Log's claim). Confirmed
  `pi-agent-compat.test.ts` still asserts the literal `0.75.3` and the
  `/unsupported/i` wording the task said must not regress — both are
  retained unchanged in the reconciled README section.
- Security: not applicable — documentation-only change.
- Readability: the reconciled section is clear, explicitly separates the
  compile-time API pin from the runtime CLI record, and states the
  verification result and its "no blocker" conclusion inline.
- Performance: not applicable.
- B-038 (filed during this session for the out-of-scope stale-version
  duplicate) is well-formed: evidence independently spot-checked and
  confirmed accurate (`SKILL.md:31` still reads `0.79.10`), non-blocking
  for this task.

No blocking issues found. Both review stages pass.

Next owner: Development Loop.
