---
id: B-052
title: himalaya message read renders attachment parts with nonexistent local 
  file paths
severity: medium
status: in-progress
created: '2026-09-20'
---

# himalaya message read renders attachment parts with nonexistent local file paths

## Summary

Filed from GitHub issue
[aurora-firmware/the-intern#69](https://github.com/aurora-firmware/the-intern/issues/69).
`himalaya message read` renders an attachment part with a `filename=`
value that looks like a real, already-usable local filesystem path (e.g.
`/home/daneel/Downloads/3e6e...pdf`), but that file does not exist on disk
— it must still be fetched with `himalaya attachment download`. During
triage this is misleading: the rendered output reads like the attachment is
already available locally and can be opened directly.

## Reproduction Status

Status: confirmed

Reported directly by the GitHub issue author against a live account/message
with a real PDF attachment. Not yet independently re-reproduced by this bug
filing.

## Evidence

- Logs / stack traces / failing assertions:
  ```text
  <#part type=application/pdf filename="/home/daneel/Downloads/3e6e4376-f342-4462-ae3d-272c8d73dcd8.pdf"><#/part>
  ```
  The `filename=` path does not exist on the local filesystem at read time.
- Screenshots or recordings: none.
- Failing command or test: `himalaya message read <id>` against a message
  with an attachment, followed by attempting to open the rendered
  `filename=` path.
- First diagnostic step if not yet reproduced: read a message with a real
  attachment via `himalaya message read <id>`, capture the rendered MML
  part, and confirm the `filename=` path is absent from disk until
  `himalaya attachment download <id>` is run.

## Reproduction Steps

1. Read a message with a PDF (or other) attachment using `himalaya message
   read <id>`.
2. Inspect the rendered attachment part in the output — a `filename=` value
   pointing at what looks like a local path (e.g. under `~/Downloads/`).
3. Try to open the path shown in `filename=`.
4. Observed: the path does not exist locally; the file only appears after
   separately running `himalaya attachment download <id>`.

## Expected Behavior

`himalaya message read` should either omit a local filesystem path in
`filename=` unless the file genuinely already exists locally, or otherwise
make clear that the attachment has not yet been downloaded and must be
fetched separately via `himalaya attachment download`.

## Actual Behavior

The rendered attachment part's `filename=` value is a plausible-looking
local path (matching the account's real downloads directory naming
convention) that does not exist on disk at read time, with nothing in the
output indicating the file is not actually present yet.

## Environment

- OS / platform: Linux, live configured `himalaya` account (per the source
  GitHub issue; not yet re-confirmed by this bug file).
- Language / runtime version: n/a (compiled Rust CLI binary, external
  dependency).
- Relevant dependencies: `himalaya v1.2.0` (same version
  `the-intern/bob-skills/skills/himalaya/references/command-reference.md`
  is verified against) — `message read`'s MML rendering of attachment
  parts, versus `attachment download`'s actual downloads-directory
  resolution (see "Handling Attachments" in `command-reference.md`).
- Branch / commit: `dev-agent`; discovered live via GitHub issue #69 (filed
  2026-08-30).

## Related

- Bug: `B-051` (himalaya `template write`/`template reply` escape MML
  attachment parts instead of sending them — a different attachment-related
  defect in the same `himalaya` binary, filed alongside this one from the
  same live-validation pass).
- GitHub issue: [aurora-firmware/the-intern#69](https://github.com/aurora-firmware/the-intern/issues/69)

## Suspected Area

`himalaya v1.2.0` binary itself (external dependency, not this repo's
source) — `message read`'s rendering of attachment MML parts, which appears
to pre-compute or guess a downloads-directory destination path rather than
reflecting actual on-disk state. Secondarily,
`the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s
"Reading a Message" and "Handling Attachments" sections, which currently
carry no caveat that a `filename=` path shown by `message read` may not
exist yet — if the rendering itself can't be changed (external binary),
this is where an explicit warning/workflow note belongs so an operator
doesn't try to open the path directly.

## Fix Verification

```bash
# Against a real configured account, on a message with a real attachment:
himalaya message read <id>
# Inspect the rendered filename= path and confirm, once a workaround is
# chosen, that either (a) the path is no longer rendered as a bare local
# path unless the file exists, or (b) command-reference.md clearly
# documents that the shown path is not yet on disk and
# `himalaya attachment download <id>` must be run first.
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
