---
id: T-147
title: Replace the maintainer real address in the himalaya command reference
status: pending
priority: high
assigned-role: developer
created: '2026-08-07'
---

# Replace the maintainer real address in the himalaya command reference

## Description

The `himalaya` skill's command reference contains a maintainer's real personal
email address in two command transcripts — currently around lines 266 and 326,
both rendering as a `From:` header with a display name and that address. One
predates T-142; the second was added by it, which reproduced the existing
pattern rather than sanitising it.

Replace both with a clearly non-routable example address. The shipped
configuration template in this package already states that examples must never
carry a real address; the same rule applies to transcripts. This matters more
once the package is published to vendor marketplaces, where these transcripts
ship to consumers.

Use a reserved, obviously-fake domain (for example one under `.invalid`) and a
display name that reads as a placeholder. Keep the transcripts' structure
byte-identical apart from the address and display name — their value is that
they show the exact output shape, including the trailing angle brackets the
address is parsed out of.

Do not change any command, flag, or explanatory prose in this file.

## Acceptance Criteria

AC-1: The system shall contain no routable email address in the `himalaya`
      skill's shipped content.

AC-2: The system shall preserve the `From: <display name> <address>` output
      shape in both transcripts, so the documented parse rule still applies.

AC-3: The system shall leave every documented command, flag, and explanatory
      sentence in the file unchanged.

## Dependencies

- None. This file is not touched by any other pending task.

## Files to Touch

- `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`
  — replace the address and display name in both transcripts

## Verification

```bash
cd the-intern/email-skills/.pi/skills/himalaya

# AC-1 — expect no output (no real domains anywhere in the skill):
grep -rnE '[A-Za-z0-9._%+-]+@(aurorafw\.com|gmail\.com|outlook\.com|proton\.me)' .

# AC-2 — expect two From: lines, both with an angle-bracketed address:
grep -nE '^From: .+ <[^>]+>' references/command-reference.md

# AC-3 — expect the diff to touch only the two address lines:
git diff --stat -- references/command-reference.md
```

## Work Log

## Review
