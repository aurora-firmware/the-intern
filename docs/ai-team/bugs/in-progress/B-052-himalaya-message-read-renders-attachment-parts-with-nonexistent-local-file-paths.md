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

### Diagnosis 1 — 2026-09-20

**Reproduction status:** Confirmed. Live-reproduced directly against the real configured `himalaya v1.2.0` account (`daneel@aurorafw.com`, account name `daneel`, IMAP host `lin119.loading.es`) available in this sandbox — not just inferred from the GitHub issue report. Reproduced with a clean, purpose-built message (id 253) sent from a source file under `~/Documents` with a UUID basename, so the rendered Downloads-dir path could not be coincidentally correct, and cross-confirmed against three pre-existing messages on the account (ids 251, 252, 244) that independently show the same rendering behavior.

**Evidence captured:**
- Created `/home/daneel/Documents/e9e44265-77f0-4999-aa2d-d7f27a6bc760.pdf` (75-byte test file). Confirmed no file existed yet at `/home/daneel/Downloads/e9e44265-77f0-4999-aa2d-d7f27a6bc760.pdf`.
- Sent using the verified B-051 working pattern: `HEADERS=$(himalaya template write -H 'To:daneel@aurorafw.com' -H 'Subject:B-052 repro attachment')`, spliced `<#part type=application/pdf filename="/home/daneel/Documents/e9e44265-77f0-4999-aa2d-d7f27a6bc760.pdf"><#/part>` into the empty body slot, piped into `himalaya template send` → `Message successfully sent!`; `himalaya envelope list -f INBOX -s 3 -o json` shows the new message id 253 with `"has_attachment":true`.
- `himalaya message read -f INBOX --preview 253` (non-destructive; `--preview` skips the `Seen` flag) rendered:
  ```
  <#part type=application/pdf filename="/home/daneel/Downloads/e9e44265-77f0-4999-aa2d-d7f27a6bc760.pdf"><#/part>
  ```
  — a `/home/daneel/Downloads/...` path, even though the actual attached file lives under `/home/daneel/Documents/...` and was never in Downloads.
- `ls -la /home/daneel/Downloads/e9e44265-77f0-4999-aa2d-d7f27a6bc760.pdf` at that point → `No such file or directory` — the exact path `message read` rendered does not exist on disk. This is the bug: confirmed.
- `himalaya attachment download -f INBOX 253` → `Downloading "/home/daneel/Downloads/e9e44265-77f0-4999-aa2d-d7f27a6bc760.pdf"… Downloaded 1 attachment!`; the file now exists at exactly the path `message read` had already rendered before the download, and `diff` against the original source file is empty (byte-identical).
- `himalaya message export -F -f INBOX 253` (raw `.eml`) shows `Content-Type: application/pdf` / `Content-Disposition: attachment; filename="e9e44265-77f0-4999-aa2d-d7f27a6bc760.pdf"` — only the bare basename, no directory component, per RFC. This isolates the mechanism: `message read`'s rendering reconstructs a full path by joining this basename with the account's configured `downloads-dir` (`/home/daneel/Downloads`, confirmed from `~/.config/himalaya/config.toml`'s `downloads-dir = "/home/daneel/Downloads"`), independent of whether that file has ever actually been downloaded.
- Corroborating evidence from pre-existing messages on the same account (ids 251 "Quarterly report", 252 "Re: Quarterly numbers", 244 "Quarterly report", all originally composed from a `/home/daneel/Documents/quarterly-report.pdf` source per `command-reference.md`'s own worked examples): `himalaya message read -f INBOX --preview <id>` for all of them renders the identical static path `/home/daneel/Downloads/quarterly-report.pdf`, regardless of the fact that repeated prior downloads of that same basename had already produced `quarterly-report_1.pdf`, `_2.pdf`, `_3.pdf` in Downloads via himalaya's own collision-avoidance renaming on `attachment download`. This shows the rendered path is not just "not yet downloaded" but a static, unconditional guess that can diverge from where `attachment download` will actually save the file once a naming collision exists.
- `himalaya --debug message read -f INBOX --preview 253`: debug log shows only IMAP connection/auth/peek steps (`peeking imap messages 253 from folder INBOX`, `select_mailbox`, etc.) — no internal trace step exposes the downloads-dir/basename join. Consistent with B-051's finding that this class of himalaya rendering defect is client-side display formatting on already-fetched content, not visible via `--debug`/`--trace`, so isolation here is by direct black-box behavioral comparison (source path vs. rendered path vs. actual on-disk state), not an internal stack trace.
- `himalaya --version`: `himalaya v1.2.0 +maildir +smtp +wizard +sendmail +pgp-commands +imap`, the same build `command-reference.md` and precedent bugs B-034/B-050/B-051 were verified against.
- `himalaya message read --help` and `himalaya attachment download --help` reviewed in full: `message read` has no flag related to attachment-path rendering or existence checking (`-f/--folder`, `-p/--preview`, `--no-headers`, `-H/--header`, `-a/--account` only); `attachment download`'s own `-d, --downloads-dir` override has no equivalent on `message read`, confirming the rendered path can only ever reflect the account's configured `downloads-dir`, never a per-invocation choice.
- Checked whether any shipped policy/skill file assumes a `message read`-rendered attachment path is real: grepped `README.md`, `the-intern/docs/src/operator-guide/index.md`, and every file under `the-intern/bob-skills/skills/email-triage/` (and its `.pi/skills/` mirror) for `message read`, `filename=`, `downloads-dir`, `attachment`. Only hit: an S-004-style policy allow-rule pattern `{ field_path = "command", pattern = "himalaya*message read*" }` in `operator-guide/index.md:1159`, which permits the *command*, not any claim about the rendered path being real — no change needed there.
- `the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s "Reading a Message" section (lines 119–140) and "Handling Attachments" section (lines 642–671) currently carry no caveat that a `filename=` path shown by `message read` may not exist on disk yet — confirming the bug's own "Suspected Area" claim. Confirmed byte-identical to the mirrored `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md` (`diff` empty).

**Isolated fault:** Not a defect in this repository's source — it is entirely inside the external `himalaya v1.2.0` binary, which this repo cannot patch. Specifically: `message read`'s human-friendly rendering of an attachment MIME part synthesizes the `filename=` attribute of the displayed `<#part ...><#/part>` MML placeholder by joining the account's configured `downloads-dir` with the bare basename recovered from the attachment's `Content-Disposition: filename` header — with no check of whether a file actually exists at that path. Because the MML `<#part filename="...">` syntax normally means "attach this already-existing local file" (its meaning when composing outgoing messages, per the "Sending an Attachment" section), reusing the identical syntax to *display* an already-received attachment reads to an operator as a claim that the file is already present locally, when it is merely a prediction of where `attachment download` would save it if run. Within this repo, the isolated fault is that `command-reference.md` (and its byte-identical `.pi/skills/` mirror) documents no caveat about this in "Reading a Message" or "Handling Attachments" — exactly the gap this bug's own "Suspected Area" section anticipated.

**Root cause or fault hypothesis:** External dependency behavior (best-supported hypothesis; no internal source/trace available to confirm the exact implementation, consistent with B-051's finding that this class of himalaya behavior isn't exposed via `--debug`/`--trace`). `message read`'s attachment-part display formatter appears to reuse the same MML `<#part type=... filename="...">` textual representation used for *composing* outgoing attachments, populating `filename=` with `<downloads-dir>/<Content-Disposition basename>` unconditionally — likely because this is exactly the path `attachment download` would use by default, and the formatter treats "the default future download destination" as interchangeable with "the current file location" without checking the filesystem. This explains every observed detail: the path is under the account's real, configured `downloads-dir` (not a fabricated/random directory, which is why it looks so plausible); it uses only the basename from `Content-Disposition` (matching the GitHub issue's UUID-looking example, since attachment filenames are often UUID-generated by the sending application); it renders identically before and after download (static computation, not a live existence check); and it can even show a path that a subsequent `attachment download` will *not* actually use once a basename collision triggers himalaya's own `_N` collision-avoidance renaming — proof the render is a naive guess, not a resolved real-world path.

**Planned fix** (documentation-only, mirroring B-034/B-050/B-051 — no Rust source change, matching this bug's own "Suspected Area"):
1. Add an "Attachment `filename=` path pitfall (Observed, B-052)" callout to `the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s "Reading a Message" section, explaining that the `filename=` value shown for an attachment `<#part>` is a synthesized potential local path (`<account's downloads-dir> / <original attachment basename>`), not evidence the file is already on disk — with a real Observed transcript (message read renders the path; `ls` on that exact path fails; `attachment download` then materializes it there, byte-identical) matching this diagnosis's message-253 evidence.
2. Add a short cross-reference note to "Handling Attachments" pointing back to the new "Reading a Message" callout, so an operator who lands there first also sees the caveat before treating a rendered `filename=` as already-fetched.
3. Mirror the identical edit to `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md`; confirm byte-identical to the primary copy via `diff` both before and after, matching B-050/B-051 precedent.
4. No policy/skill-file change identified as needed (see evidence above — only an unrelated command-allow pattern references `message read`).

**Planned verification:**
```bash
# Against the real configured account (already available in this sandbox), with a fresh
# attachment message (or reuse message 253 from this diagnosis session):
himalaya message read -f INBOX --preview 253
# expected: still renders filename="/home/daneel/Downloads/e9e44265-77f0-4999-aa2d-d7f27a6bc760.pdf"
# (RED, re-run to catch doc drift — confirms this remains an unpatched external defect)

ls /home/daneel/Downloads/e9e44265-77f0-4999-aa2d-d7f27a6bc760.pdf
# expected: file already exists in this session (downloaded during diagnosis) — for a
# genuinely fresh RED check, repeat against a newly sent, not-yet-downloaded message.

# Once the doc caveat is added, confirm command-reference.md (and its mirrored .pi/skills/
# copy) documents the pitfall with the B-052 "Observed" callout in "Reading a Message",
# cross-referenced from "Handling Attachments", using the same live RED/GREEN-style
# verification B-050/B-051 established as adequate for a doc-only external-binary-defect fix.
```

**Files identified for the implementation cycle:**
- `the-intern/bob-skills/skills/himalaya/references/command-reference.md`
- `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md`

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
