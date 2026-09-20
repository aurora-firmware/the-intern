---
id: B-050
title: himalaya message delete fails on INBOX messages with an IMAP namespace 
  error
severity: high
status: open
created: '2026-09-20'
---

# himalaya message delete fails on INBOX messages with an IMAP namespace error

## Summary

Filed from GitHub issue
[aurora-firmware/the-intern#73](https://github.com/aurora-firmware/the-intern/issues/73).
`himalaya message delete` fails against ordinary INBOX messages with an IMAP
"nonexistent namespace" error, both with the default folder and with `-f
INBOX` given explicitly. This makes the documented delete workflow
unreliable for the single most common case (cleaning up triaged or
self-sent-test messages sitting in INBOX itself).

## Reproduction Status

Status: confirmed

Reported directly by the GitHub issue author against a live, already
configured account. Not yet independently re-reproduced by this bug filing
— re-confirmation against the real account is the first Diagnosis step.

## Evidence

- Logs / stack traces / failing assertions:
  ```text
  $ himalaya message delete 193 194
  $ himalaya message delete -f INBOX 193 194
  unexpected NO response: Client tried to access nonexistent namespace. (Mailbox name should probably be prefixed with: INBOX.)
  ```
  Both invocations fail identically, including the one that already names
  `INBOX` explicitly via `-f`.
- Screenshots or recordings: none.
- Failing command or test: `himalaya message delete <id...>` and `himalaya
  message delete -f INBOX <id...>` against ordinary INBOX messages.
- First diagnostic step if not yet reproduced: re-run both commands above
  against a real configured account with ordinary INBOX messages present,
  capturing `himalaya --debug message delete <id>` output.

## Reproduction Steps

1. Have ordinary (non-trash) messages sitting in INBOX.
2. Run `himalaya message delete <id...>`.
3. Retry with `himalaya message delete -f INBOX <id...>`.
4. Observe: both fail with `unexpected NO response: Client tried to access
   nonexistent namespace. (Mailbox name should probably be prefixed with:
   INBOX.)`, even though the source folder is already INBOX.

## Expected Behavior

`himalaya message delete` should work against ordinary INBOX messages,
moving them to the configured trash folder (or applying the `deleted` flag
when already acting on the trash folder), matching the behavior documented
in `the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s
"Deleting a Message" section and the command's own `--help` text.

## Actual Behavior

Both the default-folder and explicit `-f INBOX` forms fail outright with an
IMAP `NO` response claiming INBOX itself needs a namespace prefix
(`Mailbox name should probably be prefixed with: INBOX.`) — confusing
because the source folder named is already `INBOX`. No message is deleted
or moved.

## Environment

- OS / platform: Linux, live configured `himalaya` account (per the source
  GitHub issue; specific account backend not yet re-confirmed by this bug
  file).
- Language / runtime version: n/a (compiled Rust CLI binary, external
  dependency).
- Relevant dependencies: `himalaya v1.2.0` (same version
  `the-intern/bob-skills/skills/himalaya/references/command-reference.md`
  is verified against) — IMAP backend / trash-folder resolution path.
- Branch / commit: `dev-agent`; discovered live via GitHub issue #73
  (filed 2026-08-30), likely during an autonomous email-triage/live-validation
  session similar to how B-030/B-031 surfaced B-034/B-035/B-036.

## Related

- Bug: `B-034` (a different himalaya defect in the same command family —
  `template send`/`template save` positional-argument parsing — resolved by
  documenting a workaround in `command-reference.md` rather than patching
  the binary; same resolution pattern likely applies here if this proves to
  be an external `himalaya` defect too).
- GitHub issue: [aurora-firmware/the-intern#73](https://github.com/aurora-firmware/the-intern/issues/73)

## Suspected Area

`himalaya v1.2.0` binary itself (external dependency, not this repo's
source) — its IMAP mailbox-name/namespace resolution for `message delete`
on the account's own INBOX. Secondarily,
`the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s
"Deleting a Message" section, which currently documents plain `himalaya
message delete <id>` / `-f INBOX <id>` with no namespace caveat — if the
binary itself cannot be fixed, this file is where a workaround or corrected
mailbox-name form needs to be documented (mirroring how B-034's fix lived
entirely in this same reference file).

## Fix Verification

```bash
# Against a real configured account with ordinary INBOX messages present:
himalaya message delete <id>
himalaya message delete -f INBOX <id>
# Once a workaround or corrected mailbox-name form is identified, confirm
# both the chosen command shape succeeds (message moved to trash / flagged
# deleted, no "nonexistent namespace" error) and that command-reference.md's
# "Deleting a Message" section documents the working form.
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
