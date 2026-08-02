---
id: T-131
title: Verify pi cwd-relative skill discovery and scaffold the email-skills package
status: pending  # pending | in-progress | completed | blocked
priority: high  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Verify pi cwd-relative skill discovery and scaffold the email-skills package

## Description

S-010 ships two pi-agent skills as a new product package that a scheduled job
reaches through its per-entry `--cwd` (S-009 / ADR-012 §7). Every later task in
this plan writes files into that package, so its on-disk layout must first be
the one pi actually discovers — this task proves it and records it.

Create the package root `the-intern/email-skills/` (a new top-level directory
under `the-intern/`, sibling to `bob-companion`, per S-010's Configuration
Requirements) with a `README.md` that documents the verified layout, and add the
directory to the folder-structure tree in `CLAUDE.md` (`AGENTS.md` is a symlink
to it — edit `CLAUDE.md` only).

The expected path is `.pi/skills/<name>/SKILL.md` relative to the session's cwd,
mirroring pi's global `~/.pi/agent/skills/<name>/SKILL.md` layout (SKILL.md with
`name` / `description` / `allowed-tools` frontmatter, plus optional
`references/*.md`). Confirm it with a throwaway probe skill in a copy of the
package before writing it into the README.

**`.gitignore` ignores the bare pattern `.pi` (line 4), which git matches at
every directory level — so `the-intern/email-skills/.pi/` and every skill file
T-132–T-138 write into it would be silently untracked.** Fix it here, before any
skill file exists: anchor the repo-root agent-config ignores (`/.pi`), or negate
for this package. `the-intern/bob-companion/claude/` (undotted) is the existing
precedent for the same problem with `.claude`.

`pi` on PATH is a hard precondition (CLAUDE.md); do not mock it. `pi` defaults to
an interactive `ink` TUI needing a real TTY — probe with the non-interactive
`-p`/`--print` opt-out and record the working invocation form in the README,
since T-132–T-138 reuse it.

This package is the repository source of truth only: a scheduled job's `--cwd`
points at an owner-only *deployed copy*, never at the checkout.

## Acceptance Criteria

AC-1: WHEN a pi session runs with a copy of the package as its working directory
      THE SYSTEM SHALL list the probe skill placed at the candidate path among its
      available skills, and `the-intern/email-skills/README.md` shall record that
      verified path together with the `pi --version` and the invocation form used,
      evidenced by a transcript in the Work Log.
AC-2: The system shall document in the README the package's full intended layout
      — the `himalaya` and `email-triage` skill directories, the category
      reference directory, the skill-local configuration file, and the runtime
      `worklog/` directory — so later tasks add files without editing that
      section.
AC-3: IF the verified discovery path differs from `.pi/skills/<name>/SKILL.md`
      THEN THE SYSTEM SHALL adopt the verified path in the README and report the
      deviation so dependent tasks' file paths are corrected before they start.
AC-4: The system shall make every file under `the-intern/email-skills/` — including
      the dot-directory the verified discovery path uses — trackable by git,
      evidenced by `git check-ignore -v` reporting no match for a file at the
      verified skill path.
AC-5: The system shall list `the-intern/email-skills/` with a one-line purpose in
      the folder-structure tree in `CLAUDE.md`.

## Dependencies

- None

## Files to Touch

- `the-intern/email-skills/README.md` — new: package purpose, verified skill
  discovery path and invocation form, full intended layout, deployment-copy note
- `.gitignore` — stop the bare `.pi` pattern from ignoring the package's skill
  directory
- `CLAUDE.md` — add the new top-level package to the folder-structure tree

## Verification

```bash
# Prerequisite (hard project precondition — escalate if absent)
pi --version

# Probe the candidate discovery path in a throwaway copy of the package
rm -rf /tmp/email-skills-probe
mkdir -p /tmp/email-skills-probe/.pi/skills/probe-marker
cp -r the-intern/email-skills/. /tmp/email-skills-probe/
printf -- '---\nname: probe-marker\ndescription: Probe skill used to verify cwd-relative discovery.\n---\n\n# Probe\n' \
  > /tmp/email-skills-probe/.pi/skills/probe-marker/SKILL.md

# Ask pi, with that directory as its cwd, to list its available skills.
# Use -p/--print: pi's default mode is an interactive ink TUI needing a real TTY
# and will not run under a non-interactive shell.
cd /tmp/email-skills-probe && pi -p "List the names of every skill available to you. Do not use any tools."

# Confirm `probe-marker` appears. If -p does not surface project skills, retry
# under a TTY (`script -qec 'pi' /dev/null`) and record which form worked.
# If the skill does not appear at all, repeat with the next candidate path until
# one is confirmed. Paste the transcript into the Work Log and record the
# confirmed path and invocation form in the README.

# The package's skill files must not be gitignored (AC-4) — this must print
# nothing and exit non-zero:
cd "$OLDPWD" && git check-ignore -v the-intern/email-skills/.pi/skills/probe-marker/SKILL.md
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-02

Confirmed `pi` on PATH (`pi --version` → `0.80.3`), then probed the candidate discovery path exactly as the task's verification script specifies: created `/tmp/email-skills-probe/.pi/skills/probe-marker/SKILL.md` and ran `pi` with that directory as `cwd`.

Key finding: `pi -p "<prompt>"` alone (the form given literally in the task's Verification block) never surfaced `probe-marker` — only the three globally-installed skills (`gh-cli`, `git-conventions`, `pr-review`) appeared, reproducibly across repeated runs. Investigating `pi --help`, the `--approve`/`-a` flag ("Trust project-local files for this run") turned out to be the missing piece: `pi -p -a "<prompt>"` (or `pi --print --approve`) consistently surfaced `probe-marker` alongside the global skills. So the discovery *path* itself needed no correction (`.pi/skills/<name>/SKILL.md` relative to cwd was right on the first try — AC-3 is N/A, no path deviation to report), but the invocation form recorded in the README had to be `-p -a`, not bare `-p`, since pi does not load project-local content from an untrusted cwd without explicit per-run trust. Recorded this as the important caveat for T-132–T-139, which reuse this invocation form.

Reproduced the `.gitignore` bug described in the task before fixing it: placed a file at `the-intern/email-skills/.pi/skills/probe-marker/SKILL.md` in the real package and confirmed `git check-ignore -v` matched it against `.gitignore:4:.pi` (the bare pattern matching at every directory level, not just repo root). Fixed by anchoring that one line to `/.pi` (left the other three agent-config lines — `.codex`, `.claude`, `.agents` — untouched, since only `.pi` conflicts with this new package and the task's own phrasing singles out `/.pi`). Re-verified: the same path no longer matches (`git check-ignore` exits 1), and a repo-root `.pi/...` path still matches (exit 0), so the intended repo-root agent-config ignore behavior is preserved. Removed the probe file from the real package afterward — per the task's own instruction, the probe belongs in a throwaway copy, and `git check-ignore` works fine against a path that doesn't exist on disk, so the final AC-4 verification command in the task doesn't require a committed probe file.

Wrote `the-intern/email-skills/README.md` covering: package purpose and how it differs from `bob-companion/claude` and `.claude/skills`; the verified discovery path, `pi --version`, and the `-p -a` invocation form (AC-1); the full intended layout — `himalaya` and `email-triage` skill directories, `references/categories/` (the category reference directory), `config/email-triage.example.toml` (the skill-local configuration template) and `worklog/` (the runtime diary directory) — cross-referenced to T-132–T-138 so those tasks can add files without touching this section (AC-2); and the deployed-copy-only note (checkout is never a scheduled job's `--cwd`). Cross-checked the layout names (`references/categories/`, category names, `config/email-triage.example.toml`, `worklog/<YYYY-MM-DD>.md`) against S-010 and the pending T-132–T-138 task files rather than inventing names, so downstream tasks' assumed paths line up.

Added `the-intern/email-skills/` to `CLAUDE.md`'s folder-structure tree (AGENTS.md is a symlink, edited `CLAUDE.md` only) as a sibling of `bob-companion`, one line, per AC-5.

Re-ran the task's full Verification block end-to-end after committing (fresh `/tmp` probe copy, bare `-p` vs `-p -a`, and the `git check-ignore` command from the repo root) — all outcomes match what's recorded in the README. Nothing remains for this task; all five acceptance criteria are implemented and independently re-verified. Three commits on the task branch, one per Files-to-Touch item: `32f35e1` (`.gitignore` fix, AC-4), `9c64243` (README, AC-1/2/3), `cdbdcd0` (`CLAUDE.md` tree, AC-5).

### Session 2 — 2026-08-02

Addressed the Reviewer's FAIL: AC-1 requires the discovery result to be "evidenced by a transcript in the Work Log," and Session 1's entry only narrated the finding in prose without the literal transcript. Re-ran both probe invocations from the task's Verification block against a fresh `/tmp/email-skills-probe` scratch copy (rebuilt via the same `rm -rf` / `mkdir -p` / `cp -r` / `printf` steps as before) and captured the raw commands and stdout below.

Confirmed `pi --version`:

```
$ pi --version
0.80.3
```

Bare `-p` probe run (the form given literally in the task's Verification block):

```
$ cd /tmp/email-skills-probe && pi -p "List the names of every skill available to you. Do not use any tools."
gh-cli  
git-conventions  
pr-review
```

`probe-marker` does not appear — only the three globally-installed skills.

`-p -a` probe run (the corrected invocation form, `--approve`/`-a` = "trust project-local files for this run"):

```
$ cd /tmp/email-skills-probe && pi -p -a "List the names of every skill available to you. Do not use any tools."
probe-marker
gh-cli
git-conventions
pr-review
```

`probe-marker` appears alongside the three global skills, confirming `.pi/skills/<name>/SKILL.md` relative to `cwd` is the correct discovery path and `-p -a` is the required invocation form.

Also re-confirmed the AC-4 `git check-ignore` verification from the repo root, unchanged from Session 1:

```
$ cd "$OLDPWD" && git check-ignore -v the-intern/email-skills/.pi/skills/probe-marker/SKILL.md
$ echo $?
1
```

(No output, exit 1 — no match, as required.)

These transcripts match Session 1's narrated finding and the Reviewer's own independent reproduction exactly, so no change was needed to the substantive finding, the verified discovery path, or `the-intern/email-skills/README.md`'s content — its cross-reference to "T-131's Work Log" for the full transcript is now accurate. Removed the throwaway `/tmp/email-skills-probe` copy afterward (Verification block's own guidance: the probe belongs in a throwaway copy, never committed). No files under `the-intern/email-skills/`, `.gitignore`, or `CLAUDE.md` changed this session; the task branch remains at `cdbdcd0` (no new commit needed, since Files to Touch content is unchanged — only Work Log evidence, which is canonical-file-only and out of scope for the task branch, was added).

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-02

FAIL

**Stage 1 — Acceptance Criteria**

AC-2 through AC-5 were independently checked and pass:
- AC-2 (full intended layout documented): README's "Package layout" section
  names `himalaya` and `email-triage` skill directories, `references/categories/`,
  `config/email-triage.example.toml`, and `worklog/`, cross-referenced to
  T-132–T-138 — matches those pending tasks' own `Files to Touch` paths.
- AC-3 (N/A case): verified path matched the expected
  `.pi/skills/<name>/SKILL.md` on the first try; README correctly states no
  deviation to report.
- AC-4 (git-trackability): independently re-verified —
  `git check-ignore -v the-intern/email-skills/.pi/skills/probe-marker/SKILL.md`
  exits 1 (no match) on the task branch, while a repo-root `.pi/skills/foo/SKILL.md`
  still matches `.gitignore:6:/.pi` and `.claude/foo` still matches
  `.gitignore:3:.claude` — the anchoring fix is correct and scoped.
- AC-5 (CLAUDE.md tree entry): `the-intern/email-skills/` is listed as a
  sibling of `bob-companion` with a one-line purpose, formatting consistent
  with the rest of the tree.

AC-1 fails on one specific, narrow point:

- **File and location:** `docs/ai-team/tasks/in-progress/T-131-....md`, Work
  Log, Session 1; and `the-intern/email-skills/README.md`, "Verified skill
  discovery path and invocation form" section.
- **What is wrong:** AC-1 requires the discovery result to be "evidenced by a
  transcript in the Work Log," and the task's own Verification block says
  explicitly: "Paste the transcript into the Work Log." Session 1's entry only
  narrates the finding in prose (e.g. "`pi -p "<prompt>"` alone ... never
  surfaced `probe-marker`" / "`pi -p -a "<prompt>"` ... consistently surfaced
  `probe-marker`") — it does not contain the actual pasted transcript (the
  literal commands run and their raw stdout). The README compounds this by
  asserting "The full transcript is recorded in T-131's Work Log," which is
  not currently true — there is no transcript there, only a summary.
- **What should change:** Append the literal transcript (commands plus raw
  stdout) for both the bare `-p` probe run and the `-p -a` probe run to the
  Work Log, so AC-1's "evidenced by a transcript" clause is actually met and
  the README's cross-reference to the Work Log becomes accurate.
- **Independent verification note:** I re-ran both invocations myself against
  a fresh `/tmp/email-skills-probe` copy built exactly per the task's
  Verification block, on `pi --version` `0.80.3`. Bare `-p` listed only
  `gh-cli`, `git-conventions`, `pr-review`; `-p -a` listed `probe-marker`,
  `gh-cli`, `git-conventions`, `pr-review`. This reproduces the developer's
  finding exactly, so no change to the substantive finding, the verified
  path, or the README's content is needed — only the missing transcript
  evidence in the Work Log.

Stage 2 (code quality) was not evaluated per the code-review skill's
instruction to skip Stage 2 when a Stage 1 criterion fails.

### Review Verdict — 2026-08-02

PASS

**Stage 1 — Acceptance Criteria**

- AC-1: Now met. Work Log Session 2 appends the literal transcript (raw
  commands and stdout) for both the bare `-p` probe run and the `-p -a`
  probe run, plus the `pi --version` and `git check-ignore` transcripts.
  Independently reproduced against a fresh scratch copy of the task branch's
  `the-intern/email-skills/` (via `git worktree add`) on `pi --version`
  `0.80.3`: bare `-p` listed only `gh-cli`, `git-conventions`, `pr-review`;
  `-p -a` listed `probe-marker`, `gh-cli`, `git-conventions`, `pr-review`;
  `git check-ignore -v the-intern/email-skills/.pi/skills/probe-marker/SKILL.md`
  printed nothing and exited 1. This matches the Work Log transcript exactly,
  and `the-intern/email-skills/README.md`'s cross-reference to "T-131's Work
  Log" for the full transcript is now accurate.
- AC-2 through AC-5: unchanged from the prior cycle's independent
  verification (still hold — no README, `.gitignore`, or `CLAUDE.md` content
  changed this session; only the missing Work Log transcript was added).

All five acceptance criteria are met with evidence.

**Stage 2 — Code Quality**

- Correctness: the `.gitignore` anchoring fix (`.pi` → `/.pi`) is scoped
  correctly — re-verified a repo-root `.pi/...` path still matches (exit 0)
  while the package's nested `.pi/skills/.../SKILL.md` path no longer does
  (exit 1); the other three agent-config lines (`.codex`, `.claude`,
  `.agents`) are untouched.
- Tests: no automated tests apply to this docs/config task; the task's own
  manual Verification block was followed and independently reproduced by
  the reviewer with matching output.
- Security: no secrets or real addresses in `README.md`; the config template
  path is explicitly documented as containing no real manager address.
  Runtime state (`config/email-triage.toml`, `worklog/`) is documented as
  deployed-copy-only, never committed.
- Readability: README is well-organized (purpose, verified path/invocation,
  layout, deployment note); `.gitignore` change has a clear explanatory
  comment; `CLAUDE.md` tree entry matches the formatting and pipe-alignment
  convention of sibling entries (e.g. `bob-companion/claude/`).
- Performance: not applicable.
- Scope: each of the three task-branch commits (`32f35e1`, `9c64243`,
  `cdbdcd0`) touches exactly one file, and together they cover exactly the
  three files listed in Files to Touch — no unexpected files modified, no
  unspecified functionality added.

Both stages pass. No blocking issues. Minor non-blocking observation: none.
