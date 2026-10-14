---
name: the-intern-docs
description: >
  Reference documentation about bob and the Intern themselves: what they
  are, how to install, configure, operate, schedule, and troubleshoot them,
  how the service is structured, how to extend it, and what the `bob` CLI
  offers. Load this skill only when the user asks about bob or the Intern
  itself. Do not load it during unrelated work, such as handling email,
  keeping a worklog, or managing tasks.
---

# The Intern documentation

This skill is an index into the manual for bob and the Intern. It does not
contain the manual's content and does not say how to operate bob. Find the
page that matches the user's question, read it, and answer from it.

## Topic index

Paths are relative to this skill's directory.

| Topic | Page |
|---|---|
| What bob is and how to get a first working chat session from the released binary | `references/quickstart/index.md` |
| Using the `bob` subcommands day to day, with worked examples | `references/end-user-guide/index.md` |
| Installing, building, configuring, running, observing, scheduling, and stopping the service; troubleshooting | `references/operator-guide/index.md` |
| How the service is structured and how a request moves through it | `references/architecture-overview/index.md` |
| Building on bob's public surfaces: the extension protocol and channel adapters | `references/extension-author-guide/index.md` |

The pages link to each other with relative links of the form
`../<directory>/index.md`; follow those links to reach related pages.

## Questions about the CLI

Do not answer questions about commands, flags, or options from the prose in
these pages. Run `bob --help` for the list of subcommands and
`bob <subcommand> --help` for one subcommand's usage, and answer from that
output, which is always current for the installed binary.
