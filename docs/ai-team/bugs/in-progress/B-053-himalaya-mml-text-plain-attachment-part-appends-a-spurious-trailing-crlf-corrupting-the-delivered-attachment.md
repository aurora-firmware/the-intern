---
id: B-053
title: himalaya MML text/plain attachment part appends a spurious trailing CRLF,
  corrupting the delivered attachment
severity: medium
status: in-progress
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

### Diagnosis 1 — 2026-09-20

**Reproduction status:** Confirmed, but the bug's own repro steps needed refinement to reproduce reliably. Live-reproduced directly against the real configured `himalaya v1.2.0` account (`daneel@aurorafw.com`) available in this sandbox. The bug file's own literal worked example (`printf 'hello\n' > file.txt`, single line, one trailing newline) did **not** reproduce the corruption — downloaded twice byte-identical (messages 255, 262). The defect reproduced deterministically once the source content was varied: any `text/plain` MML part whose content is multi-line (messages 259, 260) or lacks its own trailing newline (message 261) or is simply large enough (a 301-byte single line, message 264) corrupts on download; a short (6-byte), single-line, already-newline-terminated file does not. So "confirmed" holds for the bug as a class of defect, but its trigger is content-shape/size-dependent, not literally "any `text/plain` file," which the Summary/Evidence's single worked example did not capture.

**Evidence captured:**
- Control repro of the bug's own exact worked example, twice: `HEADERS=$(himalaya template write -H 'To:daneel@aurorafw.com' -H 'Subject:...')`; `PART='<#part type=text/plain filename="/home/daneel/Documents/b053-source.txt"><#/part>'` (`b053-source.txt` = `printf 'hello\n'`, 6 bytes); `printf '%s' "$HEADERS"$'\n\n'"$PART"$'\n' | himalaya template send`. Messages 255 and 262: `envelope list -o json` shows `has_attachment:true`; `attachment download` + `diff` against source: **empty both times** (byte-identical) — the bug's own literal example does not reproduce.
- Same pattern, multi-line source (`b053-multi.txt`, 115 bytes, 3 lines each `\n`-terminated, final line also `\n`-terminated): message 259, `diff` non-empty (`3a4 >`, one extra blank line), `wc -c` 115 vs 117 (downloaded file 2 bytes longer) — reproduces the bug's stated symptom exactly.
- Same pattern, 2-line source (`b053-2line.txt`, 18 bytes): message 260, `diff` non-empty (`2a3 >`), 18 vs 20 bytes.
- Same pattern, single-line source with **no** trailing newline (`b053-nonewline.txt`, `printf 'hello'`, 5 bytes): message 261, downloaded copy is `hello\r\n` (7 bytes) — a different corruption shape (an appended CRLF where the source had none at all, not merely an extra blank line after an existing one), still 2 extra bytes.
- Same pattern, single-line, newline-terminated, but long (`b053-longline.txt`, 301 bytes of `A` + `\n`): message 264, `diff` non-empty (`1a2 >`), 301 vs 303 bytes — proves the corruption is not simply "always absent for single-line content," it recurs once the content is large enough.
- `himalaya message export -F` on the corrupted messages (raw `.eml`, before any `attachment download` step) shows the corruption is already present in the **composed wire content**, not introduced by `attachment download`'s decoding: message 259's `Content-Type: text/plain`, `Content-Transfer-Encoding: quoted-printable`; the QP body escapes every internal newline as `=0A` (e.g. `...B-053.=0AIt has mul=\r\ntiple lines...Third line here.=0A\r\n`), and manually QP-decoding that raw body in Python (`quopri.decodestring`) yields 117 bytes — 2 bytes longer than the 115-byte source, confirming the extra CRLF is baked into the transfer-encoded body itself, not an artifact of `download`. Message 261's raw body (`Content-Transfer-Encoding: 7bit`) is literally `hello\r\n` on the wire — a real CRLF appended after content that had none.
- Control: identical multi-line source (`b053-multi.txt`) sent as `type=application/octet-stream` (message 263): `Content-Type: application/octet-stream`, `Content-Transfer-Encoding: base64`; manually base64-decoding the raw body in Python yields exactly the 115-byte source, byte-identical — confirms non-`text/plain` types never enter the path that appends the extra terminator, and are always base64-encoded regardless of content shape.
- Isolating the encoding-selection variable: `type=text/plain` messages showed a **content-dependent** auto-selected `Content-Transfer-Encoding` — `base64` for the short single-line newline-terminated content (messages 255/262, clean), `7bit` for the no-trailing-newline content (message 261, corrupted), `quoted-printable` for multi-line and for long single-line content (messages 259/260/264, corrupted). `application/octet-stream` (message 263) is always `base64` regardless of content. This isolates *why* corruption is visible only sometimes for `text/plain`: the appended terminator survives literally in `7bit`/`quoted-printable` bodies but is transparently absorbed by `base64` decoding.
- **Workaround found and verified twice independently:** spelling the MML part's `type` attribute in a case that is not the exact lowercase string `text/plain` — e.g. `type=TEXT/PLAIN` — with the identical multi-line source file and splice shape that reliably corrupts as `type=text/plain`. Messages 266 and 267 (`type=TEXT/PLAIN`, `b053-multi.txt`): `Content-Type: TEXT/PLAIN`, `Content-Transfer-Encoding: base64`, `has_attachment:true`; `attachment download` + `diff` against source: **empty both times** (byte-identical). Also verified on the no-trailing-newline source (message 268): same result, byte-identical, `Content-Type: TEXT/PLAIN`, `Content-Transfer-Encoding: base64`. Per RFC 2045, MIME type/subtype matching is case-insensitive, so `TEXT/PLAIN` is a standards-valid, universally-recognized `text/plain` media type for the recipient — this is not a hack that changes what the file is delivered as, only which internal himalaya composition path handles it.
- Other workaround avenues checked and rejected: (a) stripping the source file's own trailing newline does **not** avoid corruption — it changes the manifestation (message 261, CRLF appended to content that had none) rather than avoiding it. (b) `type=text/plain charset=us-ascii` is rejected outright by the MML parser (`Error: cannot parse MML body`) — not a valid attribute in this `mml-lib` build. (c) `himalaya template send --help`, `himalaya template write --help`, and `himalaya attachment download --help` reviewed in full: no flag on any of the three relates to transfer-encoding selection or text-body normalization. (d) `himalaya --debug template send` on a corrupting case: debug log shows only SMTP-context setup, no internal trace of MML compilation/encoding selection — consistent with B-051's and B-052's finding that this class of himalaya behavior is not exposed via `--debug`/`--trace`, so isolation here is by direct black-box behavioral comparison across message/content variants, not an internal stack trace.
- `himalaya --version`: `himalaya v1.2.0 +maildir +smtp +wizard +sendmail +pgp-commands +imap`, build `linux musl x86_64`, git `nix-flake-20260219100512, rev 1b70c4e0eaa72dee48353f0211e6cc0f0776fe98` — the same build `command-reference.md` and precedent bugs B-034/B-050/B-051/B-052 were verified against.
- `the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s "Sending an Attachment (MML Syntax)" section (added by B-051, lines 397-542) already carries a one-paragraph stub pointer to B-053 ("Avoid `type=text/plain`...") written during B-051's own session, before this bug had a Diagnosis Log — it names the symptom but has no "Observed, B-053" transcript, no isolated fault, and (per this diagnosis) understates that the defect is content-shape/size dependent, not present for every `text/plain` attachment. Confirmed byte-identical to the mirrored `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md` (`diff` empty).

**Isolated fault:** Not a defect in this repository's source — it is entirely inside the external `himalaya v1.2.0` binary (the same MML compilation path documented by B-051/B-052 as backed by the `mml-lib` crate), which this repo cannot patch. Specifically: when compiling an MML `<#part>` whose `type` attribute case-sensitively matches the exact lowercase string `text/plain`, himalaya routes the part's file content through a text-body-composition path (rather than the generic binary/opaque-content path every other type, and even case-varied spellings of the same media type, uses) that appends a trailing line terminator to the body before transfer-encoding it, regardless of whether the source file already ends in a newline. Within this repo, the isolated fault is that `command-reference.md` (and its byte-identical `.pi/skills/` mirror) documents this only as a one-line "avoid `text/plain`" pointer with no isolated fault, no verified workaround, and no caveat that the defect's visibility is content-dependent — exactly the gap this bug's own "Suspected Area" section anticipated and asked this diagnosis to fill in.

**Root cause or fault hypothesis:** External dependency behavior (best-supported hypothesis; no internal source/trace available to confirm the exact implementation, consistent with B-051's and B-052's finding that this class of himalaya behavior isn't exposed via `--debug`/`--trace`). Himalaya's MML compiler appears to special-case parts whose `type` is exactly `text/plain` (case-sensitive string match) as message-body-like text content, applying a normalization step that unconditionally appends a trailing line terminator — the same convention normally used to ensure a human-composed message body ends with a complete line — before transfer-encoding the result. The `Content-Transfer-Encoding` himalaya auto-selects for such a part is content-size/shape dependent (short, single-line, already-newline-terminated content is observed to select `base64`; longer content, multi-line content, or content missing its own trailing newline selects `7bit` or `quoted-printable`). The appended terminator is transparently absorbed by `base64` decoding (any bytes outside the meaningful payload are discarded), so it never corrupts a `base64`-encoded part — but it becomes real corrupted content once decoded from `7bit` (a literal extra CRLF) or `quoted-printable` (when the part's own newlines are individually escaped as `=0A`, leaving the appended terminator as an unescaped "hard" line break that any RFC-2045-compliant decoder reads as one genuine extra CRLF of payload). Any `type` spelling other than the exact lowercase string `text/plain` — including binary/opaque types (`application/octet-stream`, `application/pdf`) and, critically, case-varied spellings of the identical media type (`TEXT/PLAIN`) — never enters this text-body-formatting path and is always transfer-encoded as `base64` raw bytes, so it never exhibits the appended terminator regardless of content size or shape. This explains every observed detail: why the bug's own single-line, newline-terminated worked example doesn't reproduce (it incidentally selects `base64`); why multi-line, long, or non-newline-terminated content does reproduce (it selects `7bit`/`quoted-printable`); why `application/octet-stream` never reproduces at any content size (always `base64`, no text-formatting path at all); and why `TEXT/PLAIN` (case-varied) never reproduces even for content that reliably corrupts as `text/plain` (bypasses the case-sensitive dispatch into the text-formatting path entirely).

**Planned fix** (documentation-only, mirroring B-034/B-050/B-051/B-052 — no Rust source change, matching this bug's own "Suspected Area"):
1. Replace the existing one-paragraph B-053 stub pointer in `the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s "Sending an Attachment (MML Syntax)" section with a full "`text/plain` attachment trailing-CRLF pitfall (Observed, B-053)" callout, matching the file's established "Observed, B-NNN" convention (B-051's escaping pitfall, B-052's path pitfall): a real transcript showing a multi-line source file, `type=text/plain`, `has_attachment:true`, and a non-empty `diff` after download — explicitly noting the defect is content-shape/size dependent (small single-line newline-terminated content can incidentally round-trip clean, but this is undocumented internal behavior and must not be relied on).
2. Document the verified working pattern: spell the MML part's `type` attribute with any casing other than the exact lowercase string `text/plain` (e.g. `TEXT/PLAIN`) to send a genuine text-file attachment — with a real Observed transcript (`Content-Type: TEXT/PLAIN`, `Content-Transfer-Encoding: base64`, `has_attachment:true`, byte-identical `diff` after download) and a one-line note that this is RFC-2045-valid (MIME type matching is case-insensitive) and not a hack that changes what the recipient sees the file as.
3. Keep (and lightly clarify) the existing guidance that a non-text MIME type (`application/octet-stream`) is also always safe, as an alternative to the case-spelling workaround, for callers that don't need the recipient to see a `text/plain` type specifically.
4. Mirror the identical edit to `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md`; confirm byte-identical to the primary copy via `diff` both before and after, matching precedent.

**Planned verification:**
```bash
# Against the real configured account (already available in this sandbox):

# RED — exact lowercase text/plain, multi-line content (reliably corrupts):
HEADERS=$(himalaya template write -H 'To:<addr>' -H 'Subject:<s>')
PART='<#part type=text/plain filename="<path-to-multiline-file>"><#/part>'
printf '%s' "$HEADERS"$'\n\n'"$PART"$'\n' | himalaya template send
himalaya attachment download <id>
diff <source-file> <downloads-dir>/<file>   # expect non-empty (RED, re-run to catch doc drift)

# GREEN — case-varied type, identical file/splice shape:
PART='<#part type=TEXT/PLAIN filename="<path-to-multiline-file>"><#/part>'
printf '%s' "$HEADERS"$'\n\n'"$PART"$'\n' | himalaya template send
himalaya attachment download <id>
diff <source-file> <downloads-dir>/<file>   # expect empty (byte-identical)
himalaya message export -F <id> | grep Content-Type   # expect TEXT/PLAIN
```
Confirm `command-reference.md` (and its mirrored `.pi/skills/` copy) documents both the pitfall (with the B-053 "Observed" callout, content-shape caveat) and the verified case-spelling workaround, using the same live RED/GREEN verification style B-050/B-051/B-052 established as adequate for a doc-only external-binary-defect fix.

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

Implemented the documentation-only fix per Diagnosis 1's fix contract. Read the full Diagnosis Log entry and B-051's Work Log stub before starting. Confirmed the live `himalaya v1.2.0` build in this sandbox matches the one the diagnosis was verified against, and confirmed the primary and mirrored `command-reference.md` copies were still byte-identical before editing.

Re-verified both ends of the fix contract live against the real `daneel@aurorafw.com` account before writing any documentation: a RED run (multi-line 91-byte source file, `<#part type=text/plain ...>`) reproduced the defect exactly as diagnosed — downloaded copy 93 bytes, `diff` showing one spurious extra blank line, `Content-Transfer-Encoding: quoted-printable` on the wire — and a GREEN run with the identical source and splice shape but `type=TEXT/PLAIN` came back byte-identical (`diff` empty), with `Content-Transfer-Encoding: base64` and `Content-Type: TEXT/PLAIN` on the wire. Used the multi-line file specifically because the diagnosis's own evidence showed short single-line newline-terminated content incidentally selects `base64` and doesn't reproduce — didn't want to repeat that mistake in the documented example.

Replaced the one-paragraph B-053 stub pointer in `the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s "Sending an Attachment (MML Syntax)" section (the stub B-051 had left there before this bug had a Diagnosis Log) with a full "`text/plain` attachment trailing-CRLF pitfall (Observed, B-053)" callout matching the file's established Observed-transcript convention (same style as the B-051 escaping callout and B-052 path callout already in this file): a real transcript of the RED repro (source content, send command, download, non-empty `diff`, wire `Content-Type`/`Content-Transfer-Encoding`), an explicit note that the defect is content-shape/size dependent and that small clean-looking test content is not proof of safety, then the verified `type=TEXT/PLAIN` working pattern with its own real transcript and a one-line RFC 2045 case-insensitivity note explaining why this isn't a hack. Kept and lightly clarified the existing `application/octet-stream`/real-MIME-type alternative as a second always-safe option. Mirrored the identical edit to `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md` by copying the whole file over (confirmed both copies were already byte-identical outside this section) and confirmed `diff` between the two copies is empty after the edit.

Nothing was tried and rejected during this session beyond what Diagnosis 1 itself already ruled out (that work was done in the prior diagnosis session, not repeated here). As a final check, re-ran the exact RED and GREEN command shapes as documented, verbatim, one more time (messages 271 and 272) — both reproduced identically to the first pass, confirming the documented transcripts are stable and not a one-off fluke.

No Rust or TypeScript source was touched, consistent with the Diagnosis Log's determination that the fault is entirely inside the external `himalaya v1.2.0` binary. Committed as a single commit, `docs(himalaya): document text/plain attachment trailing-CRLF pitfall`, on `bug/B-053-himalaya-text-plain-attachment-crlf`. Nothing remains for a next session on this bug from the Developer side; ready for review.

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

**Diagnosis→fix evidence chain:** Diagnosis 1 records reproduction status,
and is explicit and honest that the bug's own literal worked example
(`printf 'hello\n' > file.txt`, single line, one trailing newline) does
**not** reproduce the corruption — this is stated directly, not glossed
over, with two independent control runs (messages 255, 262) confirming a
clean byte-identical round-trip on that exact example. Evidence captured
then isolates the real trigger across five content variants (multi-line,
2-line, no-trailing-newline, long single-line, and the non-reproducing
short single-line control) plus a same-content `application/octet-stream`
control, and pins the mechanism directly to the wire-level
`Content-Transfer-Encoding` himalaya auto-selects per content shape/size
(`base64` for short/clean content absorbs the appended terminator
harmlessly; `7bit`/`quoted-printable` expose it as real corrupted bytes).
Isolated fault and root-cause hypothesis are both present, the hypothesis
explicitly labeled best-supported/unconfirmed (no internal trace
available, consistent with B-051/B-052's precedent that this himalaya
behavior class isn't exposed via `--debug`/`--trace`). A verified
workaround (`type=TEXT/PLAIN`, case-varied) is independently confirmed
twice, including once on the no-trailing-newline variant, with an RFC 2045
case-insensitivity rationale. The fix contract (planned fix, four steps,
plus planned verification) is complete.

**Stage 1 — Bug criteria:**
- Fix addresses the isolated fault: yes — the new "`text/plain` attachment
  trailing-CRLF pitfall (Observed, B-053)" callout replaces the stale
  one-paragraph stub with a real RED transcript, an explicit
  content-shape/size caveat, and the verified `type=TEXT/PLAIN` GREEN
  workaround with its own transcript; this matches Diagnosis 1's planned
  fix steps 1–2 exactly. Step 3 (keep/clarify the `application/octet-stream`
  alternative) and step 4 (mirror to `.pi/skills/`) both verified present
  below.
- Fix Verification: the bug file's original section predates diagnosis and
  reuses the same non-reproducing single-line example, as expected; checked
  against Diagnosis Log's "Planned verification" and the Work Log's actual
  narrative instead, per the B-050/B-051/B-052 precedent. Work Log Session
  1 describes a fresh live re-verification (91-byte multi-line source, not
  a reuse of diagnosis-session message content): RED (`type=text/plain`,
  downloaded copy 93 bytes, non-empty `diff`, `Content-Transfer-Encoding:
  quoted-printable` on the wire) then GREEN (identical source/splice shape,
  `type=TEXT/PLAIN`, byte-identical `diff`, `Content-Transfer-Encoding:
  base64`, `Content-Type: TEXT/PLAIN`) — deliberately using multi-line
  content specifically to avoid repeating the diagnosis's finding that
  short single-line content incidentally passes. Re-ran the identical RED
  and GREEN shapes a second time (messages 271, 272) to confirm the
  documented transcripts are stable, not a one-off. This matches the live
  RED/GREEN verification style B-050/B-051/B-052 already established as
  adequate for a doc-only external-binary-defect fix.
- No unrelated behavior added.

**Stage 2 — Code quality / bug-fix addendum:**
- Diff scoped correctly: `git diff dev-agent...bug/B-053-himalaya-text-plain-attachment-crlf`
  touches only `the-intern/bob-skills/skills/himalaya/references/command-reference.md`
  and `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md`
  (103 insertions / 12 deletions each, matching the Work Log's claim),
  confirmed byte-identical to each other directly (`diff` between the two
  post-fix blobs is empty). The pre-image blob hash (`a9d0181`) matches
  `dev-agent`'s current blob for the primary file, confirming clean
  continuity from the state B-052's review left it in. No other files
  touched — the canonical bug file itself shows zero diff between the
  branch and `dev-agent` (its Diagnosis Log/Work Log entries were already
  committed to `dev-agent` before the branch diverged).
- No Rust/TS/JS source touched anywhere in the diff (confirmed directly —
  `git diff --name-only` filtered for `.rs`/`.ts`/`.js` returns nothing),
  consistent with the Diagnosis Log's determination that the fault is
  entirely inside the external `himalaya v1.2.0` binary and this being a
  documentation-only fix. No automated regression test applies (these
  `bob-skills` reference files are outside the mdBook build); the live
  RED/GREEN re-verification against the real account, repeated twice, is
  an adequate substitute, mirroring B-034/B-050/B-051/B-052.
- The RED transcript uses genuinely reproducing content (91-byte
  multi-line file), not the original single-line non-reproducing example —
  confirmed directly in the diff. A reader copying this example will see
  the defect, not a false-clean result.
- The GREEN workaround documentation explains *why* `type=TEXT/PLAIN`
  works (RFC 2045 MIME type/subtype matching is case-insensitive, so it is
  a standards-valid `text/plain` media type for the recipient, not a
  hack), rather than presenting it as an unexplained incantation.
- Commit `428ad48` message `docs(himalaya): document text/plain attachment
  trailing-CRLF pitfall` follows `type(scope): description` (lowercase,
  imperative, 68 characters, no period, no bug ID repeated in the
  subject).
- The new callout follows the file's established "Observed, B-NNN"
  pitfall-callout convention (same pattern as the B-051 escaping callout
  and B-052 path callout already in this file); code fences are
  well-formed and the transcript is internally consistent (message ids,
  byte counts, and wire headers all agree across the shown outputs).

No blocking issues found. No minor observations beyond what is noted
above.
