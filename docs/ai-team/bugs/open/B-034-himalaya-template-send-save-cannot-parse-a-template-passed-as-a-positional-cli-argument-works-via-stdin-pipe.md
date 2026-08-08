---
id: B-034
title: himalaya template send/save cannot parse a template passed as a 
  positional CLI argument (works via stdin pipe)
severity: high
status: open
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
