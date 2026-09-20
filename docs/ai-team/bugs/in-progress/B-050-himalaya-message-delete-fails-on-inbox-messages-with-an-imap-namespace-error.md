---
id: B-050
title: himalaya message delete fails on INBOX messages with an IMAP namespace 
  error
severity: high
status: in-progress
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

### Diagnosis 1 — 2026-09-20

**Reproduction status:** Confirmed. Live-reproduced directly against the real configured `himalaya v1.2.0` account (`daneel@aurorafw.com`, IMAP host `lin119.loading.es`) available in this sandbox — not just inferred from documentation. Reproduced twice: once via the default-folder form (`himalaya message delete <id>`, equivalent to `-f INBOX` per the command's own documented default) against an ordinary INBOX message, and once via an explicit `-f INBOX.Papelera` form against a message already sitting in the account's real trash folder — both failed identically with the exact `unexpected NO response: Client tried to access nonexistent namespace. (Mailbox name should probably be prefixed with: INBOX.)` error from the bug report.

**Evidence captured:**
- `himalaya --debug message delete 225` (default folder, i.e. INBOX) → log shows `moving imap messages 225 from folder INBOX to folder Trash`, `utf7 encoded to folder: Trash`, then `Error: 0: cannot move IMAP message(s) / 1: cannot resolve IMAP task / 2: unexpected NO response: Client tried to access nonexistent namespace. (Mailbox name should probably be prefixed with: INBOX.)` at `pimalaya-tui-0.3.1/src/himalaya/backend.rs:670`. Message 225 remained in INBOX afterward (non-destructive failure).
- `himalaya --debug message delete -f INBOX.Papelera 8` (source folder set to the account's *actual, correctly-configured* trash folder) → identical failure: `moving imap messages 8 from folder INBOX.Papelera to folder Trash`, same `nonexistent namespace` error. Proves delete's "is this the trash folder?" check never matches the real trash folder name and always falls through to the broken move-to-`"Trash"` branch, regardless of source folder.
- Account config (`/home/daneel/.config/himalaya/config.toml`) explicitly sets `folder.alias.trash = "INBOX.Papelera"` — the correctly configured, real trash folder (confirmed present and populated via `himalaya folder list` and `himalaya envelope list -f INBOX.Papelera`).
- Control tests proving the same account/session/IMAP connection works correctly when given the real folder name explicitly, isolating the fault to `delete`'s internal destination resolution only:
  - `himalaya --debug message move INBOX.Papelera 225 -f INBOX` → `Message(s) successfully moved from INBOX to INBOX.Papelera!` (verified via before/after `envelope list`).
  - `himalaya --debug flag add 8 deleted -f INBOX.Papelera` → `Flag(s) deleted successfully added!` (verified via `envelope list -o json` showing `"flags":["Seen","Deleted"]`).
- `himalaya --version` confirms `v1.2.0`, the same build `command-reference.md` and precedent bug B-034 were verified against.
- `the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s "Deleting a Message" section (lines 398-414) documents the plain, broken form (`himalaya message delete 42`, `himalaya message delete -f Archive 42 43`) with no namespace caveat; byte-identical to the mirrored `.pi/skills/himalaya/references/command-reference.md` copy (`diff` confirms no drift between the two).

**Isolated fault:** Not a defect in this repository's source — it is entirely inside the external `himalaya v1.2.0` binary's `message delete` trash-folder resolution path (surfacing through `pimalaya-tui-0.3.1/src/himalaya/backend.rs:670` and the underlying IMAP move-task resolver), which this repo cannot patch. Within this repo, the isolated fault is that `the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s "Deleting a Message" section (and its mirrored `.pi/skills/` copy) documents the plain `message delete <id>` / `-f <folder> <id>` forms as the canonical way to delete/trash an INBOX message, with no caveat that this fails on any account whose configured `folder.alias.trash` is not literally named `"Trash"` (i.e., essentially any non-English or namespaced IMAP account, including the one used for live email-triage validation in this project).

**Root cause or fault hypothesis:** External dependency defect. `himalaya message delete`'s logic for deciding "is the given folder the trash folder?" (to choose between flagging `\Deleted` in place vs. moving to trash) and for resolving the move destination when it isn't, does not consult the account's configured `folder.alias.trash` value at all — it compares against and always targets a hardcoded literal `"Trash"` mailbox name. On this account, whose real trash folder is `INBOX.Papelera` (localized name, correctly set via `folder.alias.trash` in config), that comparison never matches: `delete` never takes the "already in trash → flag" branch (confirmed — even `-f INBOX.Papelera` still attempted a move) and always attempts to move to the literal `"Trash"` mailbox, which the server's `INBOX.`-prefixed namespace rejects with exactly the reported `NO ... nonexistent namespace` error. This explains why the bug report's *explicit* `-f INBOX` form fails identically to the default form: the `-f` flag only controls the *source* folder for delete, never the (broken, hardcoded) destination resolution — so no source-folder value can work around it. `message move <folder> <id>` and `flag add <id> deleted -f <folder>`, by contrast, take an explicit destination/target argument with no such hardcoded fallback, and both were verified to work correctly against the identical account/session.

**Planned fix** (documentation-only, mirroring B-034's resolution — no Rust source change, matching this bug's own "Suspected Area" and "Related" sections):
1. `the-intern/bob-skills/skills/himalaya/references/command-reference.md`, "Deleting a Message" section: add an "Observed, B-050" pitfall callout stating that `message delete` fails with `unexpected NO response: Client tried to access nonexistent namespace` on accounts whose configured trash folder is not literally named `Trash` (i.e. `folder.alias.trash` set to anything else, such as a localized or `INBOX.`-nested name) — the failure occurs both when acting on an ordinary source folder and when acting directly on the account's real trash folder, because `delete`'s move destination and its trash-folder detection are both hardcoded to the literal name `Trash`, ignoring `folder.alias.trash`. Replace/supplement the documented command shape with the verified working two-part substitution: `himalaya message move <account's real trash folder name, e.g. from folder.alias.trash or "himalaya folder list"> <id...>` for moving an ordinary message to trash, and `himalaya flag add <id...> deleted -f <trash folder name>` for the already-in-trash soft-delete case. Cross-reference B-050.
2. Same edit mirrored to `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md` (kept in lockstep, per the existing convention already confirmed identical between the two files).
3. Check whether `S-004`-style policy allow-rules or any other skill file (e.g. `email-triage`) hardcode the literal `himalaya message delete` command shape as an allowed action pattern (as B-034 found for the reply-send rule) — if so, extend/adjust the allow-rule pattern to also admit the corrected `message move`/`flag add` shape. (Not yet confirmed in this diagnosis session; first check for the implementation cycle.)

**Planned verification:**
```bash
# Against the real configured account (already available in this sandbox):
himalaya message delete <id>                 # expected: still fails with the nonexistent-namespace error (confirms this remains an unpatched external defect)
himalaya message move <real-trash-folder> <id>            # expected: succeeds, message moved to the real trash folder
himalaya flag add <id> deleted -f <real-trash-folder>     # expected: succeeds, \Deleted flag set (verify via `envelope list -o json`)
```
Confirm `command-reference.md`'s "Deleting a Message" section (and its mirrored `.pi/skills/` copy) documents the corrected two-part working form with the B-050 callout, and that any policy allow-rule referencing the delete command shape (if found in step 3 above) is updated and re-verified the same way B-034's S-004 rule was (real `wildmatch`/`load_policy_config_from_file` throwaway test, RED before / GREEN after, deleted afterward).

**Files identified for the implementation cycle** (pending confirmation of item 3 above):
- `the-intern/bob-skills/skills/himalaya/references/command-reference.md`
- `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md`
- Possibly an `S-004`-style policy rule file, if item 3's check finds one hardcoding the `message delete` shape (to be confirmed, not yet found in this diagnosis session).

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-20

Implemented Diagnosis 1's fix contract without needing to revisit reproduction or root cause — both were already fully established in the Diagnosis Log: `himalaya v1.2.0`'s `message delete` always tries to move to a hardcoded literal `"Trash"` mailbox regardless of the account's configured `folder.alias.trash`, and `-f` only ever controls delete's source folder, never this broken destination resolution, so no source-folder value works around it. This is a documentation-only fix, matching the bug's own "Suspected Area" and precedent bug B-034 — no Rust or TypeScript source changed.

Edited `the-intern/bob-skills/skills/himalaya/references/command-reference.md`'s "Deleting a Message" section: kept the existing command syntax block and `--help`-derived description of `message delete`'s intended (soft-delete) semantics as-is, then added a "Hardcoded trash-destination pitfall (Observed, B-050)" callout explaining the defect mechanism and showing the exact broken form and error as an Observed transcript (`$ himalaya message delete 42` → the exact `unexpected NO response ...` error text from the bug report), followed by the verified working two-part replacement (`himalaya message move <trash-folder> <id>` for an ordinary message, `himalaya flag add <id> deleted -f <trash-folder>` for one already in trash) with a note on how to find the account's real trash-folder name. This follows the same editorial shape B-034 used in its own pitfall callouts elsewhere in the same file (e.g. "Positional-argument pitfall (Observed)", "Argument-order pitfall (Observed)") — a named "Observed, B-NNN" callout embedding the broken form and its real error inline rather than leaving it as a separate, still-runnable example a reader could copy-paste. Mirrored the identical edit to `the-intern/bob-skills/.pi/skills/himalaya/references/command-reference.md`, confirmed byte-identical via `diff` both before and after.

Checked item 3 from the Diagnosis Log's planned fix — whether any `S-004`-style `[[policy.action_rules]]` glob in `README.md`, `the-intern/docs/src/operator-guide/index.md`, or the `email-triage` skill files hardcodes the `himalaya message delete` command shape as an allowed action, the way B-034 found for its reply-send rule. Grepped all three locations plus every file in `email-triage/` for `message delete`, `trash`, and `Trash`: no hits anywhere. The only `message move` rules present in the shipped S-004 examples are triage-workflow moves (`INBOX.Notifications`, `Escalations`), unrelated to delete/trash. Concluding: nothing in this repo's shipped policy examples admits `message delete` (or would need to admit the corrected `message move`/`flag add` replacement) today, so no policy file needed editing and no throwaway `wildmatch`/`load_policy_config_from_file` test was written — there was no RED state to prove GREEN against. Noting this explicitly per the task's instruction not to invent work where the diagnosis's own conditional item comes back negative.

Verification: rather than only trusting the Diagnosis Log's already-captured live evidence, re-ran the exact command shapes now written in the docs against the same real configured account (`daneel`, `folder.alias.trash = "INBOX.Papelera"`) available in this session, to catch any doc-transcription error. `himalaya message delete 220` still failed today with the identical `unexpected NO response: Client tried to access nonexistent namespace` error (confirms the external defect remains unpatched, and non-destructively — the message stayed in INBOX). `himalaya message move INBOX.Papelera 220` succeeded (`Message(s) successfully moved from INBOX to INBOX.Papelera!`, verified via `envelope list -o json` — IMAP re-numbered it to id `9` in that folder, as expected for a cross-folder move). `himalaya flag add 7 deleted -f INBOX.Papelera` succeeded against a different message already sitting in that folder (`Flag(s) deleted successfully added!`, verified via `envelope list -o json` showing `"flags":["Deleted","Seen"]`). This is the same live-account, RED-then-GREEN verification style the Diagnosis Log itself used and that B-034's Work Log established as the adequate substitute for an automated test on a doc-only external-binary-workaround fix; no Rust test suite applies here, so none was run.

Committed in one cycle covering both mirrored files together: `docs(himalaya): document message delete trash-namespace pitfall` (commit `f1cebe3` on `bug/B-050-himalaya-delete-inbox-namespace-error`). `git diff dev-agent..HEAD` for the two touched files shows a diff scoped to exactly the "Deleting a Message" section; nothing else in either file changed, and `git status --porcelain` is clean.

What remains: nothing outstanding on this bug's own scope. The live verification actions taken this session (moving message 220 into `INBOX.Papelera`, flagging message 7 there as `Deleted`) were left as-is on the real shared mailbox rather than reverted, consistent with the precedent the Diagnosis Log and B-034 both set for live control-test side effects on this account — both actions are exactly the correct real-world outcome the documented fix describes, not synthetic test litter.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
