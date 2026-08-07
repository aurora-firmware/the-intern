---
id: T-147
title: Replace the maintainer real address in the himalaya command reference
status: completed
priority: high
assigned-role: developer
created: '2026-08-07'
---

# Replace the maintainer real address in the himalaya command reference

## Description

The `himalaya` skill's command reference contains a maintainer's real personal
email address in two command transcripts — currently around lines 266 and 326,
both rendering as a `From:` header with a display name and that address. One
predates T-142; the second was added by it, which reproduced the existing
pattern rather than sanitising it.

Replace both with a clearly non-routable example address. The shipped
configuration template in this package already states that examples must never
carry a real address; the same rule applies to transcripts. This matters more
once the package is published to vendor marketplaces, where these transcripts
ship to consumers.

Use a reserved, obviously-fake domain (for example one under `.invalid`) and a
display name that reads as a placeholder. Keep the transcripts' structure
byte-identical apart from the address and display name — their value is that
they show the exact output shape, including the trailing angle brackets the
address is parsed out of.

Do not change any command, flag, or explanatory prose in this file.

## Acceptance Criteria

AC-1: The system shall contain no routable email address in the `himalaya`
      skill's shipped content.

AC-2: The system shall preserve the `From: <display name> <address>` output
      shape in both transcripts, so the documented parse rule still applies.

AC-3: The system shall leave every documented command, flag, and explanatory
      sentence in the file unchanged.

## Dependencies

- None. This file is not touched by any other pending task.

## Files to Touch

- `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`
  — replace the address and display name in both transcripts

## Verification

```bash
cd the-intern/email-skills/.pi/skills/himalaya

# AC-1 — expect no output (no real domains anywhere in the skill):
grep -rnE '[A-Za-z0-9._%+-]+@(aurorafw\.com|gmail\.com|outlook\.com|proton\.me)' .

# AC-2 — expect two From: lines, both with an angle-bracketed address:
grep -nE '^From: .+ <[^>]+>' references/command-reference.md

# AC-3 — expect the diff to touch only the two address lines:
git diff --stat -- references/command-reference.md
```

## Work Log

### Session 1 — 2026-08-07

Read the task file and its (empty) Work Log first, per the tdd skill's Step 0.
Confirmed the two `From:` transcripts named in the task (originally lines 266 and 326
of `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`) both
carried the maintainer's real personal address with a real display name. Established
the red state by running the task's AC-1 grep before touching anything — it found both
occurrences, confirming the fix was needed and the check surface was accurate.

Read `config/email-triage.example.toml` to confirm the package's existing convention
for placeholder addresses (`manager@example.invalid`) and matched it: replaced both
transcripts with `From: Example User <user@example.invalid>`, using a single
`replace_all` edit since the original text was byte-identical in both spots and the
desired replacement is the same in both.

**Tried and rejected:** considered keeping the `.com` TLD to match the file's other
placeholder addresses (`someone@example.com`, `person@example.com`) already present in
the same transcripts, but rejected that — the task explicitly calls for a domain that
reads as "obviously fake" (`.invalid`) and for consistency with the config template's
established convention, whereas `example.com` is used elsewhere in the same file for a
different purpose (recipient addresses in flag values, not the account's own identity),
and mixing conventions for the *account's own* address risked looking like a typo of a
real domain rather than an intentional placeholder.

Re-ran all three Verification commands from the task file after the edit: AC-1 grep now
returns no output (no real-domain addresses anywhere in the skill), AC-2 grep confirms
both `From:` lines retain the exact `display name <address>` shape with trailing angle
brackets, and AC-3's `git diff --stat`/`git show` confirms the change touches exactly
the two address lines (2 insertions, 2 deletions) with no command, flag, or explanatory
sentence altered. Specifically checked that the parse-rule prose in "Finding the
Account's Own Address" — "the address is the text inside the trailing `<...>` angle
brackets" — still reads correctly against `<user@example.invalid>`, since T-146's
`self-escalation` category depends on that exact parse.

Swept the whole `himalaya` skill directory (`SKILL.md` and
`references/command-reference.md` — the only two files) for any other routable-looking
address. Found one additional occurrence of the maintainer's real name used as an
account *name* (not an email address) in the `himalaya account list` output transcript
around what is now line 460. This falls outside AC-1's domain-based grep and outside
the two transcripts named in the task, so per instruction it was left untouched and
reported instead, for the loop to triage as a possible separate task. Also noted the
pre-existing `someone@example.com` / `person@example.com` placeholders elsewhere in the
same file use the IANA-reserved `example.com` domain (RFC 2606) and are not routable,
so no action was needed there.

**Remaining:** nothing outstanding for this task's own acceptance criteria. The only
open item is the account-name row noted above, which is out of this task's scope by the
task's own instruction.

Commits on `task/T-147-replace-maintainer-address`:

- `c8fb1c1` docs(himalaya): replace real address in command reference

## Review

### Review Verdict — 2026-08-07

PASS

**Stage 1 — Acceptance Criteria**

- **AC-1 (no routable address in shipped content).** Independently re-ran the
  task's grep in a detached worktree at `c8fb1c1`: no match against
  `aurorafw.com|gmail.com|outlook.com|proton.me`. Broadened the sweep beyond
  the task's fixed domain list to every `local@domain.tld`-shaped string in
  the skill directory (`SKILL.md` + `references/command-reference.md`, the
  only two files present): the only remaining addresses are
  `someone@example.com`, `person@example.com` (pre-existing, unchanged by
  this task) and the two new `user@example.invalid` occurrences. `example.com`
  and `.invalid` are both RFC 2606-reserved, non-routable — confirmed not a
  problem. Met.
- **AC-2 (preserve `From: <display name> <address>` shape).** Both
  transcripts (lines 266 and 326) now read
  `From: Example User <user@example.invalid>` — same `display name <address>`
  shape with trailing angle brackets as the original. Checked this against
  every downstream consumer of the parse rule: the "Finding the Account's Own
  Address" section's prose ("the address is the text inside the trailing
  `<...>` angle brackets") still reads correctly against the new value and
  wasn't touched by the diff. `references/escalation.md`'s
  missing-configuration fallback (T-143) only *refers* to "the `From:` header
  on the first line of `himalaya template write`" and the himalaya
  reference's own section for the exact shape — it does not quote or embed
  the address itself, so it needed no change and remains consistent.
  `references/categories/self-escalation.md` and
  `references/categories/README.md`'s `self-escalation` matching signal (T-146)
  likewise only cross-reference "Finding the Account's Own Address" by name,
  not by value — the self-addressed match still resolves via the same
  trailing-angle-bracket parse against whatever `template write` reports at
  runtime, independent of what placeholder ships in the docs. Met.
- **AC-3 (no command/flag/prose changed).** `git diff dev-agent
  task/T-147-replace-maintainer-address -- references/command-reference.md`
  shows exactly 2 insertions / 2 deletions, both `From:` lines, nothing else
  in the file touched. `git diff --stat` across the whole branch vs
  `dev-agent` touches only this one file (the task-file diff noise is the
  expected dev-loop work-log commit on `dev-agent`, not branch content). Met.

**AC-1 follow-up (not a FAIL).** The Developer's report of a further
occurrence is accurate: `references/command-reference.md` line 460 shows
`| daneel | IMAP, SMTP | yes |` in the `himalaya account list` output table —
the maintainer's real account name, not an email address. This is correctly
out of scope for T-147 as written: the task's Description names exactly "two
command transcripts" (the `template write` transcripts at the original lines
266/326), and AC-1's own verification command is a domain-based email grep
that an account name never trips. Leaving it untouched here is correct;
recorded below as a follow-up observation, not a task deficiency.

**Stage 2 — Code Quality.** Docs-only change to one markdown file; no code,
tests, or build affected. Wording, Markdown structure, and code-fence
delimiters are all untouched — a clean `replace_all` of an identical literal
string in two spots. No unrelated edits, no scope creep.

**Commit hygiene.** Single commit `c8fb1c1`, subject
`docs(himalaya): replace real address in command reference` — 57 characters,
within the git-conventions 72-character limit. Correct `docs` type and
`himalaya` scope-ish component per convention.

**Follow-up observation (out of scope for T-147, for future triage):** the
maintainer's real account name `daneel` still appears in the `himalaya
account list` transcript at `references/command-reference.md:460`. It is not
an email address and is outside the two transcripts this task named, so it
does not fail any of T-147's acceptance criteria. Recommend a small follow-up
task if the account name should also be genericised before this package
ships to vendor marketplaces.
