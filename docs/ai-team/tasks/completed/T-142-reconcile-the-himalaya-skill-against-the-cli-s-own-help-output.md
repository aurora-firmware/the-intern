---
id: T-142
title: Reconcile the himalaya skill against the CLI's own help output
status: completed
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

### Session 1 — 2026-08-07

Reconciled `the-intern/email-skills/.pi/skills/himalaya/SKILL.md` and its
`references/command-reference.md` against the installed CLI's own `--help`
output, confirmed at loop start to be `himalaya v1.2.0 +maildir +smtp
+wizard +sendmail +pgp-commands +imap` (build: linux musl x86_64) — the
same version both files already claimed, so no version-string update was
needed (AC-1).

For every subcommand the skill documents, I captured `himalaya <subcommand>
--help` fresh from the installed binary and diff'd it against the skill
prose, then cross-checked pitfall/behavior claims by running the live
commands against the configured `daneel` IMAP/SMTP account. Per-command
result (AC-2/AC-4 evidence):

- `himalaya account list --help` — Usage `himalaya account list [OPTIONS]`;
  options `-w/--max-width`, `-c/--config`, `-o/--output`, `--quiet`,
  `--debug`, `--trace` (no `-a/--account`). Skill text matched; confirmed
  live (`himalaya account list` / `-o json`) that output is limited to
  name, backend(s), default flag — no correction needed.
- `himalaya account doctor --help` — Usage `himalaya account doctor
  [OPTIONS] [ACCOUNT]`; only option beyond globals is `-f/--fix`. Skill
  text (documents it only as "out of scope", doesn't claim a shape)
  matched; confirmed live (`himalaya account doctor`) output is 3
  integrity-check lines, no address — no correction needed.
- `himalaya folder list --help` — Usage `himalaya folder list [OPTIONS]`;
  options `-a/--account`, `-w/--max-width`, plus globals. Skill text
  matched exactly — no correction needed.
- `himalaya envelope list --help` — Usage `himalaya envelope list
  [OPTIONS] [QUERY]...`; options `-f/--folder`, `-p/--page`,
  `-s/--page-size`, `-a/--account`, `-w/--max-width`, plus globals; query
  grammar (3 operators, 8 conditions, `order by` sort clause) matches the
  skill's transcription verbatim. Skill text matched — no correction
  needed. Also re-ran the two documented pitfalls live: `envelope list not
  flag seen -s 3` still errors with "expected space between filters...";
  `envelope list -s 3 not flag seen` (options first) succeeds; `envelope
  list -s 1 flag unseen` still silently returns zero rows instead of
  erroring. All match the skill's claims exactly.
- `himalaya message read --help` — Usage `himalaya message read [OPTIONS]
  <ID>...`; options `-f/--folder`, `-p/--preview`, `--no-headers`,
  `-H/--header` (verified repeatable live with two `-H` flags), plus
  `-a/--account`. Skill text matched — no correction needed.
- `himalaya message move --help` / `message copy --help` — Usage `himalaya
  message move|copy [OPTIONS] <TARGET> <ID>...`; options `-f/--folder
  <SOURCE>`, `-a/--account`. Skill text matched — no correction needed.
- `himalaya message write --help` — confirms it drives `$EDITOR` and is
  unsuitable for scripted use, exactly as the skill states. No correction
  needed.
- `himalaya message reply --help` / `message forward --help` — same
  `$EDITOR` behavior as `message write`; `template reply`/`template
  forward` are the scriptable counterparts, options `-f/--folder`,
  `-A/--all` (reply only), `-H/--header`, `-a/--account`. Skill text
  matched, and I re-ran `template reply`/`template forward` live against a
  real message to confirm the "prefilled From, quoted body with `>`" /
  "prefixed by a separator" claims — output matched exactly. No correction
  needed.
- `himalaya template write --help` — Usage `himalaya template write
  [OPTIONS] [BODY]...`; options `-H/--header`, `-a/--account`. Re-ran the
  documented "Hello world" transcript and the dash-led-body failure
  (`error: unexpected argument '- ' found`) live — both matched character
  for character. No correction needed.
- `himalaya template send --help` — Usage `himalaya template send
  [OPTIONS] [TEMPLATE]...`; only `-a/--account` beyond globals. Skill text
  matched — no correction needed.
- `himalaya attachment download --help` — Usage `himalaya attachment
  download [OPTIONS] <ID>...`; options `-f/--folder`, `-a/--account`,
  `-d/--downloads-dir`. Skill text matched — no correction needed. Also
  confirmed via `himalaya attachment --help` that `download` is the only
  subcommand, as the skill claims.

I also spot-checked commands the skill references but that weren't in the
task's explicit list (`message delete`, `flag add/set/remove`, `template
save`, `message send`/`save`) against their own `--help` output; all
matched the skill's documented shapes with no discrepancies. I did not find
a single command shape, flag, or subcommand name in either file that
`--help` contradicts — AC-2 and AC-4 are satisfied with zero corrections;
every acceptance criterion's evidence is the match confirmations above.

The one real gap the reconciliation surfaced was AC-3: the two established
facts (that `account list`/`account doctor` don't expose the account's
address, and that `template write` with no args does via its first-line
`From:` header) were stated in the task but not actually written into the
skill anywhere — I grepped both files first and confirmed the word
"address" appeared only in the "no triage policy" disclaimers, not as
documented CLI behavior. I fixed this by adding a new "Finding the
Account's Own Address" section to `command-reference.md` (with the live
`template write`/`account doctor` transcripts as evidence, and a
cross-reference from "Selecting an Account"), plus an Operation Index row
and an intro bullet in `SKILL.md` pointing to it. I kept the wording
strictly about the CLI mechanism (parsing the `From:` header's address out
of `template write`'s first line) and did not mention escalation, the
manager address, or any triage-specific use of the address, to respect
AC-5 — I re-grepped both files afterward for "categor|escalat|triage" and
confirmed nothing leaked in.

Rejected approach: I considered restating the whole account-list/doctor
non-exposure story only inside `SKILL.md`'s intro bullets to keep
`command-reference.md` untouched, but the Files-to-Touch note explicitly
expects the address route to land in `command-reference.md` as a corrected
shape too, and the reference file is where every other operation's full
detail already lives (consistent with the Operation Index's link-out
pattern), so I put the substantive content there and kept SKILL.md to an
index row plus a short pointer bullet, matching how every other operation
is split between the two files.

Verification run: `himalaya --version` plus a fresh `<subcommand> --help`
capture for all 12 commands listed in the task's verification script, plus
live execution of `himalaya template write` (no args) confirming the first
line is still `From: Daneel AFW <daneel@aurorafw.com>`, exactly as AC-3
requires and as the task's established facts state. All commands were run
directly (no `pi` wrapper needed — this is CLI-only doc verification, not
a bob/pi-extension change), from a normal local shell against the
already-configured `daneel` account, so no sandbox socket/permission
issues applied here.

Nothing remains outstanding against T-142's acceptance criteria. Two
adjacent, out-of-scope items surfaced during review that a reader should
be aware of but that this task deliberately does not touch: (1) the
skill's `-H` "repeatable" claims for `message read`/`template
write`/`template reply`/`template forward` aren't stated as repeatable in
`--help` text itself but were verified repeatable by live execution here,
consistent with how the skill already marks other Observed-only claims;
(2) `himalaya folder`, `himalaya message`, and `himalaya attachment` each
expose additional subcommands (`folder add/expunge/purge/delete`,
`message export/thread/edit/mailto`) that neither this skill nor the
triage workflow uses — left undocumented per AC-5's "don't add operations
the triage workflow does not use."

## Review

### Review Verdict — 2026-08-07

PASS

**Scope confirmed.** `git diff dev-agent...task/T-142-reconcile-himalaya-skill`
(merge-base `5c0632e`) touches exactly the two files in "Files to Touch":
`the-intern/email-skills/.pi/skills/himalaya/SKILL.md` (+6/-0) and
`references/command-reference.md` (+40/-0). Single commit `5886898`. No
unspecified files, no code, no unrelated content.

**Independent spot-check of the "zero corrections" claim (the central thing
worth verifying, per review instructions).** `himalaya --version` on this
machine is exactly `himalaya v1.2.0 +maildir +smtp +wizard +sendmail
+pgp-commands +imap` (build: linux musl x86_64), matching both files'
recorded version string verbatim (AC-1). I independently ran
`himalaya <subcommand> --help` for every command in the task's own
verification list — `account list`, `account doctor`, `folder list`,
`envelope list`, `message read`, `message move`, `message write`,
`message reply`, `message forward`, `template write`, `template reply`,
`template send`, `attachment download` (plus its parent `attachment`) —
and additionally `message delete`, `flag add`, `flag set`, `flag remove`,
and the `folder`/`message` parent commands (to confirm the "no
undocumented operations" claim). Every usage line, option name/shorthand,
and default documented in the skill text matched the live `--help` output
character-for-character; I found no discrepancy anywhere (AC-2). I also
re-ran four of the Observed/pitfall claims live: the argument-order error
(`envelope list not flag seen -s 3` → `expected space between filters...`),
the `flag unseen` silent-zero-match pitfall, `template write` with a
dash-led body without `--` (`error: unexpected argument '- ' found`), and
the same body with `--` (succeeds) — all four reproduced exactly as
documented. On this evidence the Developer's "no command shape needed
correction" claim holds; AC-4 is correctly satisfied vacuously (no
corrections occurred, so none needed to be logged).

**AC-3 (address route).** Ran `himalaya template write` live: first line
is `From: Daneel AFW <daneel@aurorafw.com>`, matching the new "Finding the
Account's Own Address" section in `command-reference.md` and the new
`SKILL.md` intro bullet/Operation Index row verbatim. Also ran
`himalaya account list` (plain and `-o json`) and `himalaya account
doctor` live: neither output contains an email address (JSON:
`[{"name":"daneel","backend":"IMAP, SMTP","default":true}]`; doctor:
three integrity-check lines), confirming the section's claim that
`template write` is the only route to the account's own address.

**AC-5 (no triage policy leakage).** Grepped both files for
`escalat|categor|triage|worklog`: the only hits are the pre-existing
disclaimer bullets ("no escalation address, category taxonomy, or worklog
instruction... that policy... lives in a separate skill") and one
pre-existing, unrelated use of "escalate" in the shell-injection-safety
section's delimiter-selection advice (not part of this diff, not policy
content). The new AC-3 content added by this diff describes only the CLI
mechanism for obtaining the account's own configured address — no
escalation address, category taxonomy, or triage policy was introduced.

**No added operations.** Confirmed live via `himalaya folder --help` and
`himalaya message --help` that `folder add/expunge/purge/delete` and
`message export/thread/edit/mailto` exist on the CLI but are correctly
left undocumented, matching the Work Log's stated scope decision.

**Anchors resolve.** The diff adds a new `## Finding the Account's Own
Address` heading in `command-reference.md`; its GitHub-slug is
`finding-the-accounts-own-address` (apostrophe dropped, spaces to
hyphens), matching both new links to it (`SKILL.md` intro bullet and
Operation Index row). The diff's other new link,
`[Selecting an Account](#selecting-an-account)`, resolves to the
pre-existing `## Selecting an Account` heading. All four link/anchor pairs
introduced by this diff resolve correctly.

**Stage 2 (quality).** This is documentation-only; no logic, tests,
security, or performance surface applies. Readability and formatting are
consistent with the rest of both files (same Observed/`--help`-sourced
citation style, same table/link conventions). No dead content, no
placeholder text.

Both stages pass. No corrections requested.
