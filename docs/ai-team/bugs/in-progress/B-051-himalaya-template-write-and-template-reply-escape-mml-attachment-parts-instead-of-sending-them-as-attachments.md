---
id: B-051
title: himalaya template write and template reply escape MML attachment parts 
  instead of sending them as attachments
severity: high
status: in-progress
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

### Diagnosis 1 — 2026-09-20

**Reproduction status:** Confirmed. Live-reproduced directly against the real configured `himalaya v1.2.0` account (`daneel@aurorafw.com`, account name `daneel`) available in this sandbox — not just inferred from the GitHub issue report. Reproduced deterministically, twice independently, for both affected commands: `himalaya template write -H ... -- "$BODY" | himalaya template send` and the bug's own exact repro shape `himalaya template reply <id> -- "$BODY" | himalaya template send`, both against a real MML `<#part type=text/plain filename="...">...<#/part>` block. Also reproduced the reporter's working counter-case (full raw template, no `write`/`reply` step, piped straight into `template send`) and a corrected composition workaround for both `write` and `reply`.

**Evidence captured:**
- `himalaya template write -H 'To:daneel@aurorafw.com' -H 'Subject:...' -- "$BODY"` (BODY containing `<#part type=text/plain filename="/tmp/.../b051-attachment.txt"><#/part>`), run *without* piping to `send`: stdout already shows `<#!part type=text/plain filename="..."><#!/part>` — proves the escaping happens inside `template write` itself, not in `template send`'s parsing of piped input.
- Same body piped into `template send` (`himalaya template write ... -- "$BODY" | himalaya template send`) → `Message successfully sent!`; delivered message id 226: `himalaya envelope list -o json` shows `"has_attachment":false`; `himalaya message read 226` shows the literal `<#!part ...><#!/part>` text verbatim in the delivered body.
- `himalaya template reply 226 -- "$BODY"` (no send yet): stdout shows the identical `<#!part...><#!/part>` escaping in the reply's own new-body slot (independent of any subsequent pipe). Piped into `template send` (bug's exact repro shape `himalaya template reply 226 -H 'To:...' -- "$BODY" | himalaya template send`): delivered message id 231, `has_attachment:false` — second, independent confirmation of the same defect on `template reply`, not flaky.
- `himalaya template forward 226 -- "$BODY"` (no send yet): stdout shows the identical `<#!part...><#!/part>` escaping — `template forward` shares the same defect (not itself in this bug's titled scope; noted as evidence, scope decision deferred to the implementation session).
- Working control (reporter's counter-case): hand-assembled a full raw template (`From/To/Subject` headers + blank line + real `<#part ...><#/part>` + text), with **no** `template write`/`template reply` step at all, piped directly into `template send` → message id 227: `has_attachment:true`; `himalaya attachment download 227` succeeded and the downloaded file is byte-identical (`diff`) to the original source file.
- Verified workaround, `template write` path: `HEADERS=$(himalaya template write -H 'To:...' -H 'Subject:...')` (no BODY argument at all — escaping path never invoked, headers-only output) + the raw un-escaped MML part manually appended after a blank line, piped whole into `template send` → message id 228: `has_attachment:true`.
- Verified workaround, `template reply` path: `SKELETON=$(himalaya template reply 226 -H 'To:...')` (no BODY argument — headers + quoted-original skeleton, escaping path never invoked) + the raw MML part spliced into the skeleton's empty new-body slot, preserving exactly one blank line before and after (an initial naive splice that ate the header/body blank-line separator — message id 229 — produced `has_attachment:false`, showing MML parsing is sensitive to correct blank-line placement, a secondary detail the doc fix must get right, not a new defect) → corrected splice, message id 230: `has_attachment:true`; `himalaya attachment download 230` byte-matches the source file (`diff`).
- `himalaya template --help` documents MML as backed by the `mml-lib` crate (`https://crates.io/crates/mml-lib`); no `--debug`/`--trace` output on `template write` exposes the escaping step internally (unlike B-050's explicit `backend.rs:670` trace) — the fault is isolated by direct black-box behavioral comparison (write/reply/forward always escape their own BODY argument; `template send`'s raw/stdin parser never does), not by an internal stack trace, since this is a silent-success-path behavior difference, not a crash.
- `himalaya --version`: `himalaya v1.2.0 +maildir +smtp +wizard +sendmail +pgp-commands +imap`, the same build `command-reference.md` and both precedent bugs (B-034, B-050) were verified against.
- `the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s "Handling Attachments" section (lines 472-493) documents only `attachment download` — no MML attachment-composition syntax anywhere in the file, confirming the bug's own "Suspected Area" claim. Confirmed byte-identical to the mirrored `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md` (`diff` empty, no drift since B-050's session).

**Isolated fault:** Not a defect in this repository's source — it is entirely inside the external `himalaya v1.2.0` binary (backed by the `mml-lib` crate referenced in `template --help`), which this repo cannot patch. Specifically: the body-composition path shared by `template write`, `template reply`, and `template forward` unconditionally escapes any `<#...>`/`<#/...>` MML control sequence found in their own `BODY` positional argument into inert `<#!...>` literal text before splicing it into the generated template — confirmed to happen inside these commands themselves (the escaped text is already present in their own stdout, before any piping to `template send`). `template send`'s raw-template/stdin parser, by contrast, treats its entire input as an already-composed, trusted MML template and parses `<#part>...<#/part>` as a real directive with no escaping. No `--help`-documented flag on any of the three commands disables this escaping. Within this repo, the isolated fault is that `command-reference.md` (and its byte-identical `.pi/skills/` mirror) documents no MML attachment syntax and no working attachment-composition path at all — exactly the gap this bug's own "Suspected Area" section anticipated, and the root cause of GitHub issue #71.

**Root cause or fault hypothesis:** External dependency behavior (best-supported hypothesis, no internal source/trace available to confirm the exact line): `template write`/`template reply`/`template forward` treat their `BODY` argument as literal user-typed text and defensively escape any text that merely looks like MML syntax, before splicing it into the template they print — likely to prevent a body that happens to contain `<#...>`-shaped text from being misinterpreted as a real MML directive. This escaping is unconditional and applies before the result is ever handed to `template send`, so there is no way to pass a genuine MML attachment directive through these three commands' own `BODY` argument. `template send` itself never escapes, because it treats its whole piped input as already-composed MML source. Consequently, the only way to produce a real attachment is to keep the MML `<#part>` block from ever passing through `write`/`reply`/`forward`'s own `BODY` argument: call those commands with no `BODY` argument at all (to get just the headers/quoted-original skeleton, which is unaffected by the escaping), splice the raw MML part directly into the assembled template text yourself, and pipe the complete result into `template send` — verified working for both `write` and `reply` above.

**Planned fix** (documentation-only, mirroring B-034/B-050 — no Rust source change, matching this bug's own "Suspected Area"):
1. Add a new subsection to `the-intern/bob-skills/skills/himalaya/references/command-reference.md` (near "Composing and Sending" / "Handling Attachments") documenting: the MML attachment part syntax; an "MML attachment-escaping pitfall (Observed, B-051)" callout showing the exact broken `-- "$BODY"` shape and the resulting `<#!part...><#!/part>` / `has_attachment:false` transcript (matching this file's existing "Observed, B-NNN" callout convention, e.g. B-050's "Hardcoded trash-destination pitfall"); and the verified working composition pattern — headers/quote skeleton via `template write`/`template reply` with **no** `BODY` argument, the raw MML part spliced into the blank-line-separated empty body slot, piped whole (not `$(...)`-spliced, per B-034's already-documented pipe requirement) into `template send` — with a worked example.
2. Cross-reference the new pitfall/pattern from "Replying" and "Composing and Sending"; decide during implementation whether "Forwarding" needs the same cross-reference, since `template forward` was observed here to share the identical defect but is not itself named in this bug's title/scope.
3. Mirror the identical edit to `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md`; confirm byte-identical to the primary copy via `diff` both before and after, matching B-050's precedent.
4. This directly resolves GitHub issue #71 (no documented way to send an attachment in a reply) as well as #72.

**Planned verification:**
```bash
# Against the real configured account (already available in this sandbox):
himalaya template reply <id> -- "$BODY" | himalaya template send
# expected: still fails (has_attachment:false, literal <#!part>) — confirms this remains
# an unpatched external defect, non-destructively (RED, re-run to catch doc drift)

# Once the corrected pattern is documented, re-run it end to end and confirm:
himalaya envelope list -o json -s 1   # expect has_attachment:true for the newly sent message
himalaya attachment download <id>     # expect the downloaded file to byte-match (diff) the source file
```
Confirm `command-reference.md` (and its mirrored `.pi/skills/` copy) documents the corrected pattern with the B-051 "Observed" callout, matching this diagnosis's planned fix, the same RED/GREEN live-account verification style B-050's Work Log used.

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
