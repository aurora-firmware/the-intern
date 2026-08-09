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
