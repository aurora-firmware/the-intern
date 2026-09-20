---
id: B-053
title: himalaya MML text/plain attachment part appends a spurious trailing CRLF,
  corrupting the delivered attachment
severity: medium
status: open
created: '2026-09-20'
---

# himalaya MML text/plain attachment part appends a spurious trailing CRLF, corrupting the delivered attachment

## Summary

Discovered incidentally while re-verifying `B-051`'s working MML
attachment-composition pattern against a live account. When an MML
`<#part type=text/plain filename="...">...<#/part>` block is compiled by
`himalaya template send` and delivered, the downloaded attachment is two
bytes longer than the source file: a spurious trailing blank CRLF line is
appended to the content. `diff` between the original file and the
`himalaya attachment download`ed copy is non-empty. The same file sent as
the same MML part with a non-`text/plain` type (e.g.
`application/octet-stream`, or `application/pdf` for a real PDF) downloads
byte-identical — the corruption is specific to the `text/plain` MIME type
on the `<#part>` directive, not to MML attachments generally. For any
workflow that attaches a genuine `text/plain` file (a `.txt`, `.csv`,
`.log`, etc., as opposed to using `text/plain` only for the reply/forward
body itself), this is a silent content-corruption defect: `has_attachment`
correctly reports `true` and nothing in `template send`'s output signals
that the delivered bytes differ from the source.

## Reproduction Status

Status: confirmed

Reproduced independently, twice, against the real configured `himalaya
v1.2.0` account (`daneel@aurorafw.com`) available in this sandbox — not
reported externally; found directly during `B-051`'s live re-verification
session.

## Evidence

- Logs / stack traces / failing assertions:
  ```text
  $ wc -c b051-attachment.txt downloads/b051-attachment.txt
   54 b051-attachment.txt
   56 downloads/b051-attachment.txt

  $ diff b051-attachment.txt downloads/b051-attachment.txt
  1a2
  >
  ```
  (`>` on its own line: the downloaded copy has one extra blank line —
  a trailing `\r\n` — that the source file does not have.)
- Screenshots or recordings: none.
- Failing command or test:
  ```bash
  HEADERS=$(himalaya template write -H 'To:<addr>' -H 'Subject:<s>')
  PART='<#part type=text/plain filename="/path/to/file.txt"><#/part>'
  printf '%s' "$HEADERS"$'\n\n'"$PART"$'\n' | himalaya template send
  himalaya attachment download <id>
  diff /path/to/file.txt <downloads-dir>/file.txt   # non-empty
  ```
- First diagnostic step if not yet reproduced: send the same source file
  as an MML attachment part twice in one session, once with
  `type=text/plain` and once with `type=application/octet-stream`, and
  `diff` both downloaded copies against the source — only the
  `text/plain` copy differs.

## Reproduction Steps

1. Compose a plain-text source file with a single trailing newline, e.g.
   `printf 'hello\n' > file.txt`.
2. Build an MML template (headers + blank line +
   `<#part type=text/plain filename="/abs/path/to/file.txt"><#/part>`) and
   pipe it into `himalaya template send`.
3. Confirm delivery: `himalaya envelope list -o json -s 1` shows
   `has_attachment:true`.
4. Download the attachment: `himalaya attachment download <id>`.
5. `diff` the downloaded copy against the source file.
6. Observed: the downloaded copy is 2 bytes longer than the source — an
   extra blank (`\r\n`-only) line appended after the original content.
   Repeating steps 2–5 with `type=application/octet-stream` instead of
   `type=text/plain` (same source file, same filename) downloads
   byte-identical to the source.

## Expected Behavior

An MML `<#part type=text/plain ...>` attachment should be delivered with
exactly the source file's bytes, the same way `application/octet-stream`
(and other non-`text/plain` types) already are.

## Actual Behavior

`template send` appends one spurious blank CRLF line to the end of a
`text/plain`-typed attachment part's content before delivery. The
recipient's downloaded copy is 2 bytes longer than the source and `diff`
non-empty, even though `has_attachment` correctly reports `true` and
nothing in the command's output signals the discrepancy.

## Environment

- OS / platform: Linux, live configured `himalaya` account
  (`daneel@aurorafw.com`) in this sandbox.
- Language / runtime version: n/a (compiled Rust CLI binary, external
  dependency).
- Relevant dependencies: `himalaya v1.2.0
  +maildir +smtp +wizard +sendmail +pgp-commands +imap` (same build
  `command-reference.md` and `B-050`/`B-051`/`B-052` were verified
  against) — MML `<#part>` compilation path, specifically its handling of
  the `text/plain` content type versus other MIME types.
- Branch / commit: `dev-agent`; discovered live during `B-051`'s
  implementation-session re-verification (2026-09-20).

## Related

- Bug: `B-051` (himalaya `template write`/`template reply` escape MML
  attachment parts instead of sending them — a different attachment-
  related defect in the same `himalaya` binary; this bug was found while
  re-verifying `B-051`'s fix, filed separately since it is a distinct
  defect with a distinct trigger — MIME type, not command choice — and
  distinct scope).
- Bug: `B-052` (himalaya `message read` renders attachment `filename=`
  paths that don't exist locally — a third, independent attachment-
  handling defect in the same binary, filed alongside `B-051`).

## Suspected Area

`himalaya v1.2.0` binary itself (external dependency, not this repo's
source) — the MML compilation path's handling of `<#part type=text/plain
...>` content specifically (likely a line-ending/text-normalization step
applied only to parts typed as text, absent for binary/opaque MIME
types). Secondarily,
`the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s
MML attachment documentation (added by `B-051`), which should avoid
`text/plain` in its own worked example to keep the example byte-exact, and
may want a short caveat once this bug's fix (documentation workaround, or
confirmation of an upstream fix) is decided.

## Fix Verification

```bash
# Against a real configured account:
printf 'hello\n' > /tmp/b053-source.txt
HEADERS=$(himalaya template write -H 'To:<addr>' -H 'Subject:B-053 verify')
PART='<#part type=text/plain filename="/tmp/b053-source.txt"><#/part>'
printf '%s' "$HEADERS"$'\n\n'"$PART"$'\n' | himalaya template send
himalaya attachment download <id>
diff /tmp/b053-source.txt <downloads-dir>/b053-source.txt
# Once a workaround or corrected form is identified, confirm this diff is
# empty (byte-identical), and that command-reference.md documents the
# working/safe pattern for attaching a genuine text/plain file.
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
