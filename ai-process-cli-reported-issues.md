# ai-team CLI / skill issues

Running log of bugs and friction observed while using the `ai-team` CLI and the
slash-skills that wrap it. New entries at the top.

## 2026-06-23 — `integrate` post-merge regression check uses task-scoped verification, missing cross-crate breaks

**Symptom.** B-013 was a red baseline on `dev-agent`: T-101 added a fail-closed
extension gate in `pi-agent-supervisor` that broke 5 `admin-rpc` dispatch tests
(they started the supervisor with `Config::default()`, whose empty
`extension_path` now fails the gate). The break landed on `dev-agent`
undetected even though `integrate` runs a post-merge regression check (Step 6).

**Root cause.** `integrate` Step 2.7/2.8 derives its verification command from
the *work item's* `## Verification` / `## Fix Verification` section and uses it
for both pre- and post-merge runs. T-101's verification was
`cargo test -p pi-agent-supervisor && cargo test -p bob` — it never ran
`-p admin-rpc` or the workspace suite, so the cross-crate regression in
`admin-rpc` was outside the checked scope. The project's actual baseline/CI gate
(per `CLAUDE.md`) is `cargo test --workspace`.

**Impact.** A task whose contract change affects crates outside its declared
verification scope can merge a regression that integrate's regression check does
not catch, leaving `dev-agent` red until the next loop hits its baseline guard.

**Suggested fix.** Have `integrate` Step 6 (post-merge regression check) run the
project-wide baseline (`cargo test --workspace`) in addition to the task-scoped
command, or prefer the documented project baseline when the work item changes a
shared/public interface. At minimum, document that task `## Verification`
sections must include the workspace suite when the change alters a cross-crate
contract.

## 2026-06-19 — `status-report` skill is not model-invocable from `bug-loop`

**Symptom.** The `bug-loop` skill's Step 8 instructs `Skill(status-report)` to
produce the Gate 5 summary when the queue drains. The skill exists on disk
(`.claude/skills/status-report/SKILL.md`) but is not in the session's invocable
skill list, so the Skill tool cannot call it. Its frontmatter has
`disable-model-invocation: true`, which is what blocks programmatic invocation.

**Impact.** A loop that completes successfully cannot run its own final step as
written; the orchestrator must fall back to reading `SKILL.md` and executing its
procedure (`ai-team status` + `ai-team report`) by hand. Worked around this run
with no loss of output, but the loop instruction and the skill's
`disable-model-invocation` flag are contradictory.

**Suggested fix.** Either remove `disable-model-invocation: true` from
`status-report`'s frontmatter so loops can invoke it, or change `bug-loop` (and
`dev-loop`) Step 8 to call `ai-team status` / `ai-team report` directly instead
of `Skill(status-report)`.

## 2026-06-13 — no check that accepted ADRs propagate to the specs they supersede

**Symptom.** `ai-team validate` checks artifact metadata and cross-references
(e.g. task→spec resolution), but it does not detect when an **accepted ADR has
superseded a decision that approved specs still describe the old way**. ADR-005
(accepted 2026-05-22) made socket filesystem permissions the sole connection
gate and demoted `SO_PEERCRED` to an audit-only signal, removing the uid
allow-list. For roughly three weeks the specs that define those surfaces — S-002,
S-003, S-005 — still said the sockets enforce a `perms + SO_PEERCRED` gate and
referenced the removed `admin_allowed_uids`/`admin_allowed_gid` config. Nothing
flagged the contradiction; it surfaced only across three rounds of human PR
review on PR #22.

**Impact.** Accepted decisions silently fail to fan out to the artifacts that
depend on them, so the spec/doc set drifts out of agreement with its own ADRs.
The drift is invisible to `validate` and is caught (if at all) only by manual
review — expensive, and easy to miss a straggler (the first reconciliation pass
on PR #22 fixed S-002/S-005 but missed S-003 and a rendered mdBook page, needing
a further review round). This is the same failure mode that motivated the PR #22
work in the first place: implementation/decisions moving ahead of the documents
that are supposed to be their source of truth.

**Suggested fix.** Give ADRs a machine-readable "supersedes/amends" link to the
specs or prior ADRs they change (frontmatter, e.g. `amends: [S-002, S-005]`, or
a structured `supersedes:` already supported for ADR→ADR). Then `ai-team
validate` can warn when an artifact named in an accepted ADR's `amends:` list has
not recorded a corresponding amendment-log entry dated on/after the ADR, or — as
a lighter heuristic — surface specs that still contain phrases an accepted ADR
explicitly retired. Even just the "amended artifact lacks a post-ADR
amendment-log entry" check would have caught all three stale specs here.

## 2026-06-10 — `new-bug` skill/CLI flag mismatch hit again (B-008)

The `new-bug` skill still prescribes `ai-team bug new --json --title "<title>"
--description "<description>" --severity "<severity>"`. The CLI rejects
`--title` (title is positional) and has no `--description` option. Same defect
as the 2026-05-18 and 2026-05-20 entries; the skill file has still not been
updated. Worked around by using the positional title and writing the
description into the bug file body (B-008).

## 2026-05-28 — `integrate` skill's "move to completed" commit did not delete the in-progress copy

**Symptom.** During `dev-loop` integration of T-084, the integrator's
`chore(tasks): move T-084 to completed` commit (`c416916`) added the task file
to `project/tasks/completed/` but did NOT remove it from
`project/tasks/in-progress/`. Result: HEAD contained the file in both
locations. The working tree showed the deletion from in-progress/ as an
unstaged change because the file was physically gone from disk, but the
index/HEAD still tracked it. A follow-up commit
(`chore(tasks): remove stale T-084 in-progress copy after move to completed`,
`2a4b4c9`) was required to repair the state.

**Impact.** Lifecycle state is briefly inconsistent (a task appears
simultaneously "in-progress" and "completed" in git history), and the next
loop iteration sees a non-empty working tree on `dev-agent`. Easy to miss if
the orchestrator does not run `git status` after integration.

**Suggested fix.** The integrate skill must use `git mv` (or
`git rm` + `git add` of the new path) so the single commit captures both the
deletion and the addition. A defensive check in the integrator: after the
move commit, assert `git status --porcelain project/tasks/in-progress/` is
empty before declaring success.

## 2026-05-21 — `new-spec` skill uses CLI flags `ai-team spec new` does not accept

**Symptom.** The `new-spec` skill instructs callers to run
`ai-team spec new --json --title "<title>" --description "<description>"`.
`ai-team spec new` rejects `--title` (`No such option '--title'`) — `title` is a
positional argument — and has no `--description` option at all (only `--author`,
`--status`, `--json`).

**Impact.** Spec creation fails on first attempt; the caller must check `--help`
and rewrite the command, and any spec `description` text has nowhere to go via
the CLI (it must be written into the file body afterward).

**Suggested fix.** Update `.claude/skills/new-spec/SKILL.md` to use positional
`TITLE` and drop `--description` from the command, or add a `--description`
option to `ai-team spec new`. This mirrors the already-logged `ai-team bug new`
flag mismatch — the same fix pattern applies.

## 2026-05-20 — Reviewer committed a review verdict onto the task branch

**Symptom.** During `dev-loop` processing of T-063, the cycle-1 Reviewer
(`code-review` skill) committed the review verdict to the canonical task file
on the **task branch** (`task/T-063-...`, commit `af89483`) in addition to the
correct commit on `dev-agent` (`1e9516c`). The Reviewer's own report stated the
verdict was committed on `dev-agent`, so the stray task-branch commit was
silent. It was caught by the `integrate` skill's Step 3.4 hard stop (source
diff must not modify the canonical lifecycle file); the loop reverted it on the
branch before merging.

**Impact.** Implementation branches accumulate lifecycle-file edits that must
not be merged into `dev-agent`. Without the `integrate` guard this would have
double-applied work-log/verdict content or caused a merge conflict on the task
file.

**Suggested fix.** The `code-review` skill should explicitly `git checkout
dev-agent` before staging/committing the verdict, and verify the current branch
is the destination branch before committing. Consider adding a check that the
verdict commit's branch is not a `task/`/`bug/` branch.

## 2026-05-19 — `new-spec` skill uses unsupported CLI flags

**Symptom.** The `new-spec` skill prescribes
`ai-team spec new --json --title "<title>" --description "<description>" ...`.
The current CLI rejects `--title` (title is positional) and has no
`--description` option.

**Reproduction.**
```
ai-team spec new --json --title "x" --description "y" --author planner --status draft
# → Error: No such option: --title
ai-team spec new --help
# shows: ai-team spec new [OPTIONS] TITLE; options are --author, --status, --json only
```

**Impact.** Same shape as the 2026-05-18 `new-bug` issue: the skill's prescribed
command fails on first call. The caller has to inspect `--help`, drop `--title`
to positional, and then fill the `description` directly into the created spec
file because the CLI does not accept it.

**Suggested fix.** Update `.claude/skills/new-spec/SKILL.md` so the command
construction uses `"<title>"` as positional and removes `--description`. Either
have the skill seed the spec body from the description after creation (current
workaround) or add a `--description` option to the CLI.

## 2026-05-19 — `ai-team spec new` duplicate-ID bug recurs

Same as the 2026-05-16 entry below; hit again today.

```
ai-team spec new --json --author planner --status draft "JS extension for pi-agent event forwarding"
# → {"id": "S-001", "path": ".../js-extension-for-pi-agent-event-forwarding.md"}
# project/specs/ already contains the-intern-agent-service-architecture.md (id S-001)
# and bob-service-shell-architecture.md (id S-002).
```

Manual fix: rewrote the new file's frontmatter `id` to `S-003`. The 2026-05-16
entry's suggested fix still stands and has not been applied.

## 2026-05-18 — `new-bug` skill uses unsupported CLI flags

**Symptom.** The `new-bug` skill prescribes
`ai-team bug new --json --title "<title>" --description "<description>" ...`.
The current CLI rejects `--title` (title is positional) and has no
`--description` option.

**Reproduction.**
```
ai-team bug new --json --title "x" --description "y" --severity high
# → Error: No such option: --title
ai-team bug new --help
# shows: ai-team bug new [OPTIONS] TITLE
```

**Impact.** First-call bug creation fails whenever the skill is followed
literally. Callers must inspect help output and manually adapt.

**Suggested fix.** Update `.claude/skills/new-bug/SKILL.md` to use positional
`TITLE` and remove `--description` from the command construction step.

## 2026-05-16 — `ai-team spec new` assigns duplicate IDs

**Symptom.** Running `ai-team spec new ...` produced a new spec with `id: S-001`
while `project/specs/the-intern-agent-service-architecture.md` already used
`id: S-001`. The CLI did not look at existing IDs when allocating the next one.

**Reproduction.**
```
ai-team spec new --json --author planner --status draft "Bob Service Shell Architecture"
# → {"id": "S-001", "path": ".../bob-service-shell-architecture.md"}
# but project/specs/the-intern-agent-service-architecture.md already has id: S-001
```

**Impact.** Two specs with the same identifier; references like "S-001" become
ambiguous. Required manual frontmatter fixup.

**Suggested fix.** Scan `project/specs/` for the highest existing `S-NNN` in
frontmatter and increment, the same way task IDs are allocated.

## 2026-05-16 — `new-spec` skill documents an out-of-date CLI signature

**Symptom.** The `new-spec` skill prescribes
`ai-team spec new --json --title "<title>" --description "<description>" ...`.
The current CLI rejects `--title` (the title is a positional argument) and does
not accept `--description` at all (description content is written into the spec
body by hand).

**Reproduction.**
```
ai-team spec new --json --title "X" --description "Y"
# → Error: No such option: --title
ai-team spec new --help
# shows: ai-team spec new [OPTIONS] TITLE  with only --author/--status/--json
```

**Impact.** The skill's first attempt always fails; the caller has to inspect
`--help` and reconstruct the right invocation. The skill should also be told
that `description` is purely an input to the spec body, not a CLI flag.

**Suggested fix.** Update `.claude/skills/new-spec/SKILL.md` step 2 to use
`ai-team spec new --json [--author X] [--status Y] "<title>"` and to instruct
the caller to write the description into the spec body during step 4.

## 2026-05-20 — `new-bug` skill/CLI mismatch still causes first-call failure

The `new-bug` skill still documents unsupported flags (`--title`, `--description`).
Following the skill literally failed again today before adaptation.

**Reproduction.**
```
ai-team bug new --json --title "x" --description "y" --severity high
# -> Error: No such option '--title'
ai-team bug new --help
# shows: ai-team bug new [OPTIONS] TITLE
```

**Impact.** Bug capture flow fails on first attempt unless the caller manually
checks CLI help and rewrites the command.

**Suggested fix.** Update `.claude/skills/new-bug/SKILL.md` to use positional
`TITLE` and remove the unsupported `--description` flag from command examples.

## 2026-05-20 — `ai-team bug new` fails from repo root with Cargo lookup error

Running `ai-team bug new` from `/home/daneel/projects/the-intern` failed with:
`could not find Cargo.toml in /home/daneel/projects/the-intern or any parent directory`.
The command succeeds from `/home/daneel/projects/the-intern/the-intern/service`.

**Impact.** The CLI appears sensitive to working directory in a way that is not
explained by `--help`, causing avoidable failures during bug creation.

**Suggested fix.** Either (a) make `ai-team` resolve project root from
`.ai-team.toml` regardless of cwd, or (b) document the required cwd in CLI help
and all relevant skills.
