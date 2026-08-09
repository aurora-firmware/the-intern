---
id: B-037
title: S-004 worklog-append action rule denies a legitimate quoted-path heredoc 
  append during live email-triage validation
severity: low
status: resolved
created: '2026-08-08'
task: T-139
---

# S-004 worklog-append action rule denies a legitimate quoted-path heredoc append during live email-triage validation

## Summary

Discovered incidentally during `B-031`'s Diagnosis 3 live end-to-end
retest (2026-08-08). The shipped S-004 `bash` action rule for appending a
worklog entry — `{ field_path = "command", pattern = "*>> worklog/*.md*" }`
in `the-intern/docs/src/operator-guide/index.md` and
`the-intern/email-skills/README.md` — is a doubly-wildcarded pattern that
clearly intends to admit a range of "append text into a worklog file"
shell commands, not one single exact shape. In a real live run, the agent's
own first-choice command to append the day's worklog entry used a
double-quoted, variable-interpolated path (`cat >> "worklog/$TODAY.md"
<<EOF ... EOF`), which `references/worklog.md` does not forbid or steer the
agent away from (unlike the reply/escalation-body construction, this
package has no prescribed exact command shape for the worklog-append
step). That command was denied by S-004 (`allow=false`, "no action rule
permits tool 'bash' with the supplied arguments"), purely because the
literal substring `>> worklog/` the pattern requires is broken by the `"`
character the agent's quoting places between `>>` and `worklog/`. The
functional outcome was still safe (the agent recognized the denial,
retried with a differently-shaped, unquoted command that does match the
rule, and the worklog was still written correctly this run) — but this is
a rule-coverage gap in the safe direction failing, not the S-004 rule
working as intended, and it will recur nondeterministically depending on
which equally-legitimate shell form the agent happens to choose for this
step on a given run.

## Reproduction Status

Status: confirmed — observed directly in a real live `bob` instance during
a real scheduled `email-triage` run, not inferred or reconstructed.

Live session `f8d4d5de-0d96-4b21-a9fb-2506c58fa899` (tick 2026-08-08,
first executed run of the day, deployed workspace under a scratch
directory outside the repo checkout) issued this exact `bash` command to
append its worklog entry:

```
set -e
TODAY=$(date +%F)
TIME=$(date +%H:%M)
mkdir -p worklog
cat >> "worklog/$TODAY.md" <<EOF
## $TIME — Confirming our sync Friday at 10am PT [B031-RETRY-20260808T1658Z] (from Jose Moreno <jose.moreno@aurorafw.com>)

- Done: Read message 114, classified it as meeting-scheduling, and sent a reply confirming Friday, August 14 at 10:00am PT for the Q3 rollout plan sync.
- Left: nothing
- Next: no further action for this message; any later scheduling update arrives as a new unseen message.

EOF
printf 'appended worklog/%s.md\n' "$TODAY"
```

`bob`'s own `extension_ipc=debug` trace recorded, for this exact command:
`extension authz verdict ... allow=false reason=Some("no action rule
permits tool 'bash' with the supplied arguments")`. The agent then
recovered on its own initiative with a differently-shaped, unquoted
command:

```
mkdir -p worklog && printf '%s\n' '## 17:00 — Confirming our sync Friday at 10am PT [B031-RETRY-20260808T1658Z] (from Jose Moreno <jose.moreno@aurorafw.com>)' '' '- Done: Read message 114, classified it as meeting-scheduling, and sent a reply confirming Friday, August 14 at 10:00am PT for the Q3 rollout plan sync.' '- Left: nothing' '- Next: no further action for this message; any later scheduling update arrives as a new unseen message.' '' >> worklog/2026-08-08.md
```

which `bob` admitted (`allow=true reason=None`), and the worklog entry was
written correctly. This is a fully reproducible, mechanical pattern
mismatch (see Actual Behavior), not a flaky or one-off event.

## Evidence

- Logs / stack traces / failing assertions: `bob`'s `extension_ipc=debug`
  audit trace for the denied call, captured live (see Reproduction Status
  above for the exact denied command and the exact `allow=false` verdict
  text).
- Screenshots or recordings: n/a
- Failing command or test:
  ```bash
  cat >> "worklog/$TODAY.md" <<EOF
  ...
  EOF
  ```
  run as a `bash` tool call inside a live `bob`/pi-agent session with the
  S-004 rule `{ field_path = "command", pattern = "*>> worklog/*.md*" }`
  loaded, against a real deployed `email-triage` workspace.
- First diagnostic step if not yet reproduced: n/a — already reproduced
  live; see above.

## Reproduction Steps

1. Deploy `email-skills` per the operator guide's "Deploying the
   `email-triage` scheduled job" section, with the current S-004 rule set
   copied verbatim (including the worklog-append rule,
   `{ field_path = "command", pattern = "*>> worklog/*.md*" }`).
2. Run a `bash` tool call through `bob`'s policy engine with a command of
   the shape `cat >> "worklog/<anything>.md" <<'TOKEN' ... TOKEN` (a
   double-quoted destination path, as an agent composing a shell heredoc
   with a variable-derived filename would naturally write) — this can be
   done directly via `bob`'s extension without needing a live model call,
   by driving the same tool-call authorization path T-139/T-140 and this
   bug's own live session already exercised.
3. Observe the verdict: `allow=false`, "no action rule permits tool 'bash'
   with the supplied arguments" — even though the command only appends
   text to the worklog file, exactly the action class the rule's own
   wildcards (`*>> worklog/*.md*`) are written to admit.
4. Contrast with the same content appended via an unquoted path
   (`>> worklog/<file>.md`, no surrounding quotes): that command is
   admitted (`allow=true`).

## Expected Behavior

A worklog-append `bash` command that only appends the day's entry to
`worklog/<date>.md` should be admitted by the S-004 worklog-append rule
regardless of incidental, safe shell-quoting choices (e.g. a
double-quoted, variable-interpolated destination path) that don't change
what the command actually does. The rule's own double-wildcard shape
(`*>> worklog/*.md*`) signals it is meant to admit a range of equivalent
append forms, not one single exact shell rendering.

## Actual Behavior

The rule's fixed literal segment `>> worklog/` must appear as a
contiguous substring in the command text for `wildmatch` to admit it. A
command that instead writes `>> "worklog/$TODAY.md"` (a double-quote
character immediately after the redirect and space, before the literal
`worklog/`) does not contain that contiguous substring — the interposed
`"` breaks it — so the real `wildmatch` v2.6.1 matcher (the same library
`bob`'s policy-control action gate uses) correctly reports no match per
its own literal-matching semantics, and `bob` denies the call
(`allow=false`). This is a legitimate, commonly-shaped command (quoting a
variable-derived path is ordinary, safe shell practice — arguably safer
than the unquoted form, since it protects against word-splitting/globbing
on the interpolated `$TODAY` value) being denied purely because of a
gap in the rule's pattern coverage, not because the command does anything
unsafe.

## Environment

- OS / platform: n/a — policy-engine/glob-pattern issue, not
  platform-specific
- Language / runtime version: `bob` (Rust), real `wildmatch` v2.6.1 crate
  (the exact library `bob`'s policy-control matcher uses)
- Relevant dependencies: `bob` S-004 policy-control action gate, the
  `email-triage` skill's worklog-append step
  (`the-intern/email-skills/.pi/skills/email-triage/references/worklog.md`,
  which does not prescribe an exact append command shape, unlike the
  reply/escalation body-construction steps)
- Branch / commit: `dev-agent`, current S-004 rule set as of `B-034`'s fix
  (`6621ee6`) — the worklog-append rule itself is unchanged by `B-034` and
  predates it

## Related

- Task: `T-139` (original happy-path validation, first shipped this rule
  set), `T-140` (escalation/block/continuity validation)
- Bug: `B-031` (this bug was discovered incidentally during `B-031`'s
  Diagnosis 3 live end-to-end retest of the reply-send S-004 rule; it is
  independent of and does not affect `B-031`'s own conclusion — the
  reply-send rule and command shape validated there are unaffected by
  this worklog-append-only gap), `B-033` (a previous, ultimately-refuted
  hypothesis about a different opening-step rule-coverage gap in the same
  rule set — this bug is an independent, directly-observed finding, not a
  revival of that refuted hypothesis)
- Specification:
  `S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md`

## Suspected Area

The S-004 worklog-append `bash` action rule pattern
(`the-intern/docs/src/operator-guide/index.md`,
`the-intern/email-skills/README.md`: `{ field_path = "command", pattern =
"*>> worklog/*.md*" }`). Likely fix direction: broaden the pattern (e.g. to
tolerate an optional `"`/`'` immediately around the destination path) or
document/steer the skill toward one canonical unquoted append shape in
`references/worklog.md` (mirroring how `command-reference.md` already
prescribes an exact shape for reply/escalation body construction) so the
agent doesn't need to guess at an unspecified shell rendering that may or
may not match the rule.

## Fix Verification

```bash
# Check the corrected S-004 worklog-append rule (or the corrected/steered
# command shape in references/worklog.md, whichever fix direction is
# chosen) against the real wildmatch v2.6.1 crate for both quoted-path and
# unquoted-path append commands of the same functional shape, and confirm
# both are admitted (allow=true). Then re-run a live scheduled email-triage
# tick and confirm the worklog-append step is admitted on its first
# attempt, without needing the agent to retry with a different shell
# rendering.
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
Reproduction status:
- Confirmed: pinned `wildmatch` 2.6.1 matches the existing rule for an unquoted redirect but not `>> "worklog/$TODAY.md"`.

Evidence captured:
- `policy-control` delegates patterns directly to `WildMatch`; its 45-test suite passed. Both shipped rule copies use `*>> worklog/*.md*`, which requires the literal contiguous text `>> worklog/`.
- The worklog guidance permits generic append forms and prescribes no one admitted rendering, allowing the live agent to choose the denied quoted heredoc shape.

Isolated fault:
- Documentation/policy contract mismatch between the duplicated S-004 worklog rule and `email-triage` worklog guidance; it is not a policy-control matcher defect.

Root cause or fault hypothesis:
- Literal matching correctly treats the quote between `>> ` and `worklog/` as a mismatch. Under-specified skill guidance made that safe but unadmitted form a legitimate first choice.

Planned fix:
- Preserve the narrow policy surface and prescribe a canonical cwd-relative unquoted `>> worklog/<date>.md` append form in the email-triage worklog guidance, rather than broadening sandbox permissions.

Planned verification:
- Add/update regression coverage against the pinned matcher showing the canonical form is admitted and the quoted form is not; verify guidance explicitly requires the canonical form, then confirm an email-triage run appends on its first attempt.

Obstacles encountered:
- A scratch Cargo repro could not access crates.io in the sandbox; a local harness linked to the already-built pinned wildmatch artifact supplied the matching evidence.

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-09

Implemented the diagnosis-prescribed, guidance-layer fix in `references/worklog.md` (commit `1d7241b`). The document now supplies an exact `cat >> worklog/$TODAY.md <<EOF` append shape and explains why the cwd-relative redirect target must be unquoted: the existing narrowly scoped S-004 rule matches the literal `>> worklog/` substring. The documented `date +%F` value makes that unquoted filename safe.

The policy rule was deliberately not widened, avoiding any expansion of the action-authorization surface. Existing `cargo test -p policy-control` verification passed (45 tests); the diagnosis’s pinned-wildmatch reproduction confirms the prescribed command is admitted while the quoted variant remains outside policy. A full live scheduled tick remains the operational follow-up.

Obstacles Encountered: None during the documentation change. An unrelated untracked `pr-42-review.md` remains untouched.

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

- Diagnosis chain passed: pinned wildmatch evidence demonstrates that the existing literal rule admits the canonical unquoted form and correctly rejects the quoted form; the fault is guidance/policy contract mismatch, not runtime authorization.
- Bug criteria passed: `references/worklog.md` now prescribes `>> worklog/$TODAY.md`, explains the relevant narrow rule boundary and why `date +%F` makes that unquoted filename safe. No S-004 rule was broadened.
- Quality and verification passed: the source diff is limited to guidance required by the diagnosis, with no unrelated changes; `cargo test -p policy-control` passed 45 tests. A full live scheduled run remains operational confirmation, not a reason to expand the safe policy surface.

Next owner: Bug-Fix Loop.

Obstacles Encountered: None. The unrelated `pr-42-review.md` remains unmodified.
