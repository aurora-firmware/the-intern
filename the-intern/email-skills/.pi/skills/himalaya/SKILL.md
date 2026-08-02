---
name: himalaya
description: >
  CLI reference for himalaya, a command-line email client. Use this skill
  whenever a task needs to list or search envelopes (including finding
  unseen/unread mail), read a message, reply to or forward a message,
  compose and send a new message, move or copy a message between folders,
  delete a message, add or remove flags, download attachments, or select a
  non-default account. Trigger even on generic phrasing like "check my
  email", "list unread mail", "reply to that message", "send an email",
  "move this to a folder", or "download the attachment" — these are all
  himalaya CLI tasks. In Pi, load this skill before giving himalaya command
  help or using bash to run himalaya. This skill documents the CLI only —
  it carries no triage policy (no escalation address, category taxonomy, or
  worklog instruction), so it is safe to use standalone in any session that
  shares this package's working directory.
compatibility: >
  Requires the himalaya CLI on PATH and Pi tools that can read files and
  run shell commands, plus an already-configured himalaya account (account
  setup is out of scope for this skill). Verified against installed
  `himalaya --version`: `himalaya v1.2.0 +maildir +smtp +wizard +sendmail
  +pgp-commands +imap` (build: linux musl x86_64).
allowed-tools: Read Bash
---

# Himalaya CLI Reference

`himalaya` is a command-line email client (IMAP/SMTP via a configured
account). It covers listing/searching mail, reading, replying, forwarding,
composing, sending, moving, copying, deleting, flag management, attachment
downloads, and multi-account selection — everything a scripted or agent
session needs to drive a mailbox from the shell.

In Pi, prefer this workflow:
1. Use `bash` to run `himalaya` commands.
2. Use `read` to open `references/command-reference.md` when you need the
   full flag set or a worked example for a specific operation.
3. When in doubt about a flag this skill doesn't cover, run
   `himalaya <command> --help` yourself rather than guessing — every
   command in this skill was verified the same way (see Health Check).

- Installed version check: `himalaya --version`
- This skill has no opinion on *what* to do with mail (no escalation
  address, category rules, or worklog format) — that policy, if any, lives
  in a separate skill that a session may also have loaded.

---

## Health Check

Run this before anything else in a session that needs himalaya:

```bash
himalaya --version     # confirm the binary is present; record the version
himalaya account list  # confirm at least one configured account exists
```

If `himalaya --version` fails (binary not on PATH) or no account is
configured, stop — do not guess at himalaya command syntax from memory.
Report that himalaya is unavailable/unconfigured rather than fabricating
commands; every command in this skill was checked against the installed
binary's own `--help` output, not assumed.

---

## Operation Index

Every operation the CLI supports for driving a mailbox, and where to find
its full detail:

| Operation | Command shape | Detail |
|---|---|---|
| List / search envelopes | `himalaya envelope list [OPTIONS] [QUERY]...` | [`references/command-reference.md#list-and-search-envelopes`](references/command-reference.md#list-and-search-envelopes) |
| Filter for unseen mail | `himalaya envelope list not flag seen` | [`references/command-reference.md#filtering-on-the-unseen-flag`](references/command-reference.md#filtering-on-the-unseen-flag) |
| Read a message | `himalaya message read <ID>...` | [`references/command-reference.md#reading-a-message`](references/command-reference.md#reading-a-message) |
| Reply to a message | `himalaya template reply <ID> [BODY]...` + `himalaya template send` | [`references/command-reference.md#replying`](references/command-reference.md#replying) |
| Forward a message | `himalaya template forward <ID> [BODY]...` + `himalaya template send` | [`references/command-reference.md#forwarding`](references/command-reference.md#forwarding) |
| Compose and send | `himalaya template write [BODY]...` + `himalaya template send` | [`references/command-reference.md#composing-and-sending`](references/command-reference.md#composing-and-sending) |
| Move a message | `himalaya message move <TARGET> <ID>...` | [`references/command-reference.md#moving-and-copying`](references/command-reference.md#moving-and-copying) |
| Copy a message | `himalaya message copy <TARGET> <ID>...` | [`references/command-reference.md#moving-and-copying`](references/command-reference.md#moving-and-copying) |
| Delete a message | `himalaya message delete <ID>...` | [`references/command-reference.md#deleting-a-message`](references/command-reference.md#deleting-a-message) |
| Add / remove / set flags | `himalaya flag add\|set\|remove <ID-OR-FLAG>...` | [`references/command-reference.md#managing-flags`](references/command-reference.md#managing-flags) |
| Download attachments | `himalaya attachment download <ID>...` | [`references/command-reference.md#handling-attachments`](references/command-reference.md#handling-attachments) |
| Select an account | `-a/--account <NAME>` on any command; `himalaya account list` | [`references/command-reference.md#selecting-an-account`](references/command-reference.md#selecting-an-account) |

All commands above accept `-o json` (in place of the default `plain`
table/text output) for machine-parseable results — verified as a global
`himalaya` option present on every subcommand's own `--help`.

→ Full per-operation commands, every verified flag, and CLI pitfalls found
while checking this against the installed binary: [`references/command-reference.md`](references/command-reference.md)
