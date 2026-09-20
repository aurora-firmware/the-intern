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

### Session 1 — 2026-09-20

Implemented Diagnosis 1's fix contract without needing to revisit reproduction or root cause — both were already fully established in the Diagnosis Log: `template write`/`template reply`/`template forward` unconditionally escape any `<#...>`/`<#/...>` MML syntax in their own `BODY` argument into inert `<#!...>` text, before any piping to `template send`. This is a documentation-only fix (no Rust/TS source touched), matching this bug's own "Suspected Area" and precedent bugs B-034/B-050.

Re-verified the diagnosis's own evidence live against the real configured account (`daneel@aurorafw.com`) before writing anything, to catch drift: RED for `template write -- "$BODY" | template send` (stdout shows the `<#!part...>` escaping in `template write`'s own output, before any pipe; delivered message `has_attachment:false`) and RED for `template reply`'s exact repro shape `template reply <id> -- "$BODY" | template send` (`has_attachment:false`) both reproduced identically today. Also independently reproduced the diagnosis's message-229 finding: a naive splice into `template reply`'s no-`BODY` skeleton that drops the header/body blank-line separator sends successfully but silently delivers `has_attachment:false` — a second, different way to fail, not the escaping defect itself.

Verified the GREEN workaround end-to-end for both commands, using a `template write`/`template reply` call with no `BODY` argument, manually splicing the raw MML `<#part>` block into the empty new-body slot with exactly one blank line before and after (for the reply case, this is precisely the 4-newline run — header/body separator + empty body + separator-before-quote — collapsing to 2+part+2 newlines when the part is inserted), then piping the whole assembled text into `template send`. Both paths delivered `has_attachment:true` and `himalaya attachment download` produced byte-identical (`diff`) copies of the source file. Re-ran the final documented command blocks copy-pasted verbatim as one last check before finishing, confirming they work exactly as written.

While verifying, found and confirmed (independently, twice) an unrelated defect: an MML `<#part type=text/plain ...>` attachment part gets a spurious trailing CRLF blank line appended on delivery, corrupting the downloaded bytes (`diff` non-empty, 2 extra bytes), while `application/octet-stream`/`application/pdf` parts round-trip byte-identical with the identical source file and splice shape. This is out of scope for B-051 (different trigger — MIME type, not command/BODY-argument choice), so per the new-bug skill I filed it separately as `B-053` on `dev-agent` (commit `fd4f618`, `docs(bugs): file B-053 for himalaya text/plain MML attachment trailing-CRLF corruption`) rather than folding it into this fix, matching the precedent set by `B-052` being filed alongside `B-051` from the same live-validation pass. The new documentation's worked examples deliberately use `application/pdf`, not `text/plain`, to avoid handing readers a broken example, with a one-line pointer to `B-053`.

Documentation added to `the-intern/bob-skills/skills/himalaya/references/command-reference.md`, mirrored byte-identically (confirmed via `diff` before and after) to `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md`: a new "## Sending an Attachment (MML Syntax)" section (placed after "Composing and Sending", before "Finding the Account's Own Address") documenting the `<#part type=... filename="...">...<#/part>` syntax, an "MML attachment-escaping pitfall (Observed, B-051)" callout with the real broken transcript and `has_attachment:false` outcome, and the verified working pattern with worked examples and real Observed transcripts for both the compose (`template write`) and reply (`template reply`) cases — the reply case is the direct answer to GitHub issue #71, explicitly cross-referenced. Added short cross-reference notes from "Replying", "Forwarding", "Composing and Sending", and "Handling Attachments" pointing to the new section. Decided to cross-reference "Forwarding" too, even though `template forward` isn't in this bug's title: the Diagnosis Log's own evidence already showed `forward` shares the identical escaping defect on its own `BODY` argument, so leaving that section's existing worked example silently broken with no warning would be worse than a short note; I did not, however, invest in re-verifying the no-`BODY`-plus-splice workaround specifically for `forward` (only write/reply were in scope and verified), and said so explicitly in the doc rather than overclaiming.

All transcripts in the new section are real, live-Observed output from this session (not hand-edited/fabricated) — I re-ran every command shown, including redoing an initial draft that had accidentally paired an edited-for-readability subject line with a real (but mismatched) `In-Reply-To` message ID, to keep the transcripts internally consistent.

Committed in one cycle covering both mirrored files together: `docs(himalaya): document working MML attachment-composition pattern` (commit `5272a3e` on `bug/B-051-himalaya-template-mml-attachment-escaping`). `git diff` for the two touched files shows 177 insertions/0 deletions each, scoped exactly to the sections identified in the Diagnosis Log's planned fix; nothing else in either file changed, and `git status --porcelain` is clean.

What remains: nothing outstanding on this bug's own scope. Live verification side effects (several test messages, an attachment file under `~/Documents` and `~/Downloads`) were left on the real shared mailbox/filesystem as-is, consistent with the precedent B-050's Work Log and this bug's own Diagnosis Log set for live control-test artifacts on this account. `B-053` (the unrelated `text/plain` trailing-CRLF defect found during this session) is now open and unstarted on `dev-agent` — a separate implementation session, not part of this handoff.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-20

PASS

Both review stages passed.

**Diagnosis→fix evidence chain:** Diagnosis 1 records reproduction status
(confirmed, live-reproduced twice against the real configured account, for
both `template write` and the bug's own exact `template reply` repro
shape), evidence captured (stdout showing the escaping happens inside
`write`/`reply`/`forward` themselves before any piping, `envelope list -o
json` / `message read` confirming `has_attachment:false` and literal
`<#!part...>` text, a working control using the reporter's full-raw-template
counter-case, and two verified GREEN workarounds), an isolated fault
(external `himalaya v1.2.0` binary defect, not this repo's source;
secondarily this repo's undocumented MML attachment-composition path), and
a root-cause hypothesis (write/reply/forward unconditionally escape any
`<#...>`-shaped text in their own `BODY` argument before splicing it into
the template they print, while `template send`'s raw/stdin parser never
escapes). The fix contract (planned fix + planned verification) is
complete.

**Stage 1 — Bug criteria:**
- Fix addresses the isolated fault/root cause: yes — the new "Sending an
  Attachment (MML Syntax)" section documents the escaping pitfall with a
  real Observed transcript, then the verified working no-`BODY`-argument
  splice pattern for both `template write` and `template reply`, matching
  Diagnosis 1's planned fix exactly.
- Fix Verification: the bug file's original section is generic/pre-diagnosis
  as expected; checked against the Diagnosis Log's "Planned verification"
  and the Work Log's actual narrative instead. Work Log Session 1 re-ran
  the RED cases live (`template write -- "$BODY" | template send` and the
  bug's exact `template reply <id> -- "$BODY" | template send` repro shape,
  both still `has_attachment:false`, escaping visible in each command's own
  stdout before any pipe) and the GREEN cases (no-`BODY`-argument splice
  for both `write` and `reply`, both `has_attachment:true`, downloaded
  attachments byte-identical via `diff` to the source file) — this matches
  Diagnosis 1's planned verification shape and the same live RED/GREEN
  style B-050 established as adequate for a doc-only external-binary-defect
  fix.
- No unrelated behavior added.

**Stage 2 — Code quality / bug-fix addendum:**
- Diff scoped correctly: `git diff dev-agent..bug/B-051-himalaya-template-mml-attachment-escaping`
  touches only `the-intern/bob-skills/skills/himalaya/references/command-reference.md`
  and `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md`
  (177 insertions each — identical diff text, confirmed by the identical
  pre/post blob hashes `e2299b1..09a406e` on both files). The branch's diff
  against `dev-agent` also shows the `B-051`/`B-053` bug files themselves as
  pure deletions with zero additions (`git diff ... -- docs/ai-team/bugs/`
  has 0 added lines) — this is expected divergence noise, since the branch
  was cut before the Diagnosis Log/Work Log entries were committed directly
  to `dev-agent` (bug files are canonical lifecycle state, not developer
  branch content), not a change the Developer made. No other files touched.
- No Rust/TS source touched (confirmed via diffstat — markdown only, both
  files under `bob-skills/`), consistent with this being a documentation-only
  fix for an external binary defect the repo cannot patch. The Work Log's
  reasoning for skipping an automated regression test holds — there is no
  repo source to unit-test — and the live RED/GREEN re-verification against
  the real account is an adequate substitute, mirroring B-034/B-050.
- `B-053` (the out-of-scope `text/plain`-specific trailing-CRLF defect found
  during verification) exists on `dev-agent` under
  `docs/ai-team/bugs/open/`, is not fabricated, and is a reasonable,
  well-scoped, independently-confirmed report (twice-reproduced, isolates
  the defect to the `text/plain` MIME type specifically via a working
  `application/octet-stream` control, distinct trigger from B-051's own
  command-choice defect). B-051's own new section correctly avoids
  `text/plain` in every worked example (all use `application/pdf`) and adds
  an explicit one-line pointer to `B-053` at the end of the new section, as
  the Work Log claims.
- The "Forwarding" cross-reference is stated honestly, not overclaimed: both
  the "Forwarding" section's own note and the "Sending an Attachment"
  section's closing note explicitly say `template forward` was *observed*
  to share the escaping defect but that the no-`BODY`-argument-plus-splice
  workaround was *not itself re-verified* for `forward` — matching the Work
  Log's claim precisely (only `write`/`reply` were verified end-to-end).
- The new section's cross-references from "Replying", "Forwarding",
  "Composing and Sending", and "Handling Attachments" all point to the
  correct `#sending-an-attachment-mml-syntax` anchor, which exists; the
  "Handling Attachments" note (not explicitly named in Diagnosis 1's planned
  fix step 2, which named only "Replying"/"Composing and Sending") is a
  reasonable, narrowly-scoped extension — it prevents a reader from
  mistaking that download-only section for an attach-on-send how-to — and
  is exactly the kind of cross-reference addition this review treats as in
  scope alongside the diagnosed fix.
- Commit `5272a3e` message `docs(himalaya): document working MML
  attachment-composition pattern` follows `type(scope): description`
  (lowercase, imperative, 67 chars, no period, no bug ID repeated in the
  subject).
- The new "MML attachment-escaping pitfall (Observed, B-051)" callout and
  the "Observed working transcript" / "Observed, dropping the header/body
  blank line" callouts follow the file's own established "Observed"
  pitfall-callout convention (same pattern B-050 and B-034 used elsewhere in
  the file); markdown code fences are well-formed and every cross-reference
  anchor resolves.

No blocking issues found. Minor non-blocking observation: the worked
examples use this account's real address/name and a live in-reply-to
message ID rather than fully generic placeholders — acceptable, matching
B-050's precedent observation, since it keeps the examples runnable and
Observed-verifiable against the account they were captured on, and the
surrounding prose already tells the reader to substitute their own values.
