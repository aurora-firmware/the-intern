---
id: B-029
title: direct-request and meeting-scheduling reply categories have no S-004 
  allow-rule and were never live-validated
severity: high
status: in-progress
created: '2026-08-04'
task: T-139
---

# direct-request and meeting-scheduling reply categories have no S-004 allow-rule and were never live-validated

## Summary

The `email-triage` skill's `direct-request` and `meeting-scheduling`
categories both require sending a reply via `himalaya template reply` ->
`himalaya template send`, but neither the operator-guide's nor the package
README's S-004 action-rule lists include an allow-rule matching that command
shape — only the escalation-send rule is present. An operator who deploys
exactly per the shipped documentation gets these two categories permanently
denied by S-004's default-deny, silently diverging from the behavior
`SKILL.md`, `direct-request.md`, and `meeting-scheduling.md` describe.
Discovered during PR #42 review (`pr-42-review.md`, finding 2).

## Reproduction Status

Status: confirmed

Confirmed by static inspection, not live reproduction: neither
`the-intern/docs/src/operator-guide/index.md` (the "Add scoped S-004 action
rules for the deployed workspace" section) nor
`the-intern/email-skills/README.md` ("Verified S-004 action rules for the
happy path") contains any `bash` rule matching a `himalaya template
reply`/`template send` command shape. The only `template`-related rule
either document ships is the escalation-send rule
(`operator-guide/index.md`, pattern `"himalaya template write -H *To:* -H
*Subject:Escalation:* *| himalaya template send*"`).

This is corroborated by T-139's own Work Log, Session 2: "The direct-request
route was rejected because it required recurring outbound mail
authorization. A safe automated-notification route [was used instead]." The
team substituted `automated-notification` (a no-reply, file-only category)
for the happy-path validation and never returned to add the missing rule or
validate `direct-request`/`meeting-scheduling`. T-140 covered only
escalation, S-004-block, and skipped-tick continuity — not this path either.

## Evidence

- Logs / stack traces / failing assertions: none (documentation-completeness
  gap, not a code assertion failure)
- Screenshots or recordings: n/a
- Failing command or test: n/a — the gap is an absent policy rule, not a
  failing test
- First diagnostic step if not yet reproduced: n/a (already confirmed by
  inspection, see Reproduction Status)

## Reproduction Steps

1. Deploy the `email-skills` package to a workspace exactly per
   `the-intern/docs/src/operator-guide/index.md`'s "Deploying the
   email-triage scheduled job" section, adding only the S-004 rules listed
   there.
2. Place an unseen test message in the mailbox that the taxonomy classifies
   confidently as `direct-request` or `meeting-scheduling`.
3. Let the scheduled job run.
4. Observe: the `himalaya template send "$(himalaya template reply ...)"`
   call is denied by S-004 (no allow-rule matches it), so the reply is never
   sent; the run instead records a blocked open worklog item.

## Expected Behavior

Per `SKILL.md` and the category workflow docs, a confident `direct-request`
or `meeting-scheduling` match should result in exactly one reply being sent
to the sender, and this should be achievable by following the operator
guide's documented deployment steps end to end (as `automated-notification`
and escalation already are).

## Actual Behavior

Following the operator guide's deployment steps exactly leaves
`direct-request` and `meeting-scheduling` replies permanently blocked by
S-004's default-deny, because no shipped rule set admits the
`template reply`/`template send` command shape. The message is instead
recorded as a blocked open worklog item every run, with no indication in the
docs that this is expected or that additional configuration is required.

## Environment

- OS / platform: n/a (documentation/configuration gap, reproducible on any
  platform matching the operator guide's prerequisites)
- Language / runtime version: n/a
- Relevant dependencies: `bob` S-004 policy-control action gate, `himalaya`
  CLI, deployed `email-skills` package per PR #42
- Branch / commit: `dev-agent` (PR aurora-firmware/the-intern#42, head
  `ec1fbfed51175ded359e02019ccac1a739bbbe49` at time of filing)

## Related

- Task: `T-139` (happy-path validation — explicitly skipped direct-request),
  `T-140` (escalation/block/continuity validation — did not cover this
  path), `T-141` (operator guide — ships the incomplete rule list)
- Specification: `S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md`
- Bug: `B-030` — cross-linked. A separate review finding identified that the
  `template reply`/`template forward` command shape this bug's fix will need
  a rule for was, until `B-030`'s fix, vulnerable to command injection from
  untrusted email content (naive literal-text splicing into shell arguments,
  no escaping). `B-030` established a safe heredoc-based pattern for this
  exact command family in
  `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`'s
  "Embedding message-derived text safely" section. **Whoever resolves this
  bug must build the new `direct-request`/`meeting-scheduling` S-004 rule
  against that hardened pattern** (`"$SUBJECT"`/`"$BODY"` loaded via quoted
  heredoc, `--` before the body argument) — not against the vulnerable
  pattern that existed in the docs before `B-030`'s fix. Both bugs
  ultimately need the same kind of live T-139/T-140-style validation pass.
- Bug: `B-031` — filed at review time to track this bug's own outstanding
  live end-to-end validation (see Fix Verification below) as a separate,
  tracked follow-up, the same way `B-030` already tracks the live-validation
  gap for the hardened escalation-send shape. The rule fix in this bug is
  statically verified (real `wildmatch` crate, real config parser) but has
  not been run against a live mailbox and scheduled `bob` instance.

## Suspected Area

`the-intern/docs/src/operator-guide/index.md` (S-004 action-rule list) and
`the-intern/email-skills/README.md` ("Verified S-004 action rules for the
happy path") — both need an additional, live-validated `bash` allow-rule for
the reply-send command shape, plus live validation of the
`direct-request`/`meeting-scheduling` paths analogous to T-139/T-140.

## Fix Verification

```bash
# Deploy per the (updated) operator guide, feed the scheduled job a message
# that confidently classifies as direct-request (or meeting-scheduling),
# and confirm the reply is actually sent (not blocked) and recorded as such
# in the worklog — the same live-validation shape T-139/T-140 used for the
# other paths.
```

## Diagnosis Log

### Diagnosis 1 — 2026-08-04

Reproduction status: confirmed, by static inspection of the current `dev-agent`
docs (not live reproduction). The shipped `the-intern/docs/src/operator-guide/index.md`
(Step 4 of "Deploying the email-triage scheduled job," lines 796-963) and
`the-intern/email-skills/README.md` ("Verified S-004 action rules for the happy
path," lines 130-298) both ship the identical S-004 `[[policy.action_rules]]`
list covering only `automated-notification`, escalation (hardened per B-030),
S-004-block handling, and skipped-tick continuity. Both files' own prose
(introduced by B-030's commit `af5132a`) states outright: "it does not include
an allow-rule for the `himalaya template reply` -> `himalaya template send`
command shape that the `direct-request` and `meeting-scheduling` categories
use... tracked as `B-029` and not yet done." Live infra (`pi`, a configured
`himalaya` IMAP/SMTP account, and a built `bob` 0.1.0 debug binary) is present
in this environment, but a full live deployment/cron-tick/mailbox pass was not
run in this diagnosis session — a single before/after run (old rule set denies,
new rule set admits) is deferred to the implementation cycle so it can be done
once the fix exists, mirroring the T-139/B-030 methodology.

Evidence captured:
- `the-intern/docs/src/operator-guide/index.md:796-963` and
  `the-intern/email-skills/README.md:130-298` — full S-004 rule lists plus
  explicit self-documented gap acknowledgment citing `B-029` by name
  (`grep -n "B-029"` hits at README.md:285,298 and index.md:948,963).
- `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md:200-231`
  ("Replying") and `:142-196` ("Embedding message-derived text safely," the
  B-030 hardened heredoc pattern) — confirms the exact required command shape:
  `himalaya template send "$(himalaya template reply <ID> [-A] -- "$BODY")"`,
  `$BODY` loaded via a quoted heredoc (`<<'TOKEN'`), never bare.
- `the-intern/email-skills/.pi/skills/himalaya/SKILL.md:76` — Operation Index
  confirms "Reply to a message" maps to that same shape.
- `the-intern/email-skills/.pi/skills/email-triage/references/categories/direct-request.md`
  and `meeting-scheduling.md` — both confirm a confident match sends a reply
  via the himalaya skill's reply operation and both independently define the
  S-004-block fallback (record as open worklog item, do not treat as
  handled), matching the bug's Actual Behavior.
- `git show af5132a --stat` — confirms B-030's fix commit is what introduced
  the explicit "tracked as B-029" callouts into both files while replacing
  the escalation rule with the hardened shape, without adding a reply-send
  rule (correctly out of that commit's scope).
- `the-intern/service/crates/policy-control/src/matcher.rs` — confirmed
  runtime semantics: `WildMatch::new(&pattern).matches(arguments.command)`,
  allow-only (absent tool/pattern is denied), consistent with the documented
  default-deny model.
- Scratchpad-only Rust harness (not part of the repo) reproducing that exact
  matcher call against the real vendored `wildmatch = 2.6.1` crate (same
  version pinned in `the-intern/service/Cargo.lock`). Result: 7/7 checks
  passed — candidate pattern
  `BODY=$(cat <<'*himalaya template send "$(himalaya template reply *-- "$BODY")"*`
  matches the safe plain and `-A` (reply-all) shapes, and correctly rejects
  an unquoted-heredoc bypass, a bare/unquoted `$BODY` regression, a
  missing-`--` variant, and the pre-B-030-style naive literal-splice shape.
  Also confirmed this wildmatch version's `*` spans embedded newlines
  (load-bearing for any multi-line heredoc rule, matching the property the
  shipped escalation rule already depends on).

Isolated fault: `the-intern/docs/src/operator-guide/index.md`'s Step 4
`[[policy.action_rules]]` list and `the-intern/email-skills/README.md`'s
"Verified S-004 action rules for the happy path" list — both are missing a
`tool = "bash"` allow-rule with `field_path = "command"` admitting the
`himalaya template reply <ID> [-A] -- "$BODY"` -> `himalaya template send
"$(...)"` command shape. This is a documentation/deployment-configuration
completeness gap, not a defect in `bob`'s policy-engine code (`matcher.rs`'s
glob matching behaves correctly against a well-formed rule, per the wildmatch
harness above).

Root cause or fault hypothesis: T-139's live happy-path validation substituted
`automated-notification` for `direct-request` specifically because
`direct-request` "required recurring outbound mail authorization" (T-139 Work
Log, Session 2), and the team never returned to add the missing rule or
validate `direct-request`/`meeting-scheduling`. T-140 covered only
escalation/block/continuity. B-030's later fix touched the same rule lists to
harden the escalation shape and correctly flagged (in prose, in both files)
that this exact gap remained unresolved, but scoped adding the reply-send
rule to this bug (`B-029`) rather than fixing it inline.

Planned verification:
1. Add one new `[[policy.action_rules]]` `tool = "bash"` entry to both
   `the-intern/docs/src/operator-guide/index.md` (Step 4's rule list, using
   that file's `/srv/workspaces/email-skills`-style path convention where
   relevant) and `the-intern/email-skills/README.md` ("Verified S-004 action
   rules for the happy path," using that file's `/abs/workspace` convention),
   with `field_path = "command"` and a pattern built on the validated
   candidate above, admitting the `himalaya template reply <ID> [-A] --
   "$BODY"` piped through `template send` command-substitution shape — built
   on B-030's hardened heredoc pattern, not the pre-B-030 literal-splicing
   shape, per this bug's explicit cross-link requirement.
2. Update the now-stale "does not include a rule... tracked as B-029 and not
   yet done" prose callouts in both files (index.md ~938-949, README.md
   ~277-286) to reflect that the rule now exists, while still noting (mirroring
   B-030's own framing) that the rule/pattern has been checked against the
   real `wildmatch` crate and representative command strings.
3. No `bob` source code changes are required — this is a docs-only fix; the
   policy engine already behaves correctly against a well-formed rule.
4. Static verification: re-run the wildmatch harness (or an equivalent check
   performed during the TDD cycle) against the exact pattern text as it will
   appear in both files, confirming it matches the intended safe shape and
   rejects the same unsafe variants already checked, and confirming the two
   files' new rule blocks and updated prose stay consistent with each other.
5. Live verification (this bug's own Fix Verification): deploy per the
   updated operator guide, feed the scheduled job a message that confidently
   classifies as `direct-request` (or `meeting-scheduling`), and confirm the
   reply is actually sent (not blocked) and recorded as such in the worklog —
   the same live-validation shape T-139/T-140 used. `pi`, a configured
   `himalaya` account, and a `bob` debug binary are present in this
   environment, so this pass should be attempted directly in the
   implementation cycle if time allows, rather than deferred to a separate
   follow-on bug.

## Work Log

### Session 1 — 2026-08-04

Implemented the fix from the Diagnosis Log without needing to revisit
reproduction or root cause — both were already fully established. Added one
new `tool = "bash"` action rule to both
`the-intern/docs/src/operator-guide/index.md` and
`the-intern/email-skills/README.md`, matching the `himalaya template reply`
-> `himalaya template send` command shape via B-030's hardened heredoc
embedding pattern (`"$BODY"` loaded through a quoted heredoc, `--` before the
body argument). Placed it immediately before the escalation rule in both
files' `[[policy.action_rules]]` lists, mirroring the SKILL.md act-then-escalate
workflow order.

Before writing the docs, I built and ran a throwaway verification harness.
First a standalone Cargo scratch project pinned to `wildmatch = 2.6.1` (the
exact version in `Cargo.lock`) to sanity-check the candidate glob against
hand-built safe/unsafe command strings. Then, for stronger fidelity, I wrote
a temporary integration test directly in `policy-control`
(`tests/tmp_b029_verify.rs`) that writes the actual TOML rule text to a temp
file, parses it through `load_policy_config_from_file` — the exact function
`bob policy reload` uses — and calls the real `ArgMatcher::matches`. Both
confirmed the pattern matches the intended safe plain-reply and `-A`
reply-all shapes (including one where the message body itself contains
adversarial shell metacharacters, since those are inert inside the quoted
heredoc) and correctly rejects an unquoted-heredoc bypass, a bare/unquoted
`$BODY` regression, a missing-`--` variant, and the pre-B-030 naive
literal-splice shape. Deleted the temp test file immediately after
(`git status` confirmed clean) since the diagnosis was explicit that no
`bob` source changes are needed for this bug — I did not want to leave any
source-tree footprint from an exploratory verification step.

I considered adding a permanent regression test to `policy-control` that
reads the shipped docs file and asserts the rule still matches, to guard
against future doc edits silently breaking the pattern. I rejected this for
now: there's no existing precedent in this repo for tests that read markdown
docs content (B-030's own fix shipped with no tests either), and it would
expand this bug's file footprint beyond the two docs files the diagnosis
scoped it to. If the team wants durable regression coverage for these S-004
doc-shipped patterns going forward, that would be a reasonable follow-up
task, not part of this bug.

I updated the stale "does not include... tracked as B-029 and not yet done"
callouts in both files to state the rule now exists, describe what it was
checked against (real `wildmatch` crate, both safe and unsafe shapes), and —
importantly — to be explicit that the live end-to-end pass (actually
deploying and sending a reply) has not been done, so nobody reads the doc
update as claiming full live validation.

I deliberately did not attempt the live Fix Verification pass this session.
The diagnosis found `pi`, a configured `himalaya` account, and a built `bob`
binary present, and it's true they're all there — I confirmed the same. But
that account is a real IMAP/SMTP mailbox (`daneel@aurorafw.com` via a real
hosting relay, `lin119.loading.es`), and actually running the scheduled job
live means composing and sending a real outbound email over the internet,
potentially interacting with whatever unseen mail is currently sitting in
that mailbox. That's a materially different kind of action from editing
files, and the diagnosis itself anticipated this exact judgment call,
explicitly permitting me to stop and document the gap rather than force it.
I made that call rather than attempt a live SMTP send autonomously as part
of a docs-fix task.

What remains: the bug's own Fix Verification criterion (deploy, feed a
`direct-request`/`meeting-scheduling` message, confirm the reply is actually
sent and recorded) is still open. The docs and static verification are
complete and solid — the next session (or a human-supervised pass) should
perform the live E2E validation, likely following the same
deployed-workspace-under-`/tmp` pattern T-139/T-140/B-030 used, and record
the outcome. If that pass isn't done before this bug is otherwise closed,
recommend spinning it out as its own tracked follow-up bug, the same way
B-030 now tracks the escalation shape's live-validation gap.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-05

PASS

**Diagnosis→fix evidence chain.** The Diagnosis Log (Diagnosis 1, 2026-08-04)
records reproduction status (confirmed by static inspection), evidence
captured (line-level citations into `operator-guide/index.md`,
`email-skills/README.md`, `command-reference.md`, `SKILL.md`,
`direct-request.md`/`meeting-scheduling.md`, `matcher.rs`, and a scratchpad
wildmatch harness), an isolated fault (both docs' S-004 rule lists missing
the `template reply`/`template send` allow-rule), and a root-cause hypothesis
(T-139's deferral of `direct-request`, never revisited; B-030's fix correctly
scoped adding this rule to this bug rather than fixing it inline). Complete
fix contract present — evidence chain check passes.

**Stage 1 — bug criteria.** Verified the diff directly
(`git diff dev-agent...HEAD -- the-intern/docs/src/operator-guide/index.md
the-intern/email-skills/README.md`, bug branch
`bug/B-029-direct-request-and-meeting-scheduling-reply-categories-have-no-s-004-allow-rule-and-were-never-live-validated`).
Both files gained an identical new `[[policy.action_rules]]` `tool = "bash"`
entry with `field_path = "command"` and pattern
`BODY=$(cat <<'*himalaya template send "$(himalaya template reply *-- "$BODY")"*`,
placed immediately before the escalation rule as the Work Log states. This
is the isolated fault from the Diagnosis Log, addressed directly — no
unrelated behavior added, no unexpected files touched (`git diff
dev-agent...HEAD --stat` shows only the two docs files, 40/37 lines
changed; `git status` on the bug branch is clean, no stray temp-file
artifacts).

**Pattern correctness — independently re-verified.** The Work Log's claim
(checked via a deleted, uncommitted integration test against the real
`wildmatch` crate and `load_policy_config_from_file`) was material, so I
re-verified it independently rather than taking it on faith: wrote a fresh
temporary integration test in `policy-control/tests/` loading the exact
TOML pattern text as it appears in both shipped docs files through the real
`load_policy_config_from_file` parser and the real `ArgMatcher::matches`
(`wildmatch = "2.6.1"`, confirmed pinned in `Cargo.lock`, matching the
Diagnosis Log's claim), then deleted it after
(`git status` clean before and after). All 8 checks passed: admits the safe
plain-reply and `-A` reply-all shapes, including one where the
message-derived body itself contains adversarial shell metacharacters
embedded inside the quoted heredoc; correctly rejects an unquoted-heredoc
bypass, a bare/unquoted `$BODY` regression, a missing-`--` variant, the
pre-`B-030` naive literal-splice shape, and an unrelated command. This also
directly confirms the specific claim that this wildmatch version's `*`
spans embedded newlines (load-bearing for the multi-line heredoc pattern) —
my test command strings contained real embedded newlines and matched
correctly via the real matcher path. Manual reasoning over the pattern's
literal/wildcard segmentation independently supports the same conclusions:
the pattern is unanchored-by-wildcard only at both ends and around the two
literal anchors (`BODY=$(cat <<'` at the start, `-- "$BODY")"` before the
trailing `*`), so any variant missing the quoted-heredoc opener or the
`-- "$BODY")"` closing shape fails to match.

**Docs quality and consistency.** The two files' new rule blocks are
character-identical (aside from each file's own pre-existing indentation
convention). The updated prose in both files consistently: (a) states the
rule now exists and is built on B-030's hardened heredoc pattern, (b)
describes what it was checked against, (c) is explicit that the rule has
**not** been live-validated, so an operator reading either file cannot
mistake static verification for a live-validated guarantee. `cargo fmt --all
-- --check` passes (no Rust source changed on this branch, consistent with
the diagnosis's conclusion that no `bob` source changes were needed).

**Live Fix Verification — deferred, judged acceptable for this cycle.**
This bug's own Fix Verification step (deploy, feed the job a
`direct-request`/`meeting-scheduling` message, confirm the reply is
actually sent and recorded) was not attempted. The Work Log's rationale is
specific and well-reasoned, not a corner-cut: it requires composing and
sending a real outbound email over a live SMTP relay from a real configured
mailbox (`daneel@aurorafw.com`), a materially less reversible action than
editing files, and the Diagnosis Log's own Planned Verification step 5
already anticipated this exact judgment call as legitimate ("this pass
should be attempted directly in the implementation cycle **if time
allows**"). This is not a novel exception — it is the identical judgment
call already made for `B-030` (the hardened escalation-send fix, `af5132a`,
landed on `dev-agent` with its own live-validation gap tracked separately
rather than blocking the fix). Following that precedent rather than
diverging from it, I filed `B-031` (`docs/ai-team/bugs/open/B-031-...md`)
to track this bug's own outstanding live end-to-end validation as a
separate, explicitly tracked follow-up, and added a cross-link to it in
this bug's Related section. This keeps the requirement from silently
evaporating while not blocking the (correctly scoped, independently
verified) rule fix on an unsupervised live email send.

Minor observation (non-blocking): consider, as a future durable-coverage
task (already flagged as out of scope by the Work Log, and I agree it's out
of scope for this bug), adding a `policy-control` regression test that
reads these shipped docs' rule patterns and asserts they still match the
intended command shapes, so a future docs edit can't silently break the
pattern without a red test.

Next owner: Bug-Fix Loop — merge the bug branch, move `B-029` to
`resolved/`, keep `B-031` open in `bugs/open/` to track the live-validation
follow-up.
