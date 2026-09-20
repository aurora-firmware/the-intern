---
id: B-051
title: himalaya template write and template reply escape MML attachment parts 
  instead of sending them as attachments
severity: high
status: open
created: '2026-09-20'
---

# himalaya template write and template reply escape MML attachment parts instead of sending them as attachments

## Summary

Filed from GitHub issue
[aurora-firmware/the-intern#72](https://github.com/aurora-firmware/the-intern/issues/72).
A valid MML attachment part (`<#part type=... filename="...">...<#/part>`)
placed in the `BODY` passed to `himalaya template write` or `himalaya
template reply` is not preserved: himalaya escapes the tags into
`<#!part ...><#!/part>` literal text instead of compiling them into a real
MIME attachment when the resulting template is later piped into `himalaya
template send`. The sent message ends up with `has_attachment: false` and
the recipient sees raw placeholder text instead of a file. This is a silent
failure — nothing in the command output signals that the attachment did not
attach — so a triage run can believe it sent a document when it didn't.
This is also the root cause behind GitHub issue #71 (shipped email skills
have no documented way to send an attachment in a reply at all).

## Reproduction Status

Status: confirmed

Reported directly by the GitHub issue author, including the working
counter-case (piping the full raw template — headers plus the MML body —
directly into `template send` in one step does produce a real attachment).
Not yet independently re-reproduced by this bug filing.

## Evidence

- Logs / stack traces / failing assertions:
  ```text
  BODY (input to template write/reply):
  <#part type=application/pdf filename="/path/to/file.pdf"><#/part>

  BODY as delivered (via template write/reply | template send):
  <#!part type=application/pdf filename="/path/to/file.pdf"><#!/part>

  Resulting message: has_attachment: false
  ```
- Screenshots or recordings: none.
- Failing command or test:
  `himalaya template write ... -- "$BODY" | himalaya template send` and
  `himalaya template reply <id> -- "$BODY" | himalaya template send`, where
  `$BODY` contains a valid MML `<#part ...><#/part>` block.
- First diagnostic step if not yet reproduced: reproduce both the failing
  path (`template write`/`template reply` composing the MML body, piped
  into `template send`) and the reporter's working control (the full raw
  template, headers included, piped directly into `template send` with no
  intermediate `template write`/`template reply` step) against a real
  configured account, and diff the two delivered messages.

## Reproduction Steps

1. Compose a body containing a valid MML attachment part, e.g.
   `<#part type=application/pdf filename="/path/to/file.pdf"><#/part>`.
2. Run either:
   - `himalaya template write ... -- "$BODY" | himalaya template send`
   - `himalaya template reply <id> -- "$BODY" | himalaya template send`
3. Inspect the delivered message.
4. Observed: the MML tags are delivered as literal escaped text
   (`<#!part ...><#!/part>`) and `has_attachment` is `false` — no real
   attachment is present.

## Expected Behavior

A valid MML attachment part in the body passed to `himalaya template
write`/`template reply` should be preserved through to `himalaya template
send` and compiled into a real MIME attachment, the same way it is when the
identical MML block is piped directly into `template send` as part of a
full raw template.

## Actual Behavior

`template write`/`template reply` treat the MML attachment tags as literal
body text and escape them (`<#part` → `<#!part`, `<#/part` → `<#!/part`)
rather than leaving them for `template send` to compile. The delivered
message has no real attachment (`has_attachment: false`); the recipient
sees the escaped placeholder text verbatim. Piping a full raw template
(headers + MML body, no `template write`/`template reply` step in between)
directly into `template send` does not exhibit the escaping and produces a
real attachment.

## Environment

- OS / platform: Linux, live configured `himalaya` account (per the source
  GitHub issue; not yet re-confirmed by this bug file).
- Language / runtime version: n/a (compiled Rust CLI binary, external
  dependency).
- Relevant dependencies: `himalaya v1.2.0` (same version
  `the-intern/bob-skills/skills/himalaya/references/command-reference.md`
  is verified against) — MML template-parsing/escaping path shared with the
  `template write`/`template reply` body-composition commands.
- Branch / commit: `dev-agent`; discovered live via GitHub issue #72 (filed
  2026-08-30).

## Related

- Bug: `B-034` (a different himalaya defect in the same command family —
  `template send`/`template save` positional-argument parsing — resolved by
  documenting the working command shape in `command-reference.md` rather
  than patching the binary; likely the same resolution pattern here).
- Bug: `B-052` (himalaya `message read` renders attachment `filename=`
  paths that don't exist locally — a different attachment-handling defect
  in the same `himalaya` binary, filed alongside this one from the same
  live-validation pass).
- GitHub issue: [aurora-firmware/the-intern#72](https://github.com/aurora-firmware/the-intern/issues/72)
  (root cause of GitHub issue #71 — shipped email skills document no way to
  send an attachment in a reply, because no working MML-attachment
  composition path via `template write`/`template reply` currently exists
  to document).

## Suspected Area

`himalaya v1.2.0` binary itself (external dependency, not this repo's
source) — specifically the MML-escaping behavior of `template write`'s and
`template reply`'s body-composition path, which differs from `template
send`'s own raw-template parsing. Secondarily,
`the-intern/bob-skills/skills/himalaya/references/command-reference.md`,
which currently documents no MML attachment syntax at all (T-132's own Work
Log explicitly notes this was deliberately left undocumented pending
verified `--help`/live-execution evidence) — this bug is exactly that
verification, and if the escaping proves to be an unfixable external
defect, the reference file is where the correct (non-escaping) attachment
composition path needs to be documented instead.

## Fix Verification

```bash
# Against a real configured account, with $BODY containing a valid MML
# attachment part:
himalaya template write -H 'To:<addr>' -H 'Subject:<s>' -- "$BODY" | himalaya template send
himalaya template reply <id> -- "$BODY" | himalaya template send
# Once a workaround or corrected composition path is identified, confirm
# the delivered message has a real attachment (has_attachment: true, or
# equivalent verified via `himalaya message read <id>`), and that
# command-reference.md documents the working attachment-sending path.
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
