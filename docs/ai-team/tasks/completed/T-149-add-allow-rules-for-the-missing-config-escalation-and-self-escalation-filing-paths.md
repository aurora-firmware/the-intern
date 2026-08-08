---
id: T-149
title: Add allow rules for the missing-config escalation and self-escalation 
  filing paths
status: completed
priority: high
assigned-role: developer
created: '2026-08-07'
---

# Add allow rules for the missing-config escalation and self-escalation filing paths

## Description

T-143 and T-146 landed two new behaviours that the shipped action-rule set does
not admit, so neither can execute in a deployed system:

1. **The missing-configuration escalation fallback** (T-143) obtains the mail
   account's own address from the `From:` header of `himalaya template write`
   invoked with **no arguments**. The only existing `template write` rule
   requires the full escalation pipeline shape (`SUBJECT=$(cat <<'…` prefix,
   `-H To:`, `Subject:Escalation:`, piped to `template send`). A bare
   invocation matches none of the 13 `bash` rules and is denied.
2. **The self-escalation category** (T-146) files its message by moving it out
   of `INBOX` into an `Escalations` folder. The only move rule is hardcoded to
   `INBOX.Notifications` and does not admit it.

Both fail safe — denied means recorded as a blocked worklog item, never an
autonomous action — but the specified behaviour never runs. CR-006 item 5
asserted this path "needs no new allow-rule family"; that assumption was wrong,
and S-010 was corrected on 2026-08-07 to state that an admitting allow rule is
a deployment prerequisite like every other himalaya invocation.

**The first rule's pattern is a safety decision, not a formatting one.** It must
match the bare invocation *only*. A trailing wildcard (`himalaya template
write*`) would admit `himalaya template write -H "To:anyone@example.com" … |
himalaya template send` — arbitrary outbound email under an escalation-shaped
rule. Use an exact pattern with no trailing wildcard. Matching too narrowly
fails safe; matching too widely does not.

The rule set is duplicated verbatim in two files and both must stay identical
apart from the workspace path prefix each uses.

## Acceptance Criteria

AC-1: The system shall admit `himalaya template write` invoked with no
      arguments.

AC-2: The system shall NOT admit any `himalaya template write` invocation
      carrying arguments by way of the rule added for AC-1.

AC-3: The system shall admit moving a message into the `Escalations` folder,
      in the same pattern shape as the existing `INBOX.Notifications` move
      rule.

AC-4: The system shall present the same action-rule set in the operator guide
      and the package README, differing only in the workspace path prefix.

AC-5: The system shall leave every pre-existing action rule unchanged.

## Dependencies

- None. T-143 and T-146 are completed and merged; this task adds the policy-side
  rules their behaviour requires.

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — add the two rules to the
  action-rule set (workspace prefix `/srv/workspaces/email-skills`)
- `the-intern/email-skills/README.md` — mirror the same two rules (workspace
  prefix `/abs/workspace`)

## Verification

```bash
# AC-1/AC-3 — expect the two new patterns in BOTH files (2 hits each):
grep -rn 'himalaya template write"' \
  the-intern/docs/src/operator-guide/index.md the-intern/email-skills/README.md
grep -rn 'message move\*Escalations' \
  the-intern/docs/src/operator-guide/index.md the-intern/email-skills/README.md

# AC-2 — expect NO output (no trailing wildcard on the bare-write rule):
grep -rn 'himalaya template write\*' \
  the-intern/docs/src/operator-guide/index.md the-intern/email-skills/README.md

# AC-4 — expect identical rule sets once the path prefix is normalised:
diff <(grep -o 'pattern = "[^"]*"' the-intern/docs/src/operator-guide/index.md \
        | sed 's|/srv/workspaces/email-skills|WS|') \
     <(grep -o 'pattern = "[^"]*"' the-intern/email-skills/README.md \
        | sed 's|/abs/workspace|WS|') && echo "rule sets match"
```

## Work Log

### Session 1 — 2026-08-07

Picked up T-149 (empty Work Log, first session). Read the task file, the two target
files' existing action-rule sets, and the two skill references named in the task brief
(`escalation.md` for the bare `himalaya template write` shape, `self-escalation.md` for
the `Escalations` move) plus the `himalaya` skill's `command-reference.md`, which
confirmed both command shapes precisely: `himalaya template write` invoked with
literally nothing after it (the Observed transcript shows `$ himalaya template write`
with no trailing text), and `himalaya message move <TARGET> <ID>...` where `<TARGET>`
for this category is `Escalations`.

Established the red state first by running the task's own Verification block before
touching anything: the two new-pattern greps returned nothing, and the AC-4 diff
trivially matched (nothing added on either side yet).

Before writing the rules, confirmed the runtime matcher dialect by reading
`the-intern/service/crates/policy-control/src/matcher.rs` directly (it uses
`wildmatch::WildMatch` from the crate pinned to `2.6.1` in
`the-intern/service/Cargo.lock`, and its own test suite documents `*` = any run,
`?` = one char, no `*` = literal). Then wrote a small standalone Rust program in the
scratchpad (not part of the repo) depending on the exact same `wildmatch = "2.6.1"`,
and ran it to check the two candidate patterns against both intended and adversarial
command strings. The bare pattern `"himalaya template write"` (no trailing wildcard)
matched only the literal no-argument invocation and rejected every variant carrying
arguments, including the full pipe-to-`template send` shape the task explicitly warns
against. The move pattern `"himalaya*message move*Escalations*"`, mirroring the
existing `INBOX.Notifications` rule's shape, matched realistic move invocations and did
not cross-match the other rule's target in either direction. The bare-write pattern was
not widened in any way — an exact pattern with no trailing wildcard is correct here,
and it was verified to actually admit the real invocation rather than assumed to.

Added both rules identically to `the-intern/docs/src/operator-guide/index.md` (3-space
list-item indent) and `the-intern/email-skills/README.md` (no indent) — neither new
rule references a workspace path, so no prefix substitution was needed. Placed each
next to the rule it most relates to: the `Escalations` move rule immediately after the
existing `INBOX.Notifications` move rule, and the bare `template write` rule
immediately after the full escalation-pipeline rule that also invokes `template write`.
Re-ran the verification block: AC-1/AC-3 each showed one hit per file, AC-2 still
showed no output, AC-4's diff still matched. Confirmed via `git diff` that every
pre-existing rule line was untouched (AC-5).

Added the requested operator-guide-only note explaining both new rules and, per the
task's explicit ask, that `Escalations` is a renameable starter default whose pattern
must match whatever folder name the real deployment uses. Ran a full `mdbook build`
over `the-intern/docs` to confirm the new paragraph renders cleanly (clean build, one
pre-existing unrelated mdbook-mermaid version warning). Cleaned up the scratch Rust
verification project afterward.

**Tried and rejected:** the first draft of the operator-guide note literally quoted the
dangerous pattern (bare-write plus a trailing wildcard) as a "do not do this"
counter-example. The task's AC-2 verification is a blunt substring grep for exactly
that string, so the explanatory prose tripped the check even though no rule used it.
Reworded to describe "appending a trailing `*`" without concatenating the literal
substring, which kept the explanation and cleared the check. Worth future authors
knowing: any prose in these two files that quotes the forbidden pattern literally, even
as a counter-example, will be caught by that substring-based verification.

**Remaining:** nothing outstanding against this task's acceptance criteria; all five
pass against the task's own Verification commands, run before and after the change. No
scope beyond the two listed files was touched.

Commits on `task/T-149-add-escalation-allow-rules`:

- `deeb820` feat(email-skills): admit bare template write and Escalations move
- `a97ee16` docs(email-skills): note the new rules and folder renaming

### Session 2 — 2026-08-07

Picked up review cycle 2 on `task/T-149-add-escalation-allow-rules`, which was clean at
its original two commits (`deeb820`, `a97ee16`) since the prior attempt had been
terminated by an infrastructure error before touching anything. Read the Review Verdict
on the canonical task file: FAIL, one blocking Stage 2 defect, all five acceptance
criteria independently confirmed PASS including AC-2's safety-critical wildmatch
behaviour. Per instructions, left both action rules themselves untouched.

Applied the single scoped fix in `the-intern/docs/src/operator-guide/index.md`:
reworded the opening sentence of the paragraph at line 993 to name the two paths in
plain behavioural language instead of citing internal task-tracker IDs, removing those
IDs from the shipped mdBook operator manual. Also re-flowed the following line break so
the bolded sentence and the `himalaya template write` code span read naturally
together; no wording beyond the opening sentence was changed. The rest of the paragraph
— the safety rationale for the exact `template write` pattern and the
`Escalations`-is-renameable note — was left byte-for-byte identical.

Deliberately did not touch the immediately preceding paragraph's pre-existing bug-ID
citation (line 991) — it predates this task and is out of scope. Confirmed via
`git diff deeb820~1 a97ee16` that this task's own two commits never modified that line,
so it is a true pre-existing issue, consistent with the Reviewer's note that the
`cbc0144` cleanup commit did not purge it (or it resurfaced afterwards, similar to the
`059cded` reintroduction the Reviewer separately flagged nearby).

Re-ran the task's full Verification block after the edit: AC-1/AC-3 patterns present
once per file as before, AC-2's trailing-wildcard grep returned no output (confirming
the safety-critical bare `template write` pattern still has no trailing `*`), AC-4's
normalised-pattern diff still reports "rule sets match", and AC-5's diff against the
pre-T-149 baseline still shows zero removed or modified pre-existing rule lines. Ran
`mdbook build` over `the-intern/docs` — clean build (only an unrelated mdbook-mermaid
preprocessor version-mismatch warning) — and grepped the generated HTML to confirm the
reworded paragraph renders correctly with no task-ID text.

**Tried and rejected:** considered fixing the neighbouring pre-existing citation while
in the same paragraph, since it is one line away and the same class of defect. Rejected
— it is outside this task's Files-to-Touch intent and would widen a review-cycle fix
into unrelated cleanup. Reported for separate triage instead.

**Remaining:** nothing for this task. Separately, the shipped operator guide still
carries 13 artifact-ID citations in total; scoping their removal is a decision for the
human, since CR-006 item 1 covered skill content and exempted maintainer/operator
documentation, and it is not obvious the mdBook manual falls under that exemption.

Commits on `task/T-149-add-escalation-allow-rules`:

- `deeb820` feat(email-skills): admit bare template write and Escalations move
- `a97ee16` docs(email-skills): note the new rules and folder renaming
- `f05cb66` docs(email-skills): drop task-ID citation from operator guide prose

## Review

### Review Verdict — 2026-08-07

FAIL

Reviewed `task/T-149-add-escalation-allow-rules` at `deeb820` (rules) and `a97ee16`
(prose) against this task's five acceptance criteria and the code-review skill's
Stage 2 quality checklist.

**Stage 1 — Acceptance Criteria**

- **AC-1** (admit bare `himalaya template write`) — PASS. Both files add
  `{ field_path = "command", pattern = "himalaya template write" }`
  (`operator-guide/index.md:910`, `email-skills/README.md:249`). Confirmed this is
  the real invocation shape: `.pi/skills/himalaya/references/command-reference.md`
  ("Finding the Account's Own Address") shows `$ himalaya template write` (Observed,
  no arguments), and `references/escalation.md`'s missing-configuration fallback
  invokes exactly that.
- **AC-2** (must NOT admit any `template write` invocation carrying arguments) —
  PASS, independently verified rather than taken on the Developer's word. Confirmed
  `the-intern/service/crates/policy-control/src/matcher.rs` calls
  `wildmatch::WildMatch::new(&self.pattern).matches(s)`, and that `wildmatch = "2.6.1"`
  is the exact version pinned in `the-intern/service/Cargo.lock` — matches the
  Developer's claimed verification dependency. Read the pinned crate's own source
  (`wildmatch-2.6.1/src/lib.rs`): `matches()` is documented and implemented as a
  full-string anchored match ("Returns true only when `p` matches the entirety of
  `s`") — a literal, wildcard-free pattern cannot match an input with any trailing
  (or leading) characters. Built and ran a standalone harness against the exact
  pinned `wildmatch = "=2.6.1"` and confirmed: `"himalaya template write"` matches
  only the bare invocation and rejects the adversarial shape this task calls out
  (`himalaya template write -H "To:anyone@example.com" -- "body" | himalaya
  template send`), a trailing-space variant, a leading-space variant, and a
  `writex` variant. The Developer's verification claim is corroborated by an
  independent run against the real dependency, not just plausible on inspection.
- **AC-3** (admit the `Escalations` move, same pattern shape as `INBOX.Notifications`)
  — PASS. `{ field_path = "command", pattern = "himalaya*message move*Escalations*" }`
  mirrors `"himalaya*message move*INBOX.Notifications*"` exactly in shape. Confirmed
  against `.pi/skills/himalaya/references/command-reference.md` ("Moving and
  Copying": `himalaya message move <TARGET> <ID>...`, e.g. `himalaya message move
  Archive 42 43`) and `references/categories/self-escalation.md` ("File the message
  by moving it out of `INBOX` into an `Escalations` folder") that the pattern
  admits the real invocation shape — verified `himalaya message move Escalations 42
  43` matches against the pinned `wildmatch` crate.
- **AC-4** (identical rule sets apart from workspace prefix) — PASS. Ran this
  task's own AC-4 verification command against both files as committed: the
  path-normalised pattern diff produced `rule sets match`.
- **AC-5** (no pre-existing rule changed) — PASS. `git diff deeb820~1 a97ee16 --
  the-intern/docs/src/operator-guide/index.md` and the equivalent for
  `email-skills/README.md` show zero removed or modified lines in the rule
  set — additions only.

**Stage 2 — Code Quality**

One defect, blocking:

- **File/location**: `the-intern/docs/src/operator-guide/index.md`, line 993
  (added by `a97ee16`).
- **What is wrong**: the new paragraph opens with "**Two more rules admit paths
  T-143 and T-146 added.**", citing internal task-tracker IDs (`T-143`, `T-146`) in
  the shipped mdBook operator manual — the exact artifact `deploy.yml` attaches to
  every GitHub Release. This is the same class of reference commit `cbc0144`
  ("docs: remove internal spec/ADR/task ID references from user docs") already
  purged from this exact file, for the same reason CR-006 item 1 gives for skill
  content: "consumers have no access to this project's specifications, decision
  records, tasks, or bugs." CR-006 item 1's exemption is scoped explicitly to "the
  package README" (`the-intern/email-skills/README.md`) as "maintainer and
  operator documentation recording validation provenance" — it does not reach the
  mdBook manual, which is a distinct, more widely distributed artifact than either
  the package README or the skill content the agent consumes. This session's own
  T-143–T-146 batch (CR-006 item 1) removed exactly this class of reference from
  skill content; this new sentence reintroduces it into the one shipped file that
  already has a dedicated precedent commit against it. Ruling: this is a defect,
  not a stylistic nit — reword it.
  (Noted for context, not part of this defect and not something T-149 needs to
  fix: an earlier, unrelated commit `059cded` already reintroduced `T-139`/`T-140`/
  `B-029`/`B-030`/`S-004` references elsewhere in this same file after `cbc0144`'s
  cleanup. That is a pre-existing, out-of-scope issue — it is not license to add
  more.)
- **What should change**: reword the sentence to describe what the two rules admit
  in plain behavioral language, with no `T-NNN` citation — e.g. "Two more rules
  admit the missing-configuration escalation fallback and the self-escalation
  filing move." — consistent with how CR-006 item 1 required rewriting
  behaviorally-load-bearing references into plain language rather than deleting
  them outright. The rest of the paragraph (the safety rationale for the exact
  `template write` pattern, the `Escalations`-is-renameable note) cites no task
  IDs and can stand unchanged.

**Non-blocking observations** (do not block this task; recorded for the record):

1. Commit `deeb820` is typed `feat(email-skills): admit bare template write and
   Escalations move`. Both commits touch only the two markdown docs — no
   service/skill code changed. This repo's own history for the same class of
   change to these two files — adding a previously-missing action rule so
   already-specified behavior becomes admitted — has consistently used `fix`
   (`f303848 fix(email-triage): add S-004 rule for direct-request/
   meeting-scheduling reply-send`, `af5132a fix(email-triage): close command
   injection in escalation send`), not `feat`. `feat` is a valid type per
   `git-conventions` and this is not a hard-rule violation, but `fix(email-skills):
   ...` (or `docs(email-skills): ...`) would be more consistent with established
   precedent for this "unblock already-specified behavior" class of change. Both
   commit subjects are within the 72-character limit: `feat(email-skills): admit
   bare template write and Escalations move` is 66 chars; `docs(email-skills):
   note the new rules and folder renaming` is 58 chars.
2. The `Escalations` move rule (`"himalaya*message move*Escalations*"`) is exactly
   as loose as the `INBOX.Notifications` rule it mirrors: the surrounding `*`s mean
   the pattern isn't anchored to a whole-command boundary, so a command string that
   merely contains `message move` and `Escalations` as substrings anywhere
   (including after a `;`/`&&`/`|`) would also match. AC-3 explicitly requires
   mirroring `INBOX.Notifications`'s shape, so this is not a defect T-149
   introduced — it is a pre-existing weakness in the shape being mirrored,
   unrelated to the safety-critical `template write` rule (which is exact and does
   not share this problem). Worth a follow-up bug against the underlying move-rule
   shape if tighter anchoring is wanted; out of scope for this task.

Verdict: FAIL. Developer reworks the one Stage 2 defect (task-ID citation in the
operator-guide prose) and resubmits; nothing else needs to change.

### Review Verdict — 2026-08-07 (cycle 2)

PASS

Reviewed `task/T-149-add-escalation-allow-rules` at `f05cb66` against this task's five
acceptance criteria and the code-review skill's Stage 2 quality checklist, focused on the
one cycle-1 blocking defect (task-ID citation in operator-guide prose) and an independent
re-confirmation that the two action rules themselves are untouched.

**Fix verification**

- `git diff a97ee16 f05cb66` shows exactly one hunk in
  `the-intern/docs/src/operator-guide/index.md`: the paragraph's opening sentence changed
  from "**Two more rules admit paths T-143 and T-146 added.**" to "**Two more rules admit
  the missing-configuration escalation fallback and the self-escalation filing move.**",
  plus a line re-flow of the following clause ("The bare `himalaya template write` /
  rule is..."). 3 insertions, 2 deletions, one file. No other content changed.
- `grep -n 'T-143 and T-146'` against both shipped files returns no match (exit 1); the
  task-ID citation is gone from the shipped prose.
- Read the full paragraph as shipped (`the-intern/docs/src/operator-guide/index.md`,
  lines 993–1005): the AC-2 safety rationale ("Appending a trailing `*` to that pattern
  would also admit further arguments such as `-H "To:..." ... | himalaya template send`,
  i.e. arbitrary outbound email, so none was added") and the `Escalations`-is-renameable
  note ("`Escalations` is a starter default the skill's own reference treats as
  renameable, so update the pattern above to the folder name the deployment actually uses
  if it differs.") both survive byte-for-byte, confirmed by diffing against the cycle-1
  reviewed text — only the two lines shown in the commit diff above changed.
- `mdbook build` over `the-intern/docs` ran clean (only the pre-existing, unrelated
  mdbook-mermaid version-mismatch warning). Grepped the generated
  `book/operator-guide/index.html`: no `T-143 and T-146` text, and the reworded sentence
  ("missing-configuration escalation fallback and") renders correctly.
- `the-intern/email-skills/README.md` — untouched by `f05cb66` (commit stat: 1 file
  changed, `operator-guide/index.md` only). This matches Session 1's finding that neither
  rule references a workspace path in the README, so the README never carried the flagged
  sentence to begin with; the defect and its fix are both operator-guide-only, as
  expected.

**Action rules confirmed untouched (security-relevant)**

- `git diff a97ee16 f05cb66` and `git diff a97ee16 f05cb66 -- the-intern/email-skills/README.md`
  both confirm zero changes to either `[[policy.action_rules]]` block in either file —
  `f05cb66` is prose-only, exactly as the Developer reported.
- Independently reproduced `git diff deeb820~1 deeb820` and confirmed the two rules were
  added, unmodified since, in both files: `{ field_path = "command", pattern = "himalaya
  template write" }` (no trailing wildcard) and `{ field_path = "command", pattern =
  "himalaya*message move*Escalations*" }`.
- Diffed the full task branch against its merge-base with `dev-agent`
  (`git diff b251d81 f05cb66 -- the-intern/email-skills/README.md`): the entire cumulative
  change to the README across all three commits is exactly the two rule additions — no
  prose, no other edits. Confirms AC-4 (mirrored rule sets) and AC-5 (no pre-existing rule
  changed) hold across the full branch, not just the latest commit.

**Five acceptance criteria re-confirmed** (task's own Verification block, run on the
task branch at `f05cb66`):

- AC-1/AC-3: `grep -rn 'himalaya template write"'` and `grep -rn 'message
  move\*Escalations'` each return exactly one hit per file (`operator-guide/index.md`,
  `README.md`) — PASS.
- AC-2: `grep -rn 'himalaya template write\*'` returns no output (exit 1) — the
  safety-critical bare-write pattern still has no trailing wildcard — PASS.
- AC-4: the path-normalised pattern diff outputs "rule sets match" — PASS.
- AC-5: no removed/modified lines in either file's rule set relative to the merge-base —
  PASS.

Given cycle 1 already independently verified the `wildmatch` matching semantics for AC-2
against the pinned crate and confirmed no rule pattern differs between this review and
that one, re-running the grep-based checks (rather than re-deriving the matcher proof)
was the appropriate depth here — the rules are byte-for-byte identical to what cycle 1
already verified at the matcher level.

**Pre-existing citation left alone, as instructed**

- `B-029` at operator-guide/index.md:991 (a different paragraph, predating this task) is
  present and unchanged; confirmed via `git diff b251d81 f05cb66` that no commit on this
  branch ever touched that line. The Developer correctly declined to fix it in this
  review cycle — it's a separate, pre-existing defect outside T-149's Files-to-Touch
  scope, and folding it in here would have widened a scoped review-cycle fix into
  unrelated cleanup.

**Commit hygiene**

- `f05cb66` subject: `docs(email-skills): drop task-ID citation from operator guide
  prose` — 67 characters, within the 72-character limit. Type/scope/imperative-mood/
  no-period conventions followed, consistent with `a97ee16`'s scope.

**Observation for human triage (non-blocking, not a finding against this task)**

- The shipped operator guide (`the-intern/docs/src/operator-guide/index.md`) carries 13
  artifact-ID citation locations in total (counting `T-nnn`/`B-nnn`/`S-nnn`/`ADR-nnn`
  references by line, since some lines cite more than one ID together, e.g. `T-139` and
  `T-140` paired). This task introduced one (in `a97ee16`) and removed it again (in
  `f05cb66`), netting zero new citations. The remaining 12 are pre-existing (lines 748,
  796, 803, 957, 958, 961, 965, 969, 971, 985, 989, 1039) and out of T-149's scope —
  whether/how to remove them under CR-006 item 1 (which exempts "maintainer and operator
  documentation," a category the mdBook manual may or may not fall under) is a decision
  for the human, not something either review cycle should adjudicate unilaterally.

Verdict: PASS. Both stages pass. The sole cycle-1 blocking defect is resolved by a
minimal, prose-only commit that leaves both action rules, the rest of the paragraph's
substance, and the pre-existing `B-029` citation untouched.
