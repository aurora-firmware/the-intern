---
id: B-034
title: himalaya template send/save cannot parse a template passed as a 
  positional CLI argument (works via stdin pipe)
severity: high
status: in-progress
created: '2026-08-08'
---

# himalaya template send/save cannot parse a template passed as a positional CLI argument (works via stdin pipe)

## Summary

Discovered live during B-030/B-031's combined live-validation session
(2026-08-08). The installed `himalaya v1.2.0` binary's `template send` and
`template save` subcommands fail with `Error: 0: cannot parse template`
whenever the raw template text is supplied as a positional `[TEMPLATE]...`
CLI argument — exactly the composition pattern
`the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`
documents and that the `direct-request`/`meeting-scheduling` reply-send
workflow (`himalaya template send "$(himalaya template reply <id> -- "$BODY")"`)
and the `Composing and Sending` section (`himalaya template send
"$(himalaya template write ... -- "$BODY")"`) both rely on. Piping the exact
same template text into `template send`/`template save` via stdin (no
positional argument at all) works reliably. This blocked `B-031`'s live
reply-send validation even though `bob`'s S-004 policy engine correctly
admitted the real, live-composed command and pi's `bash` tool executed the
heredoc-based construction without any syntax or tool error — the failure
is entirely inside the `himalaya` binary's own argument handling, downstream
of both `bob` and the `email-skills` package's own documented shell
construction.

## Reproduction Status

Status: confirmed

Reproduced independently twice: once via manual `himalaya` CLI invocations
outside `bob` entirely, and once inside a real live `bob` + pi-agent
scheduled session (session `9377acc6-0aba-429b-a7eb-4f5c3281d6cf`,
2026-08-08T15:43:49Z) driving the exact heredoc-based command
`the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`'s
"Replying" section prescribes.

## Evidence

- Logs / stack traces / failing assertions:
  - Manual repro (outside `bob`): `himalaya --debug template send
    "$(himalaya template write -H "To:daneel@aurorafw.com" -H "Subject:Test
    simple" -- "hello world")"` → after IMAP auth succeeds, `Error: 0:
    cannot parse template` at
    `/build/.../src/email/message/template/command/send.rs:77`. The
    identical failure occurs with `himalaya template save` (same location,
    `save.rs:87`), with CRLF-normalized line endings, with the template
    passed as several separate shell-quoted positional arguments instead of
    one multi-line argument, and with an explicit `<#part
    type="text/plain">...<#/part>` MML wrapper — none of these variations
    change the outcome.
  - Working control (outside `bob`): the exact same template text piped via
    stdin instead — `himalaya template write -H "To:daneel@aurorafw.com" -H
    "Subject:Compare B" -- "hello B" | himalaya template save -f
    INBOX.Trash` → `Template 12 successfully saved to INBOX.Trash`. Also
    `himalaya template write ... | himalaya template send` → `Message
    successfully sent!`.
  - Live repro inside `bob` (session `9377acc6-...`, tick at 2026-08-08
    15:43 UTC against a deployed `email-skills` workspace): the agent
    composed exactly `BODY=$(cat <<'R7K2M9Q4V6N8P1S3T5U0'\nThanks Jose —
    confirming Tuesday, August 11 at 2:00pm PT for the Q3 roadmap
    sync.\n\nTalk then,\nDaneel\nR7K2M9Q4V6N8P1S3T5U0\n)\nhimalaya template
    send "$(himalaya template reply 105 -- "$BODY")"` as one `bash` tool
    call. `bob`'s policy-control S-004 verdict was `allow=true` (matching
    the shipped reply-send allow-rule correctly). The command ran without
    any shell/tool error, but its captured output was: `... executing reply
    template command ... getting messages 105 from folder INBOX ...
    executing send template command ... building new smtp context Error: 0:
    cannot parse template` at `send.rs:77` — identical to the manual repro.
    By contrast, the same session's escalation-send call minutes later
    (`SUBJECT=$(cat <<'...')...BODY=$(cat <<'...')...himalaya template write
    -H 'To:jose.moreno@aurorafw.com' -H "Subject:Escalation: $SUBJECT" --
    "$BODY" | himalaya template send`, the pipe form) succeeded outright:
    `... sending smtp message Message successfully sent!`.
- Failing command or test: `himalaya template send "$(himalaya template
  write -H "To:<addr>" -H "Subject:<s>" -- "<body>")"` (or the equivalent
  with `template reply`/`template forward`) fails; `himalaya template write
  ... | himalaya template send` (no positional argument, template piped via
  stdin) succeeds.
- `himalaya --version`: `himalaya v1.2.0 +maildir +smtp +wizard +sendmail
  +pgp-commands +imap` (linux musl x86_64,
  `nix-flake-20260219100512`/`1b70c4e0eaa72dee48353f0211e6cc0f0776fe98`),
  the same version `command-reference.md` was written against.

## Reproduction Steps

1. Confirm a configured `himalaya` account (`himalaya account list`).
2. Run: `himalaya template send "$(himalaya template write -H
   "To:<any-valid-address>" -H "Subject:test" -- "hello world")"`.
3. Observe: `Error: 0: cannot parse template` after IMAP/SMTP client setup
   completes (the failure is in template parsing, not connectivity or
   auth).
4. Contrast with: `himalaya template write -H "To:<any-valid-address>" -H
   "Subject:test" -- "hello world" | himalaya template send` (same content,
   piped instead of passed positionally) → succeeds.

## Expected Behavior

`himalaya template send`/`template save`, per their own `--help` (`Usage:
himalaya template send [OPTIONS] [TEMPLATE]...` — "The raw template,
including headers and MML body") and per
`command-reference.md`'s documented `"$(himalaya template write/reply/forward
...)"` composition pattern, should accept a raw template supplied as a
positional argument and parse it the same way it accepts one via stdin.

## Actual Behavior

`template send`/`template save` fail with `Error: 0: cannot parse template`
for any positional-argument template, including the simplest possible case
that matches `command-reference.md`'s own "Observed" `template write`
example verbatim, while the byte-identical content piped via stdin parses
and sends/saves successfully every time.

## Environment

- OS / platform: Linux (this dev environment), `himalaya` installed at
  `/usr/local/bin/himalaya` via Nix
- Language / runtime version: n/a (compiled Rust CLI binary)
- Relevant dependencies: `himalaya v1.2.0` (`mail-parser` and internal MML
  template-parsing crates bundled in that build)
- Branch / commit: `dev-agent`; discovered during `B-030`/`B-031`'s combined
  live-validation session, 2026-08-08

## Related

- Bug: `B-031` (direct-request/meeting-scheduling reply-send live
  validation — this defect is the specific reason B-031's live send did not
  complete, even though `bob`'s S-004 rule and the heredoc pattern both
  worked correctly), `B-030` (escalation-send live validation — unaffected,
  because the escalation command shape documented in `SKILL.md` and
  `command-reference.md` already uses the working pipe form, not the
  positional-argument form)
- Specification: `S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md`
  (the `command-reference.md` reply/compose-and-send patterns this defect
  invalidates)

## Suspected Area

The `himalaya v1.2.0` binary itself (external dependency, not this repo's
source) — specifically its `template send`/`template save` positional-
argument parsing path
(`src/email/message/template/command/send.rs:77`,
`src/email/message/template/command/save.rs:87` per the binary's own
embedded panic/error locations). Secondarily,
`the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`'s
"Replying" and "Composing and Sending" sections, which document the broken
positional-argument form as the canonical pattern and explicitly flag it as
"Not verified by live execution" — this bug is exactly that verification,
and it failed.

## Fix Verification

```bash
# Once a workaround or upstream fix is chosen (e.g. switching
# command-reference.md's "Replying"/"Composing and Sending"/escalation
# patterns to the working `| himalaya template send` pipe form, matching
# the escalation pattern that already uses it), re-run:
himalaya template send "$(himalaya template write -H "To:<addr>" -H "Subject:test" -- "hello world")"
# and/or the chosen replacement pattern, and confirm it succeeds against
# the real configured account without "cannot parse template".
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

### Diagnosis 1 — 2026-08-08

Reproduction status: Confirmed. Already reproduced twice per the bug file's own Evidence section — once via manual `himalaya` CLI invocation outside `bob` (`himalaya template send "$(himalaya template write ...)"` → `Error: 0: cannot parse template` at `send.rs:77`, with `template save` failing identically at `save.rs:87`, and the identical content succeeding when piped via stdin instead), and once inside a real live `bob` + pi-agent session (`9377acc6-0aba-429b-a7eb-4f5c3281d6cf`, 2026-08-08T15:43:49Z) where the agent's exact heredoc-composed `himalaya template send "$(himalaya template reply 105 -- "$BODY")"` failed the same way while that same session's pipe-form escalation send succeeded. This diagnosis session re-confirmed the affected documentation is still in the pre-fix (broken, positional-argument) state as of today's file read — no drift since the bug was filed.

Evidence captured:
- `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md` still documents the broken positional form in three places: "Replying" (lines 227-230: `himalaya template send "$(himalaya template reply 42 -- "$BODY")"` and the `-A` variant), "Forwarding" (line 250: `himalaya template send "$(himalaya template forward 42 -- "$BODY")"`), and "Composing and Sending" (lines 288-292: `himalaya template send "$(himalaya template write ... -- "$BODY")"`). The "Not verified by live execution" caveat at lines 306-313 is now stale — the pattern has since been exercised (and failed) live, per this bug's own evidence.
- `the-intern/email-skills/.pi/skills/email-triage/SKILL.md:165` documents the escalation-send command as the working pipe form: `himalaya template write -H '...' -H "Subject:..." -- "$BODY" | himalaya template send` — confirmed as the reference pattern to align reply/forward/compose with, per `references/escalation.md` and `SKILL.md` step 3.3.
- `the-intern/email-skills/README.md` (lines 234-250) and `the-intern/docs/src/operator-guide/index.md` (lines 895-911) contain byte-identical duplicate S-004 `[[policy.action_rules]]` example blocks. The reply-send rule's `arg_matchers` pattern (README:237 / operator-guide:898) is shape-specific — it globs the literal substring `himalaya template send \"$(himalaya template reply *-- \"$BODY\")\"` — confirming this rule is keyed to the exact broken command shape and will not match a corrected pipe-form command without updating the glob. The escalation rule (README:243 / operator-guide:904) already globs a pipe-form shape and needs no change. The bare `himalaya template write` rule (README:249 / operator-guide:910, exact match, no trailing wildcard) is the no-argument address-lookup case and is unaffected.
- `grep` across `email-skills/.pi/skills/email-triage/references/categories/direct-request.md` and `meeting-scheduling.md` confirms neither hardcodes a command shape — both delegate to "the `himalaya` skill's reply operation" (command-reference.md's "Replying" section), so no edits are needed in the category files themselves.
- `grep` across `docs/ai-team/specs/S-010-...md` confirms the spec does not hardcode the broken shape — no spec change is implicated.

Isolated fault: Not a defect in this repository's source — it is entirely inside the external `himalaya v1.2.0` binary's `template send`/`template save` positional-argument parsing path (`send.rs:77`, `save.rs:87`), which this repo cannot patch. Within this repo, the isolated fault is that three sections of `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md` ("Replying" lines 227-230, "Forwarding" line 250, "Composing and Sending" lines 288-292) document the broken positional-argument composition as the canonical, agent-followed pattern, and the S-004 reply-send allow-rule (identical copies in `the-intern/email-skills/README.md:237` and `the-intern/docs/src/operator-guide/index.md:898`) is glob-matched to that exact broken shape.

Root cause or fault hypothesis: External dependency defect (himalaya v1.2.0's `template send`/`template save` cannot parse a template supplied as a `[TEMPLATE]...` positional argument, though its own `--help` documents that usage and stdin-piped input of the identical content works). This repo's fault is downstream: its reference documentation and policy-rule examples encode the now-known-broken positional form as the recommended/only-admitted command shape, instead of the pipe form already proven to work (both by manual control tests in the bug's evidence and by the live escalation-send success in the same session that reproduced the failure).

Planned verification (implementation-cycle edits):
1. `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`: replace the positional-argument compositions in "Replying" (plain + `-A` reply-all), "Forwarding", and "Composing and Sending" with the pipe form (`himalaya template <reply|forward|write> ... -- "$BODY" | himalaya template send`); note `template save` takes the same corrected shape (`save.rs:87` fails identically); update the stale "Not verified by live execution" caveat to record that the composition pattern has now been live-exercised (positional form failed; pipe form is the corrected, working shape), cross-referencing B-034.
2. `the-intern/email-skills/README.md` and `the-intern/docs/src/operator-guide/index.md` (kept in lockstep): update the reply-send `[[policy.action_rules]]` `arg_matchers` pattern from the positional-shape glob to a pipe-shape glob mirroring the escalation rule's existing structure; refresh surrounding prose to describe the new pipe form and cross-reference B-034 alongside the existing B-029/B-030 references.
3. Verification: re-run the bug's own Fix Verification command in pipe form against a real configured account and confirm it succeeds without `Error: 0: cannot parse template`; check the updated S-004 rule pattern against the real `wildmatch` crate the same way B-029/B-030's rules were, confirming it admits the new pipe-form command and continues to reject previously-rejected unsafe variants.

Files identified for the implementation cycle (no other files require changes):
- `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`
- `the-intern/email-skills/README.md`
- `the-intern/docs/src/operator-guide/index.md`

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-08

Implemented the fix from the Diagnosis Log (Diagnosis 1) without needing to revisit reproduction or root cause — both were already fully established: himalaya v1.2.0's `template send`/`template save` cannot parse a template passed as a positional CLI argument, though stdin-piped input of identical content works. This is a docs/policy-example fix touching exactly the three files the diagnosis scoped: `the-intern/email-skills/.pi/skills/himalaya/references/command-reference.md`, `the-intern/email-skills/README.md`, and `the-intern/docs/src/operator-guide/index.md`. No Rust source changed.

`command-reference.md`: replaced the `$()` capture-and-splice compositions in "Replying" (`template reply` -> `template send`, both plain and `-A`), "Forwarding" (`template forward` -> `template send`), and "Composing and Sending" (`template write` -> `template send`, and the `template save` cross-reference) with the pipe form. Added a "Positional-argument pitfall (Observed, B-034)" callout next to `template send`'s description, matching this file's existing "Observed" pitfall style, and replaced the stale "Not verified by live execution" caveat with one stating the composition pattern has now been live-exercised: positional form failed with `Error: 0: cannot parse template`, pipe form is confirmed working (manual control test plus a live escalation-send success in the same session). Also tightened one now-inaccurate sentence in "Embedding message-derived text safely" that referenced the old `template send "$(...)"` shape directly.

`README.md` / `operator-guide/index.md`: read each file's exact current text before editing. Updated the reply-send `[[policy.action_rules]]` glob from `BODY=$(cat <<'*himalaya template send \"$(himalaya template reply *-- \"$BODY\")\"*` to `BODY=$(cat <<'*himalaya template reply *-- \"$BODY\" | himalaya template send*`, mirroring the escalation rule's existing pipe-shape structure. Left the escalation rule and the bare `himalaya template write` rule untouched, exactly as the diagnosis specified. Refreshed the surrounding prose in both files to describe the pipe-form correction, cross-reference `B-034` alongside the existing `B-029`/`B-030` references, and explicitly preserve the "statically verified but not yet live-validated end-to-end" caveat (`B-031` still owns that live pass). Confirmed both files' new rule lines and updated prose stayed in lockstep.

TDD/verification: `service/crates/policy-control` has no existing harness for exercising S-004 example rules, but B-029/B-030's Work Log established a precedent — a throwaway integration test using the real `load_policy_config_from_file` parser and real `wildmatch` crate, deleted after use and never committed. Followed the same method: RED run against the pre-fix shipped pattern showed 4 of 7 checks failing (did not admit the corrected pipe-form command in plain, `-A`, or adversarial-body variants); implemented the docs fix; GREEN run showed all 7 passing (admits plain reply-send pipe form, `-A` reply-all pipe form, and adversarial shell-metacharacter body content; rejects an unquoted-heredoc bypass, a bare/unquoted `$BODY` regression, a missing-`--` variant, and the old positional-splice shape now removed) — the same unsafe-variant set B-029's review covered. Deleted the throwaway test file immediately after; `git status` confirmed clean. `cargo fmt --all -- --check` and `cargo test -p policy-control` (the crate's own permanent suite) both pass, confirming the crate itself was left untouched.

Committed in two cycles: `docs(himalaya): correct template send/save composition to pipe form` (command-reference.md only), then `fix(email-triage): admit corrected pipe-form reply-send command in s-004 rule` (README.md + operator-guide/index.md together, kept in lockstep).

Did not attempt any live `himalaya`/email send — that is explicitly B-031's job, not this bug's. What remains: this bug's own fix (documented command shape corrected, S-004 rule pattern corrected and re-verified) is complete; the outstanding live end-to-end validation for `direct-request`/`meeting-scheduling` reply-send remains tracked separately under `B-031`, unchanged by this session.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-08

PASS

**Diagnosis Log** (Diagnosis 1): complete fix contract present — reproduction
status (confirmed, reproduced independently twice: manual CLI outside `bob`,
and a live `bob` + pi-agent session), evidence captured (exact error
locations `send.rs:77`/`save.rs:87`, control tests, byte offsets of the
affected sections in all three files), isolated fault (external
`himalaya v1.2.0` positional-argument parsing defect; downstream, this
repo's own docs/policy examples encode the broken shape), and root cause /
fault hypothesis (external dependency defect; this repo's fault is the
downstream documentation and rule pattern) are all present and consistent
with the bug's own Evidence section.

**Fix matches the isolated cause.** Diffed `dev-agent` against
`bug/B-034-...` for all three diagnosed files:
- `command-reference.md`: "Replying", "Forwarding", and "Composing and
  Sending" switched from `$()` capture-and-splice to the pipe form; new
  "Positional-argument pitfall (Observed, B-034)" callout added; `template
  save`'s cross-reference updated to the same corrected shape; the stale
  "Not verified by live execution" caveat replaced with a caveat recording
  the pattern as now live-exercised. No stray positional-form example
  remains anywhere in the file except inside the new callout itself,
  correctly describing it as the (now-avoided) failure mode.
- `README.md` / `operator-guide/index.md`: reply-send S-004 `arg_matchers`
  glob updated from the positional-splice pattern to
  `BODY=$(cat <<'*himalaya template reply *-- "$BODY" | himalaya template
  send*`. Confirmed this new pattern string is byte-identical between both
  files (only the surrounding TOML-block indentation differs, matching the
  same pre-existing indentation convention the old pattern already used).
  Confirmed via diff that the escalation rule and the bare `himalaya
  template write` rule are untouched and remain byte-identical between both
  files — no lines around them changed.

**Fix Verification scoping is reasonable and transparently documented, not
silently narrowed.** The bug file's original "Fix Verification" section
(predating Diagnosis 1) describes a live-account re-run of the chosen
pattern; the Diagnosis Log's own Planned verification step 3 also mentions
re-running "against a real configured account." That literal ask was
already satisfied before this implementation cycle started: the bug's own
pre-Diagnosis-1 Evidence section already records a manual control test
piping the identical template content into both `template save` and
`template send` against the real configured account, both succeeding. The
remaining, larger live pass — a real classified `direct-request`/
`meeting-scheduling` message driving a scheduled `bob` + pi-agent session
end-to-end, with S-004 admitting the live command and the send actually
completing — is explicitly out of scope here and tracked separately under
`B-031`, which the bug file's own Related section already designates as
owning that live validation ("this defect is the specific reason B-031's
live send did not complete"). The Work Log states the deferral explicitly
("Did not attempt any live himalaya/email send — that is explicitly
B-031's job, not this bug's"), and the updated `README.md`/
`operator-guide/index.md` prose itself cross-references `B-031` as owning
the outstanding live pass. This is a documented, traceable scope boundary,
not a silent one.

Minor non-blocking observation: the bug file's own "Fix Verification"
section text was not itself edited to point at this scoping rationale, so
a reader skimming only that section in isolation (rather than the Work Log
or Related section) could momentarily expect a live run from this bug
specifically. Does not block the verdict — the deferral is explained
elsewhere in the same file and in the shipped docs.

**Regression-test precedent confirmed real.** Checked both
`docs/ai-team/bugs/resolved/B-029-...md` and
`docs/ai-team/bugs/resolved/B-030-...md`: both Work Logs describe the
identical throwaway-integration-test methodology (a scratch test exercising
the real `wildmatch` crate via `load_policy_config_from_file`, run RED
before the fix / GREEN after, deleted and never committed) — B-030's own
Reviewer independently reproduced the same harness during that review. This
bug's Work Log follows the same pattern.

I independently re-verified this myself rather than taking the Work Log's
word for it: checked out the bug branch into a disposable git worktree,
confirmed `git status --porcelain` was clean (no stray test file left
behind), confirmed `git diff --name-status` against the branch's
merge-base with `dev-agent` touches exactly the three diagnosed files (no
`policy-control` crate source changed), ran `cargo fmt --all -- --check`
and `cargo test -p policy-control` (45 tests, all green — the crate's own
permanent suite is untouched and unaffected), then wrote and ran my own
equivalent throwaway test using the same technique (real `wildmatch` via
`load_policy_config_from_file`) against the exact old and new glob strings
pulled from both files. Result matched the claimed RED/GREEN outcome: the
OLD glob does not admit the corrected pipe-form command (plain or `-A`)
but does admit the old splice shape it was written for; the NEW glob admits
the corrected pipe-form command (plain, `-A`, and with adversarial
shell-metacharacter body content) and still rejects an unquoted-heredoc
bypass, a bare/unquoted `$BODY` regression, a missing-`--` variant, and the
now-removed splice shape. Deleted my test file and removed the worktree
after use; `git status` on `dev-agent` confirmed clean throughout.

**Code quality:** fix is minimal — only the three diagnosed files touched
across both commits, no unrelated refactoring bundled in. Commit messages
follow `type(scope): description` (`docs(himalaya)`, `fix(email-triage)`);
the `fix` type/scope choice for the S-004 rule commit matches the
established precedent set by B-029's own `fix(email-triage): add S-004
rule for direct-request/meeting-scheduling reply-send` commit for the same
kind of rule-example change. No secrets, no source-code changes, no scope
creep.

Both review stages pass. Next owner: active Bug-Fix Loop.
