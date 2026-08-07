---
id: T-148
title: Replace the maintainer account name in the himalaya account list 
  transcript
status: pending
priority: high
assigned-role: developer
created: '2026-08-07'
---

# Replace the maintainer account name in the himalaya account list transcript

## Description

The `himalaya` skill's command reference contains the maintainer's real personal
account name in one command transcript — currently line 460, the `himalaya
account list` output table, rendering as `| daneel | IMAP, SMTP | yes     |`.

T-147 replaced the maintainer's real email *address* in two `From:` transcripts
in this same file, but its acceptance criteria were scoped to routable email
addresses, so this account name fell outside them. It is the same underlying
concern: a real personal identifier shipped to consumers. This matters once the
package is published to vendor marketplaces, where these transcripts ship.

Replace `daneel` with `my_user` in that table row.

Keep the transcript's structure byte-identical apart from the account name —
including the table's column alignment, which is padded with spaces. `my_user`
is two characters longer than `daneel`, so the row's padding must be adjusted so
the table's columns still line up with the header and separator rows. The
transcript's value is that it shows the exact output shape.

Do not change any command, flag, or explanatory prose in this file.

## Acceptance Criteria

AC-1: The system shall contain no occurrence of the maintainer's real account
      name in the `himalaya` skill's shipped content.

AC-2: The system shall render the `himalaya account list` transcript as a
      well-formed table whose column boundaries align across the header,
      separator, and data rows.

AC-3: The system shall leave every documented command, flag, and explanatory
      sentence in the file unchanged.

## Dependencies

- None. T-147 is already completed and merged; this task touches a different
  line of the same file.

## Files to Touch

- `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`
  — replace the account name in the `account list` transcript

## Verification

```bash
cd the-intern/email-skills/.pi/skills/himalaya

# AC-1 — expect no output:
grep -rniE 'daneel' .

# AC-2 — expect the replacement present in the table:
grep -n 'my_user' references/command-reference.md

# AC-3 — expect the diff to touch only the one table row:
git diff --stat -- references/command-reference.md
```

## Work Log

## Review
