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

## Review
