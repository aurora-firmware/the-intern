---
id: T-149
title: Add allow rules for the missing-config escalation and self-escalation 
  filing paths
status: pending
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

## Review
