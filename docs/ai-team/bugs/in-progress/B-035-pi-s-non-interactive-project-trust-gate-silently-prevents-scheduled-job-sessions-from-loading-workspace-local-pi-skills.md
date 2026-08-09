---
id: B-035
title: pi's non-interactive project-trust gate silently prevents scheduled-job 
  sessions from loading workspace-local .pi/skills
severity: high
status: in-progress
created: '2026-08-08'
---

# pi's non-interactive project-trust gate silently prevents scheduled-job sessions from loading workspace-local .pi/skills

## Summary

Discovered live during `B-030`/`B-031`'s combined live-validation session
(2026-08-08). Deploying `the-intern/email-skills/` to a fresh workspace
exactly per `the-intern/docs/src/operator-guide/index.md`'s "Deploying the
email-triage scheduled job" section, then registering a `bob schedule add
... --cwd <workspace>` job, produces scheduled-job sessions that never load
the workspace's own `.pi/skills/email-triage`/`.pi/skills/himalaya` content
at all — `bob`'s own `resources_discover`/`before_provider_request` events
show `cwd` correctly set to the deployed workspace, but the model's
`<available_skills>` list contains only the operator's global
`~/.pi/agent/skills/` skills, never the project-local ones. The agent then
behaves like a generic assistant exploring an unfamiliar directory (`ls`,
`pwd && ls -la`, `find . -maxdepth 2 -type f`, `read path="."`) instead of
following `SKILL.md`, and every one of those exploratory calls is denied by
S-004 (none of the shipped rules admit generic directory exploration, only
the specific `SKILL.md`-prescribed shapes). The root cause is pi's own
documented project-trust model
(`~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/skills.md`,
`docs/security.md`, `docs/settings.md`): project-local `.pi/skills/` loads
"only after the project is trusted", and "non-interactive modes (`-p`,
`--mode json`, and `--mode rpc`) do not show a trust prompt. Without an
applicable saved trust decision, they use `defaultProjectTrust` ... : `ask`
(default) and `never` ignore those project resources". `bob`'s
`pi_agent_supervisor` spawns every worker with `--mode rpc` (confirmed via
its own startup log:
`worker_args=["--mode", "rpc"]`) and never passes `--approve`/`-a`, and a
freshly deployed workspace has no entry in `~/.pi/agent/trust.json` — so
every scheduled-job session against a brand-new deployed workspace silently
runs with zero project-local skill content, indefinitely, until an operator
manually pre-seeds that workspace path into `~/.pi/agent/trust.json`
(undocumented anywhere in the operator guide). This is a foundational
deployment-procedure gap that blocks the entire `email-triage` package (all
five categories, not just the two `B-030`/`B-031` were live-validating),
and it produced the exact same class of "3 early denials before reaching
anything SKILL.md-prescribed" symptom that `B-033` investigated and (based
on the available evidence at the time) refuted — this bug is very plausibly
the real root cause `B-033` was unable to confirm because `B-032`'s
tracing fix had not yet landed when `B-033` looked, and the interrupted
original `B-030` session never got the actual denied-command text
recovered.

## Reproduction Status

Status: confirmed

## Evidence

- Logs / stack traces / failing assertions:
  - `bob` `before_provider_request` full payload for the first live tick
    against a freshly deployed, never-before-trusted workspace (session
    `9c118c50-98b3-4b39-ba32-6caccdbb0cc5`, 2026-08-08T15:29:00Z): the
    `instructions` field's `<available_skills>` block lists exactly
    `gh-cli`, `git-conventions`, `pr-review` — all located at
    `/home/daneel/.pi/agent/skills/...` (the operator's global skill
    directory) — with no `email-triage` or `himalaya` entry, despite
    `"Current working directory:
    /tmp/.../scratchpad/email-skills-ws"` (the deployed workspace) appearing
    correctly at the end of the same `instructions` string.
  - That same session's only tool calls were generic exploration —
    `ls`, `pwd && ls -la`, `find . -maxdepth 2 -type f | head -50`, `read
    path="."` — every one denied: `"no action rule permits tool '<x>' with
    the supplied arguments"`. Five consecutive scheduled ticks (5 different
    sessions, 15:29 through 15:33 UTC) repeated this identical pattern.
  - Filesystem check confirmed the deployed workspace's `.pi/skills/`
    tree was present, correctly named (`.pi/skills/email-triage/SKILL.md`,
    `.pi/skills/himalaya/SKILL.md`), and readable by the same user pi runs
    as (`stat` showed owner `daneel`, mode allowing owner read on every
    file/dir in the chain) — ruling out a filesystem/permission cause.
  - Fix (applied as a legitimate one-time operator action for the rest of
    the live-validation session, not a source/doc change): added the
    deployed workspace's canonical absolute path to
    `~/.pi/agent/trust.json` with value `true` (the same file `/trust` in
    interactive mode writes, per `docs/settings.md`). After restarting
    `bob` with a clean process tree, the very next tick's
    `before_provider_request` payload showed `<available_skills>`
    correctly including `email-triage` and `himalaya` (in addition to the
    three global skills), and the session's first `bash`/`read` calls
    matched real `SKILL.md`-prescribed shapes (reading `SKILL.md` itself,
    `references/*.md`, then constructing `himalaya`/worklog commands) —
    confirming trust was the actual blocking factor, not an S-004 rule gap.
  - `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/settings.md:16`
    and `docs/security.md:18`: "Non-interactive modes (`-p`, `--mode json`,
    and `--mode rpc`) do not show a trust prompt. Without an applicable
    saved trust decision, they use `defaultProjectTrust` from global
    settings: `ask` (default) and `never` ignore those project resources,
    while `always` trusts them."
  - `pi_agent_supervisor` startup log line (`bob serve` output):
    `worker_command=pi worker_args=["--mode", "rpc"] ...` — confirms every
    worker spawn omits `--approve`/`-a`.
- Failing command or test: deploy `email-skills` to any workspace with no
  prior entry in `~/.pi/agent/trust.json`, register a `bob schedule add
  ... --cwd <workspace>` job, and observe the first tick's
  `before_provider_request` audit/log payload — `<available_skills>` will
  omit the workspace's own `.pi/skills/*`.

## Reproduction Steps

1. Deploy `the-intern/email-skills/` to a brand-new workspace directory that
   has never appeared as a key in `~/.pi/agent/trust.json`, exactly per the
   operator guide's "Deploying the email-triage scheduled job" section.
2. Add the S-004 action rules and reload policy; register `bob schedule add
   --id check-email --cron "* * * * *" --prompt "Check email" --cwd
   <workspace>`.
3. Start `bob serve` with `RUST_LOG=extension_ipc=debug` and let a tick
   fire.
4. Inspect the tick's `before_provider_request` extension-event payload (or
   any equivalent capture of the actual system prompt sent to the model):
   `<available_skills>` lists only global (`~/.pi/agent/skills/`) skills,
   never the workspace's `.pi/skills/email-triage`/`.pi/skills/himalaya`.
5. Contrast with step 1 after first adding the workspace's canonical path to
   `~/.pi/agent/trust.json` (`{"<abs-workspace-path>": true}`) and
   restarting `bob serve`: the next tick's `<available_skills>` correctly
   includes the workspace-local skills.

## Expected Behavior

Per `the-intern/docs/src/operator-guide/index.md`'s "Working directory for
pi-agent sessions" section ("This lets pi discover project context
(`AGENTS.md`/`CLAUDE.md`), skills, and relative prompt-file paths from a
predictable directory"), a scheduled job's deployed workspace should have
its `.pi/skills/` content available to the agent from the very first tick,
without any extra manual step beyond what the operator guide's deployment
procedure already documents.

## Actual Behavior

The deployed workspace's `.pi/skills/` content is silently never loaded for
any scheduled (`--mode rpc`) session until an operator manually adds the
workspace's canonical path to `~/.pi/agent/trust.json` (or sets pi's global
`defaultProjectTrust` to `"always"`, a broader security-relevant change) —
neither of which the operator guide's deployment procedure currently
mentions. The agent instead runs as a generic, skill-less assistant that
explores the directory with denied, non-`SKILL.md` commands, indefinitely,
tick after tick, with no error surfaced anywhere pointing at project trust
as the cause.

## Environment

- OS / platform: Linux (this dev environment)
- Language / runtime version: n/a
- Relevant dependencies: `pi` 0.80.3 (`@earendil-works/pi-coding-agent`),
  its project-trust model (`~/.pi/agent/trust.json`,
  `defaultProjectTrust`), `bob`'s `pi_agent_supervisor` (spawns workers with
  `--mode rpc`, no `--approve`)
- Branch / commit: `dev-agent`; discovered during `B-030`/`B-031`'s combined
  live-validation session, 2026-08-08

## Related

- Bug: `B-030`, `B-031` (both blocked by this until it was worked around for
  the live-validation session itself), `B-033` (investigated the same class
  of symptom — early, SKILL.md-unrelated denials — from the original
  interrupted `B-030` session, and refuted an absolute-vs-relative S-004
  path-convention hypothesis; this bug is a strong candidate for the real
  root cause of those original denials, though that cannot be retroactively
  confirmed since the original denied-command text was never recovered
  — see `B-032`), `B-032` (the tracing fix that made *this* bug's evidence
  recoverable at all)
- Specification: `S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md`

## Suspected Area

`the-intern/docs/src/operator-guide/index.md`'s "Deploying the
`email-triage` scheduled job" section (missing an explicit
project-trust-establishment step for the deployed workspace) and/or `bob`'s
`pi_agent_supervisor` worker spawn arguments
(`the-intern/service/crates/pi-agent-supervisor/`, currently
`["--mode", "rpc"]` with no `--approve`/`-a` and no documented way to
configure one). Not a defect in `email-skills`' own `SKILL.md`/reference
content, and not a defect in `bob`'s S-004 policy engine (which correctly
denied the exploratory calls it was given — there was simply no admitting
rule for them, nor should there be).

## Fix Verification

```bash
# Once a fix direction is chosen (e.g. documenting a trust-seeding step in
# the operator guide, or having bob's pi-agent-supervisor pass --approve
# for scheduled-job workers, or exposing a config option), deploy a brand
# new workspace with no prior trust.json entry, follow only the documented
# procedure end to end, and confirm the first tick's system prompt already
# includes the workspace's own .pi/skills/* entries with no manual
# trust.json edit required.
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

### Diagnosis 1 — 2026-08-09
Reproduction status: Confirmed. The bug report's own Evidence section already
contains a complete, session-ID-backed live reproduction (session
`9c118c50-98b3-4b39-ba32-6caccdbb0cc5`, 2026-08-08T15:29:00Z, plus 4 repeat
ticks) showing `<available_skills>` omitting the deployed workspace's
`.pi/skills/*` entries until the workspace path was manually added to
`~/.pi/agent/trust.json`. This session corroborates that reproduction with
independent code-, docs-, and environment-level evidence (below) rather than
re-running the full live email-triage stack, because this diagnosis sandbox
has no configured model-provider API credentials (a fresh attempt to run
`pi --mode json -p "say hi"` in an isolated, untrusted scratch workspace
failed immediately with `No API key found for the selected model`, before
reaching the resource-loading/system-prompt stage). The underlying mechanism
is not credential-dependent, so this does not weaken the diagnosis.

Evidence captured:
- `pi --version` in this environment: `0.80.3`, matching the bug's recorded
  environment. `pi --help` confirms `--approve, -a` / `--no-approve, -na`
  exist as documented, and `--mode rpc` is a valid mode.
- Installed pi docs at this exact version corroborate the bug's quotations
  verbatim: `~/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/docs/security.md:29`
  and `docs/settings.md:16` — "Non-interactive modes (`-p`, `--mode json`,
  and `--mode rpc`) do not show a trust prompt. Without an applicable saved
  trust decision, `defaultProjectTrust: "ask"` and `"never"` ignore such
  resources ... Use `--approve`/`-a` ... to override project trust for one
  run."
- `git grep -in "trust|approve|-a\\b|defaultProjectTrust" the-intern/service/`
  shows every "trust" reference in bob's own codebase is its unrelated
  ADR-012 Unix schedule-store trust boundary
  (`bob-core/src/types/schedule.rs`, `admin-rpc/src/dispatch.rs`,
  `bob/src/config.rs`, `bob/src/serve.rs`); nothing anywhere references pi's
  `~/.pi/agent/trust.json`, `defaultProjectTrust`, or `--approve`/`-a`.
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs:43-58`
  (`Config::default()`): `worker_args: vec!["--mode", "rpc"]` — no
  `--approve`/`-a`, and no other `Config` field exists to add one.
- `the-intern/service/crates/pi-agent-supervisor/src/pool.rs:488-511`: both
  `worker_process_config_for_session` (warm-pool workers) and
  `worker_process_config_for_cwd_session` (used by
  `acquire_session_with_cwd`, the scheduled-job/`--cwd` dispatch path from
  T-122/T-127) build `args` from the same `cfg.worker_args.clone()` —
  scheduled-job workers get identical, unconditional `["--mode", "rpc"]`
  args, no code path anywhere adds a trust override.
- `the-intern/docs/src/operator-guide/index.md:739-1058` ("Deploying the
  `email-triage` scheduled job", steps 1-5, read in full): prepare mailbox,
  deploy owner-only workspace, set `manager_address`, add S-004 rules +
  `bob policy reload`, `bob schedule add --cwd`. No step mentions
  `~/.pi/agent/trust.json`, `--approve`, `defaultProjectTrust`, or any pi
  project-trust concept.
- This environment's own `~/.pi/agent/settings.json` has no
  `defaultProjectTrust` key (falls back to documented default `"ask"`), and
  `~/.pi/agent/trust.json` contains exactly one unrelated entry — a fresh
  scratch workspace is, as expected, untrusted.
- Direct experiment (isolated `$HOME`, scratch workspace with a probe
  `.pi/skills/testskill/SKILL.md`, never-trusted): `HOME=<isolated> pi
  --mode json -p "say hi" --verbose` from that workspace immediately emitted
  a `session` event and exited 1 with `No API key found for the selected
  model` before any skill-loading/system-prompt output, and left no
  `trust.json` in the isolated `$HOME` (consistent with the documented
  "ask"-default silently-ignore-no-prompt-no-save behavior). Full
  reproduction of the actual `<available_skills>` payload was not repeatable
  here for lack of model-provider credentials — an environment limitation,
  not evidence against the diagnosis.
- `git status`/`git diff` confirm no production code was modified during
  this diagnosis.

Isolated fault:
- `the-intern/service/crates/pi-agent-supervisor/src/lib.rs:47`
  (`Config::default().worker_args`), consumed unconditionally by
  `pool.rs`'s `worker_process_config_for_session`/
  `worker_process_config_for_cwd_session` for every worker `bob` spawns,
  including scheduled-job (`--cwd`) workers — args never include
  `--approve`/`-a`, no `Config`/CLI/schedule-entry option exists to add one.
- `the-intern/docs/src/operator-guide/index.md`'s "Deploying the
  `email-triage` scheduled job" section (lines 739-1058) — the documented
  procedure never instructs the operator to establish pi project trust for
  the deployed workspace before registering the scheduled job.

Root cause or fault hypothesis: pi's own non-interactive project-trust gate
(`defaultProjectTrust: "ask"` by default, silently ignoring project-local
resources — including `.pi/skills/*` — for `--mode rpc`/`-p`/`--mode json`
sessions with no saved trust decision) combines with two gaps in
`the-intern`'s deployment surface: (1) `pi-agent-supervisor` spawns every
worker, including scheduled-job workers bound to an operator-supplied
`--cwd`, with fixed `["--mode", "rpc"]` args and no way to pass
`--approve`/`-a`; and (2) the operator guide's deployment procedure never
tells the operator to pre-seed trust for the deployed workspace. A freshly
deployed workspace is, by definition, never in `~/.pi/agent/trust.json`, so
every scheduled tick silently runs with project-local skills permanently
excluded, no error surfaced anywhere — matching the bug's confirmed live
evidence exactly.

Planned fix: Close the gap at the documentation layer — the minimal change
consistent with pi's own security model (an explicit, reviewable,
per-workspace operator decision, matching the workaround already validated
live in this bug's Evidence section) rather than a code change that would
make `bob` auto-trust *every* scheduled job's `--cwd` on every tick with no
operator opt-in. Add an explicit trust-establishment step to
`the-intern/docs/src/operator-guide/index.md`'s "Deploying the
`email-triage` scheduled job" section (after workspace deployment, before
`bob schedule add`), instructing the operator to add the deployed
workspace's canonical absolute path to `~/.pi/agent/trust.json`
(`{"<abs-workspace-path>": true}`) and restart `bob serve`. Flag the
alternative (`pi-agent-supervisor` passing `--approve`/`-a` for
scheduled-job workers, or exposing it as a config option) as a broader,
security-relevant change widening bob's trust surface, for the
reviewer/Architect to weigh if a code-level fix is preferred instead of (or
in addition to) the doc fix.

Planned verification: Per the bug's own Fix Verification block — deploy a
brand-new workspace with no prior `~/.pi/agent/trust.json` entry, follow
only the (updated) documented procedure end to end, and confirm the first
tick's `before_provider_request`/system-prompt payload already includes the
workspace's own `.pi/skills/*` entries with no manual `trust.json` edit
needed outside the documented step. If a code-level fix is chosen instead,
add/extend a `pi-agent-supervisor` unit test asserting scheduled-job
(`acquire_session_with_cwd`) worker args include the trust-override flag,
alongside `cargo test -p pi-agent-supervisor`.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-09

Read the canonical bug file from `dev-agent` (this branch's copy predates the Diagnosis Log commit, per the task instructions, so I fetched it via `git show dev-agent:...`). The Diagnosis Log's fix contract was complete and unambiguous: the planned fix is a documentation-layer change — add an explicit pi project-trust-establishment step to the operator guide's "Deploying the `email-triage` scheduled job" section, positioned after workspace deployment and before `bob schedule add`, instructing the operator to add the deployed workspace's canonical absolute path to `~/.pi/agent/trust.json` and restart `bob serve`. The diagnosis explicitly flagged the code-level alternative (`pi-agent-supervisor` passing `--approve`) as a broader security-relevant change for the reviewer/Architect to weigh separately, not the chosen fix — so I implemented only the doc fix, per contract.

Followed TDD even though this is a docs-only change, using an existing repo precedent (`the-intern/docs/test_wire_contract.sh`, a standalone bash assertion script that was accepted as the "developer verification script" for a prior documentation task, T-091) rather than inventing a new testing convention. I wrote `the-intern/docs/test_operator_guide_email_triage_trust.sh`, a regression test that extracts the "Deploying the `email-triage` scheduled job" section from `the-intern/docs/src/operator-guide/index.md` and asserts: a project-trust step is documented, `trust.json` is referenced, restarting `bob serve` is documented, and the trust step is ordered after workspace deployment and before `bob schedule add`. Ran it first to confirm red (5/5 assertions failed, exit 1), then added the new step 3 ("Establish pi's project trust for the deployed workspace") to the operator guide, renumbering the two subsequent steps (old 3→4, 4→5, 5→6 — there are no other references to specific step numbers anywhere else in the repo's live docs; one resolved bug file, `B-029`, references "Step 4" historically but that's a closed lifecycle snapshot and correctly left untouched). Reran the test to confirm green.

Along the way I hit a real flakiness bug in my own first draft of the test script: `echo "$SECTION" | grep -qF "$pattern"` under `set -euo pipefail` intermittently reported false negatives — a SIGPIPE race between `grep -q`'s early exit on match and the still-writing `echo` producer, which occasionally perturbed the `if` condition's truth value across repeated calls in the same script run. I reproduced it deterministically (loop of 20 runs, ~1/3 failure rate on one specific assertion), root-caused it to the pipe-with-`echo` pattern, and rewrote the script to extract the section into a real temp file (via `mktemp` + `awk ... > file`, cleaned up with a `trap`) and `grep` that file directly instead of piping a shell variable through `echo`. Verified 20 consecutive clean runs after the fix, and re-verified true red-without-the-doc-change / green-with-it behavior via `git stash`. Also ran `mdbook build` in `the-intern/docs/` to confirm the edited page still builds cleanly.

Single red→green cycle, committed as one commit on the bug branch (`c4b0601`, `fix(docs): document pi project-trust step for email-triage deployment`) covering both the new test and the operator-guide fix — this is a single-criterion fix contract, so one cycle was sufficient. Nothing remains for this bug's implementation; the Diagnosis Log's Planned Verification also lists a full live end-to-end re-deployment as the ultimate check, which requires model-provider credentials this environment doesn't have (as already noted in the Diagnosis Log itself) — that live check is unchanged in status from the diagnosis session and is a matter for whoever next has live credentials, not a gap in this fix.

Obstacles encountered: my own first draft of the regression test was itself flaky (a `set -e`/`pipefail`/SIGPIPE race in `echo "$VAR" | grep -q`), diagnosed and fixed by grepping a temp file directly instead of piping a shell variable through `echo`. Full live end-to-end re-verification (deploy a brand-new untrusted workspace, follow the updated procedure, confirm the first tick's `<available_skills>` payload) is not runnable in this environment for lack of model-provider API credentials — unchanged in status from the Diagnosis Log. An unrelated untracked file `pr-42-review.md` was already present at the repo root at session start; it is out of this bug's scope and was left untouched.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-09

PASS

**Diagnosis→fix evidence chain.** `Diagnosis 1 — 2026-08-09` is complete: reproduction status
confirmed (corroborates the bug report's own live session evidence with independent
code/docs/environment evidence, and honestly notes the direct-experiment limit — no
model-provider credentials in this sandbox — without weakening the diagnosis), evidence
captured (pi version/docs quotes, `pi-agent-supervisor` `lib.rs`/`pool.rs` code paths, operator
guide read in full, settings/trust.json state, a real isolated-`$HOME` experiment), an isolated
fault (`Config::default().worker_args` unconditionally omitting `--approve`/`-a`, and the
operator guide's deployment procedure never establishing pi project trust), and a root-cause
hypothesis matching the bug's confirmed live evidence exactly. The fix contract (planned fix:
documentation-layer trust-establishment step, not a code change; planned verification: live
E2E redeploy or, if code chosen instead, a `pi-agent-supervisor` unit test) is unambiguous.

**Stage 1 — bug criteria.** The fix implements exactly the contracted planned fix: a new step 3
("Establish pi's project trust for the deployed workspace") in
`the-intern/docs/src/operator-guide/index.md`'s "Deploying the `email-triage` scheduled job"
section, positioned after workspace deployment (step 2) and before the S-004/`bob schedule add`
steps (renumbered 4-6), instructing the operator to add the deployed workspace's canonical path
to `~/.pi/agent/trust.json` and restart `bob serve`. This directly closes the isolated fault at
the documentation layer and satisfies the bug's own Expected Behavior wording ("without any
extra manual step beyond what the operator guide's deployment procedure already documents") —
documenting the step is an in-scope resolution, not a workaround. The code-level alternative
(`pi-agent-supervisor` passing `--approve`) was correctly left unimplemented; the Diagnosis Log
explicitly scoped it as a broader, security-relevant trust-surface change to flag for
reviewer/Architect judgment rather than commit to unilaterally. Reviewer judgment: the doc-only
fix is an appropriate, minimal resolution for this bug as scoped (explicit, reviewable, per-workspace
opt-in matches pi's own security model) and does not require Architect escalation; a follow-up
task/bug could independently propose the code-level enforcement if desired, but that is optional
hardening outside this bug's stated scope, not a gap in this fix. No unrelated behavior was
added; only the operator guide and the new test script were touched (confirmed via
`git diff dev-agent...bug/B-035-...` — two files only).

**Fix Verification.** The bug file's own Fix Verification block calls for a full live
end-to-end redeploy, which requires model-provider credentials unavailable in this
environment — consistent with the Diagnosis Log's own noted limitation and explained in the
Work Log rather than silently skipped. In its place, a regression test
(`the-intern/docs/test_operator_guide_email_triage_trust.sh`) was written and verified: reran it
red (5/5 failing) against the pre-fix doc content and green (5/5 passing) against the current
tree; also ran it 20 consecutive times clean to confirm the developer's claimed SIGPIPE-flakiness
fix holds. Also confirmed `mdbook build` succeeds on the edited page. The regression test is a
reasonable, practical proxy for a docs-only fix given the credential constraint, and the Work
Log names the outstanding live check as unchanged in status from diagnosis, owned by whoever
next has live credentials — not a gap in this review.

**Stage 2 — code quality.** Fix is minimal (one new operator-guide step plus required
renumbering, one new regression-test script; no source code touched). Verified no other live doc
or code references the old step numbers (`B-029`'s "Step 4" reference is a resolved,
closed-lifecycle snapshot correctly left untouched, exactly as the Work Log states). The new test
script is self-contained (temp file + `trap` cleanup, no shared state) and follows the existing
`test_wire_contract.sh` (T-091) precedent for a docs-only "developer verification script" not
wired into CI — consistent with that established pattern, not a gap introduced here. No secrets,
no dead code, readable step content that accurately reflects the Diagnosis Log's evidence
(cross-checked prose against the pi docs quotes and code paths cited in Diagnosis 1). Diagnosis
Log fix contract matches the implementation exactly.

Both stages pass. No blocking issues found.
