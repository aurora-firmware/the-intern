---
id: T-142
title: Reconcile the himalaya skill against the CLI's own help output
status: pending
priority: medium
assigned-role: developer
created: '2026-08-06'
---

# Reconcile the himalaya skill against the CLI's own help output

## Description

The `himalaya` skill is a CLI reference written by hand. Nothing has ever
checked its command shapes, flags, and subcommand names against the CLI that
actually ships, so it can drift silently — and because it is the reference the
triage skill delegates every command to, a wrong flag there becomes a denied or
malformed tool call at runtime.

Reconcile the skill against two sources, in this order of authority:

1. **The CLI's own `--help` output.** himalaya is self-documenting: every
   subcommand and flag is described by `himalaya <subcommand> --help`. This is
   the authoritative source because it comes from the binary in use.
2. **The published himalaya documentation**, as a secondary cross-check for
   behaviour `--help` states tersely.

Record the version reconciled against, taken from `himalaya --version`. The
version verified while writing this task was **v1.2.0**; if the installed
version differs, reconcile against the installed one and record that instead.

Two findings from that session are already established and must be preserved
rather than re-derived:

- `himalaya template write` with no arguments emits a draft whose first line is
  a `From:` header carrying the account's display name and configured email
  address. This is how the escalation path obtains the account's own address.
- `himalaya account list` exposes only account name, backend, and default flag
  in both table and JSON output, and `himalaya account doctor` reports
  integrity checks only. Neither exposes the email address.

Correct any command shape in the skill that `--help` contradicts. Where the
skill documents a shape the CLI no longer supports, fix the shape rather than
deleting the operation. Do not add operations the triage workflow does not use.

## Acceptance Criteria

AC-1: The system shall record, in the `himalaya` skill, the exact
      `himalaya --version` string it was reconciled against.

AC-2: The system shall ensure every command shape, subcommand name, and flag
      documented in the `himalaya` skill and its reference file is accepted by
      the installed CLI's `--help` output for that subcommand.

AC-3: The system shall document the `template write` `From:`-header route as
      the means of obtaining the account's own configured email address.

AC-4: IF a command shape documented in the skill is contradicted by the CLI's
      `--help` output THEN THE SYSTEM SHALL correct that shape and note the
      correction in the Work Log with the `--help` excerpt that proved it.

AC-5: The system shall leave the skill free of triage policy, escalation
      addresses, and category taxonomy, which belong to the `email-triage`
      skill.

## Dependencies

- None. This task reconciles content in place and does not depend on the
  package restructure. If it lands after the S-011 restructure, apply the
  changes at the skill's new canonical location instead.

## Files to Touch

- `the-intern/email-skills/.pi/skills/himalaya/SKILL.md` — version record,
  corrected command shapes, the `template write` address route
- `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`
  — corrected command shapes and flags

## Verification

Manual, with recorded evidence — there is no automated checker for prose
against `--help`.

```bash
himalaya --version

# For every subcommand the skill documents, capture the authoritative shape
# and compare it against the skill text:
for sub in "account list" "account doctor" "folder list" "envelope list" \
           "message read" "message move" "message write" "message reply" \
           "template write" "template reply" "template send" "attachment download"; do
  echo "===== himalaya $sub ====="
  himalaya $sub --help 2>&1
done

# Confirm the address route still holds against the installed version:
himalaya template write | head -1   # expect: From: <display name> <address>
```

Record in the Work Log, for each documented command: the `--help` excerpt and
whether the skill matched or was corrected.

## Work Log

## Review
