---
id: S-009
title: Email
version: '0.6'
status: approved  # draft | review | approved | superseded
created: '2026-11-17'
author: planner
---

# Email

## Purpose

This spec covers S-000's **Email** component. Today a team member reaches The Intern only through the command line and
the web interface: nobody can hand it a job or answer a blocked job by email, and it can't read the mailboxes where
much of a team's work arrives (S-000 use cases 2, 4 and 6, pain point 6). The job record already waits for this spec:
S-004 reserves the origin letter `E` and lets an email answer resume a blocked job, and S-005 reserves the `bob mail`
group. When it is done, a team member sets up any number of mail accounts, each either **owned** by The Intern, where
every email that arrives becomes a job and The Intern may send, or **monitored**, where agents read, sort and draft but
never send and no email becomes a job. Success is an email request that becomes a job, is worked, and is answered in
its thread, with no email lost, doubled or sent twice.

## Definitions

This spec uses the Definitions of S-001 to S-008 (team member, job, short number, origin, request, status, resolution,
role, seat, tool set, handoff, workspace, front desk, service operation, observation feed, page, way in) and the shared
vocabulary of `docs/system_overview.html`. It adds these terms:

| Term | Meaning in this spec |
|---|---|
| Mail account | One mailbox The Intern can reach, with a name, an address, a kind and a sign-in (REQ-001). |
| Owned account | A mail account that belongs to The Intern. It is a way in, and The Intern may send from it (REQ-006). |
| Monitored account | Someone else's mailbox, a person's own or a shared one. Agents read, sort and draft in it; The Intern never sends from it, and no email in it becomes a job (REQ-010). |
| Inbox | The account's main incoming folder, `INBOX` in IMAP. |
| Intake | The daemon taking a new email from an owned account's inbox into a job (REQ-006). |
| Triage job | The job intake creates for a new email. Its first lead decides what the email is (REQ-008). |
| Triage role | The role of a triage job's first lead, set per owned account; the shipped `triage` role by default (REQ-008, REQ-019). |
| Request mark | A flag on a job that came by email, set by its lead when the email asks The Intern for something. It decides whether a result reply goes out (REQ-008, REQ-015). |
| Mail text | The text a lead writes for the person an email goes to, apart from the Blocked reason or justification it writes for the team. Only mail text is mailed (REQ-014, REQ-015). |
| Job thread | The emails linked to a job: the one that started it, the replies it received and every email The Intern sent from it (REQ-009). |
| Allowlist | The recipient addresses and domains an owned account may send to. Empty means anyone (REQ-012). |
| Notice address | The one address The Intern writes to about its own work: held-back mail and blocked questions that have no email sender to ask (REQ-013). |
| Mail tools | The agent tools of REQ-011, offered to a role whose tool set names `mail`. The mark request tool is a job tool, not a mail tool (REQ-008). |
| Account status | `connecting`, `ready`, `needs_sign_in` or `failing`, with the last error and its time (REQ-005). |
| Check interval | How often the daemon looks for new mail in an owned account when the server can't tell it at once; 60 seconds by default (REQ-023). |

## Users and Journeys

| Actor | Goal |
|---|---|
| Team member | Sets up accounts; gives The Intern work by email; answers its questions by email; asks it to read, sort and draft in a monitored mailbox; tailors triage. |
| Person outside the team | Anyone who writes to an owned address. Reaching the address makes them a team member (ADR-002 decision 1); whom The Intern may write back to is limited by the allowlist. |
| Triage agent | Decides what each new email is and moves the job on. |
| Agent in any job | Reads, sorts, drafts and, from an owned account, sends mail with the mail tools. |
| Mail servers | Google, Microsoft and any standard IMAP and SMTP host. |
| Developer | Tests every path against an in-process fake mail server and a fake model. |

Journeys, in priority order:

1. **Set up an account.** A team member adds an account from `bob mail create` or the Mail page, choosing its kind and
   either server settings with a password or a sign-in with Google or Microsoft. For an owned account they set its
   allowlist and triage role. The account shows `ready`. Delivered by REQ-001 to REQ-005, REQ-017, REQ-018.
2. **Email The Intern a request.** An email arrives in an owned account. The daemon saves it with its attachments and
   creates a triage job. The triage agent marks it as a request, rewrites the job and hands it off; the work is done;
   the sender gets one reply in their thread saying what was done. Delivered by REQ-006 to REQ-009, REQ-015, REQ-016.
3. **Answer a blocked job by email.** When a job blocks, its question goes to the sender in the job's thread, or to the
   notice address. A reply in the thread resumes the job. Delivered by REQ-009, REQ-013, REQ-014.
4. **Mail that needs no answer.** Notifications, newsletters, auto-replies and delivery failures become triage jobs
   that the agent records, relates or discards. Nothing is sent back. Delivered by REQ-008, REQ-015.
5. **Use a monitored mailbox.** A job or a schedule asks an agent to summarise, sort or draft replies in a monitored
   account. Nothing is sent and no email there becomes a job; the agent may still create follow-up jobs. Delivered by
   REQ-010, REQ-011.
6. **Tailor triage.** A team member adds instructions and skills to the triage role for certain topics. Delivered by
   REQ-008, REQ-019.
7. **Notice when something goes wrong.** An expired sign-in, an unreachable server or held-back mail shows on the
   account and reaches the notice address. Delivered by REQ-005, REQ-012, REQ-013.

## Exclusions

- **POP3, the Gmail API, Microsoft Graph and JMAP.** IMAP and SMTP reach every provider the team named. POP3 has no
  folders, flags or drafts, so neither sorting nor drafting would work.
- **Sending from a monitored account,** saved drafts included. A person sends a draft themselves.
- **Deleting for good, in any account.** Moving to Trash is allowed; emptying Trash and expunging are not.
- **Any filter before a job.** There is no sender filter and no spam filter on intake: the triage agent decides
  (product owner ruling). A team that wants to limit who can email The Intern does it on its mail server.
- **Mail that was there before.** Mail already in an owned account's inbox when the account first connects, and mail
  in its other folders, never becomes a job. Agents can still read it with the mail tools.
- **Mail from a monitored account becoming a job.** Product owner ruling: a monitored mailbox is not addressed to The
  Intern.
- **PGP and S/MIME.** Encrypted mail is saved as it arrives, and The Intern neither signs nor encrypts.
- **HTML composition.** What The Intern writes is plain text with attachments.
- **Calendar actions.** A `.ics` file is an attachment like any other.
- **Contacts and address books, server-side rules (Sieve), creating folders and changing account settings on the
  server.**
- **A shared OAuth app shipped with The Intern, and Google's app verification.** Each team registers its own app with
  Google or Microsoft.
- **Mail to the front desk and mail starting jobs by event.** Mail never reaches the front desk (S-001). An email to an
  owned account is a team member's request through the `email` way in, not an event (REQ-006), so S-007 REQ-014 keeps
  its rule with one sentence that says so. Mail in a monitored account starts nothing.
- **Two instances sharing one owned account.**
- **Notices in other channels.** The notice address is the only one.
- **Deleting saved mail on its own.** Saved mail lives as long as its job, as the rest of the job record does.

## Alternatives Considered

- **The daemon handles intake only, and agents use `bob mail` commands from `bash`, taught by a skill.** Rejected: the
  rules for monitored accounts and the allowlist would sit in commands an agent calls through a shell instead of in
  the tools it is given, and every action would mean parsing text again.
- **Copy monitored mailboxes into a local store that agents search.** Rejected: a sync engine, a copy of other people's
  mail, and views that go stale, for much more scope.
- **Accept requests only from listed senders.** Rejected by the product owner: every email to an owned account is a
  job, the triage agent decides, and the mail server limits who can write.
- **Turn every email into a work job directly, or sort mail with an agent before any job exists.** Rejected by the
  product owner in favour of the triage job, which keeps every email visible as a job and lets the team add triage
  rules per topic.
- **A short triage job that creates a separate job for each request.** Rejected: it splits one email thread across two
  jobs and adds a job to the board for every email.
- **Drop auto-replies and delivery failures in code.** Rejected by the product owner: an agent decides, and it may want
  to tell someone that a mail could not be delivered.
- **Mail every finished job's result to its sender.** Rejected by the product owner: only a completed request gets a
  result reply; a notification gets nothing back.
- **Put the job number in the subject so replies always find their job.** Rejected by the product owner: mail never
  shows The Intern's internals. A reply that lost its thread headers becomes a new triage job.
- **Keep mail credentials only in the operating system's keyring.** Rejected: on macOS the login keychain is locked
  when the service starts at boot with nobody logged in.
- **Only a command that prints the secret.** Rejected as the only way: OAuth tokens change as they are refreshed, so
  The Intern has to keep them itself.

## Interfaces

### Exposed: the configuration file

**Contract** (the sections that `config.toml` gains, S-002 REQ-021; one `[[mail_account]]` section per account, in any
order):

```toml
[mail]
notice_to = "ops@example.com"         # optional; the notice address (REQ-013)
notice_from = "intern"                # required with notice_to; an owned account with SMTP

[[mail_account]]
name = "intern"                       # required, unique
kind = "owned"                        # required: "owned" or "monitored"
address = "intern@example.com"        # required
imap_host = "imap.example.com"        # required
imap_port = 993                       # optional; default 993, or 143 with "starttls" or "none"
imap_security = "tls"                 # optional: "tls", "starttls" or "none"; default "tls"
smtp_host = "smtp.example.com"        # optional, owned only; none means the account sends nothing
smtp_port = 465                       # optional; default 465, or 587 with "starttls" or "none"
smtp_security = "tls"                 # optional: "tls", "starttls" or "none"; default "tls"
login = "intern@example.com"          # optional; default the address
auth = "password"                     # required: "password", "password_command", "google",
                                      # "microsoft" or "microsoft_app"
password_command = ["pass", "show", "mail/intern"]   # required for "password_command" only
client_id = "..."                     # required for "google", "microsoft" and "microsoft_app"
tenant = "organizations"              # "microsoft": a tenant ID, "organizations", "consumers" or "common";
                                      # "microsoft_app": a tenant ID
check_interval_seconds = 60           # optional; 10 to 3600, default 60
triage_role = "triage"                # optional, owned only; default "triage"
allow = ["ana@example.com", "@example.com"]          # optional, owned only; missing or empty means anyone
```

Unknown keys are refused, as for the rest of the file. REQ-001 and REQ-012 give each key's rules. Passwords, client
secrets and tokens are never keys of this file (REQ-002).

### Exposed: service operations

All are reachable through both listeners at `POST /operations/<name>` (S-003 REQ-003), and the client library gains
them with no listener change. Each returns S-002's errors. An account is named by its `name`. No operation returns a
secret.

| Operation | Kind | Input | Result | Requirement |
|---|---|---|---|---|
| `mail.accounts.list` | read | none | every account with its settings, status, last error and last check | REQ-005 |
| `mail.accounts.get` | read | `name` | the account; `not_found` | REQ-005 |
| `mail.accounts.create` | control | the keys of a `[[mail_account]]` section, and `password` or `clientSecret` where its `auth` needs one | the account; `invalid_input`, `conflict` | REQ-001, REQ-003 |
| `mail.accounts.change` | control | `name` and the values to change, a new `password` or `clientSecret` included | the account; `not_found`, `invalid_input`, `conflict` | REQ-001, REQ-003 |
| `mail.accounts.remove` | control | `name` | nothing; `not_found`, `conflict` | REQ-003 |
| `mail.accounts.signin` | control | `name` | for `microsoft`, the code and the address to enter it at; for `google`, the address to open; `not_found`, `invalid_input` | REQ-004 |
| `mail.accounts.test` | control | `name` | whether IMAP, and SMTP for an owned account, connected and logged in, with the server's message on failure; `not_found` | REQ-003 |
| `mail.notices.get` | read | none | the notice address and its sending account | REQ-013 |
| `mail.notices.set` | control | `to`, `from`, or neither to clear them | the notice settings; `invalid_input` | REQ-013 |

`jobs.get` gains a job's email details: the account, the sender, the subject, the saved message and attachments, the
job thread, and the request mark (REQ-007, REQ-008, REQ-009). `jobs.list` gains a filter by account. `jobs.complete`
gains an optional `mailText`, the result reply for a job with the request mark (REQ-015). A team member's or an agent's
`jobs.create` still can't name an email origin (S-002 AC-012.5).

### Exposed: feed events

The instance scope of the observation feed (S-002 REQ-014) carries:

| Delta | Carries |
|---|---|
| `settings_changed` (existing, S-002 REQ-022) | that mail accounts or the notice settings changed |
| job created (existing, S-004 REQ-015) | a triage job, with its origin |
| `mail_account_status` | the account name, its status, and the last error with its time |

The job scope carries a `mail` entry in the job's history for each email received into the job, each email sent from it,
each email held back by the allowlist, each email that may not have gone out, each result reply not sent for lack of a
mail text, each email the mail server permanently refused, and each owed email not sent because its account was removed
(REQ-003, REQ-009, REQ-012, REQ-015, REQ-022; the kinds are listed in S-004's history entry Contract).

### Exposed: the `bob mail` commands

These follow S-005's conventions: `--json`, exit codes, and short numbers in any letter case. A password or client
secret is read from the terminal without echo, or from standard input with `--secret-stdin`, never from a flag.

| Command | Operations called | Requirement |
|---|---|---|
| `bob mail list` | `mail.accounts.list` | REQ-017 |
| `bob mail show <name>` | `mail.accounts.get` | REQ-017 |
| `bob mail create <name>` | `mail.accounts.create`, with `--kind`, `--address`, `--imap-host`, `--imap-port`, `--imap-security`, `--smtp-host`, `--smtp-port`, `--smtp-security`, `--login`, `--auth`, `--password-command`, `--client-id`, `--tenant`, `--check-interval`, `--triage-role`, `--allow` | REQ-017 |
| `bob mail change <name>` | `mail.accounts.change`, with the same flags, `--disallow <entry>`, and `--new-secret` | REQ-017 |
| `bob mail signin <name>` | `mail.accounts.signin`, then waits for the account to turn `ready` | REQ-017 |
| `bob mail test <name>` | `mail.accounts.test` | REQ-017 |
| `bob mail remove <name>` | `mail.accounts.remove` | REQ-017 |
| `bob mail notices`, `bob mail notices set --to <address> --from <account>`, `bob mail notices clear` | `mail.notices.get`, `mail.notices.set` | REQ-017 |
| `bob jobs list --mail <name>` | `jobs.list` with the account filter | REQ-017 |

### Exposed: the Mail page and the Job page

A new page in S-006's sidebar at `/ui/#/mail` (REQ-018). S-006's Users row lets later specs add pages, so adding the
page changes no S-006 requirement; the email section of the Job page amends S-006 REQ-003, which lists the Job page's
contents. The page calls only these:

| Page | Reads and feed | Actions |
|---|---|---|
| Mail | `mail.accounts.list`, `mail.accounts.get`, `mail.notices.get`, `roles.list`, the instance feed | `mail.accounts.create`, `mail.accounts.change`, `mail.accounts.remove`, `mail.accounts.signin`, `mail.accounts.test`, `mail.notices.set` |

The Job page of a job that came by email shows the account, the sender, the subject, the saved message, the name and
size of each attachment, the job thread and the request mark (REQ-018). No attachment is sent to the browser.

### Exposed: tools

A role whose tool set names `mail` is offered the mail tools (REQ-011). Every mail tool names the account it acts on.

| Tool | Owned account | Monitored account | Does |
|---|---|---|---|
| list folders | yes | yes | the account's folders |
| search messages | yes | yes | messages in a folder matching sender, recipient, subject, text, date range and flags, newest first, with a limit |
| read message | yes | yes | headers, the text, and the list of attachments; the text of the HTML part when there is no plain text |
| save attachments | yes | yes | writes a message's attachments to a folder the agent names |
| move messages | yes | yes | to an existing folder, Trash included |
| set flags | yes | yes | sets or clears seen, flagged and answered |
| save draft | yes | yes | a plain-text draft with recipients, subject, attachments and an optional message it replies to, in the account's Drafts folder |
| send | yes, allowlist checked | refused | sends a plain-text email with recipients, subject, attachments and an optional message it replies to |

S-004's job tools change for jobs that came by email, whatever the role's tool set (REQ-008, REQ-014, REQ-015):

| Job tool | Change |
|---|---|
| mark request | new; offered to the lead of a job that came by email; sets or clears the request mark |
| block job | gains `mailText`, the question as the person asked by email reads it; required whenever the question will be mailed (REQ-014) |
| complete job | gains `mailText`, the result reply; required for a job with the request mark (REQ-015) |

Tool names and parameter layouts are not contract; the tasks fix them, as in S-004.

### Exposed: the mail The Intern sends

| Mail | To | When | Body | Requirement |
|---|---|---|---|---|
| Blocked question | the job's sender, in the job thread, when the job came by email and the sender is allowed; otherwise the notice address, in a thread of its own for the job | the lead blocks the job with a mail text that differs from the last one mailed for the job | the lead's mail text | REQ-014 |
| Result reply | the job's sender, in the job thread | a job with the request mark is completed with a mail text | the mail text | REQ-015 |
| Held-back notice | the notice address | the allowlist holds back an email | what was held back and for whom, in the daemon's own words | REQ-012 |
| Refused-mail notice | the notice address | the mail server permanently refuses an email that didn't go to the notice address | what was refused, for whom, and the server's message, in the daemon's own words | REQ-022 |

Each is plain text from the account that the job came through, or from the notice account. A Blocked reason or
completion justification is never mailed (REQ-016).

### Consumed

- S-001: the tool set (REQ-003), handoff (REQ-006), seat records and actors (REQ-007), the lead conversation a job
  source starts (REQ-012) and closed conversations (REQ-026).
- S-002: the configuration file and its settings operations (REQ-021, REQ-022), the origin built from the caller
  (REQ-012), idempotency keys (REQ-013), the observation feed (REQ-014), owner-only files (REQ-006) and the status
  operation (REQ-011).
- S-003: the routes for every operation (REQ-003); `email` as a way in that a listener never stamps (REQ-007).
- S-004: `jobs.create` with an email origin and the letter `E` (REQ-002, REQ-003), blocking and resuming (REQ-006),
  completing (REQ-007), related jobs (REQ-009), the history (REQ-011), job deltas (REQ-015) and the export (REQ-016).
- S-005: the `mail` group name it held for this spec, and the conventions of every group.
- S-006: the sidebar, the Job page, the style, and the rules for refusals, lost connections and browsers.
- S-008: the internal folder that carries shipped instructions (REQ-001, REQ-002).
- The mail servers: IMAP and SMTP with TLS, STARTTLS or no encryption, and password or OAuth login; Google's and
  Microsoft's OAuth endpoints.

## Workflow

```text
Team member adds an account: command, page or hand edit + restart                        REQ-001 to REQ-003
  (invalid → refused, nothing changes; hand edit invalid → the next start stops)         REQ-001, REQ-002
  OAuth → sign-in: Microsoft code, Google browser address, or app access              REQ-004
First successful connection → mail already in the inbox is left alone                    REQ-006
  (login refused, server down → needs_sign_in or failing, retried; others go on)         REQ-005
New email in an owned inbox                                                              REQ-006, REQ-023
  (reply in an open job's thread → input to that job's lead; Blocked → resumes)          REQ-009
  (reply in a Done job's thread → new triage job related to the old one)                 REQ-009
Message and attachments saved; triage job E-n created with the account's triage role     REQ-007, REQ-008
  (triage seat has no model → created all the same; its lead waits for a model)          REQ-007
  (crash and restart → still one job for that email)                                     REQ-021
Triage agent decides                                                                     REQ-008
  discard / information only → completes; nothing is sent                               REQ-008, REQ-015
  request → request mark, new title and definition of done, handoff                      REQ-008
  missing information → blocks                                                           REQ-008
Lead blocks a job with a mail text → question by email                                  REQ-014
  (sender allowed → in the job thread; otherwise → notice address; none → not mailed)    REQ-013, REQ-014
  (same mail text as the last one mailed, or a block by the daemon → not mailed)         REQ-014
Reply arrives in the thread → the job resumes                                            REQ-009
Request job completed with a mail text → result reply in the thread                     REQ-015
  (crash after the job write, before sending began → sent after the restart)             REQ-022
  (recipient not allowed → held back, notice to the notice address)                      REQ-012
  (crash while sending → not sent again; the history says it may not have gone out)      REQ-022
Agents in any job use the mail tools; monitored accounts refuse send and never feed jobs  REQ-010, REQ-011
```

## Behavioral Requirements

### REQ-001 — A mail account

A mail account SHALL have the values of the `[[mail_account]]` contract, and the daemon SHALL refuse an account that
breaks any rule, with a message naming the account, the key and the reason:

- `name`: required and unique in the instance, 1 to 64 characters of letters, digits and hyphens, starting with a
  letter or digit; compared case-sensitively; it can't be changed.
- `kind`: required, `owned` or `monitored`. It can't be changed; a team member removes the account and adds it again.
- `address`: required, one email address.
- `imap_host`, `smtp_host`: host names; `imap_port`, `smtp_port`: 1 to 65535. A monitored account SHALL NOT name an
  SMTP host.
- `imap_security`, `smtp_security`: optional, `tls`, `starttls` or `none`; `tls` when missing. The daemon SHALL connect
  as the account says: `none` sends the login and the mail unencrypted, which is the team's choice, for example for a
  mail server on a local machine. With `tls` or `starttls`, a server whose certificate doesn't verify SHALL set the
  account `failing` with the reason.
- `auth`: required, one of the five values. `password_command` is required with `password_command` and refused
  otherwise; `client_id` is required with `google`, `microsoft` and `microsoft_app`; `tenant` is required with
  `microsoft` and `microsoft_app`, and `microsoft_app` takes a tenant ID only.
- `check_interval_seconds`: optional, a whole number from 10 to 3600; 60 when missing.
- `triage_role`: optional, owned only, an existing role; `triage` when missing.
- `allow`: optional, owned only, a list of email addresses and `@domain` entries (REQ-012).

A taken name SHALL be refused `conflict`, and every other broken rule `invalid_input`. Removing a role that an owned
account names as its triage role SHALL be refused `conflict`, naming the account, as S-007 does for schedule entries.

#### AC-001.1 — Refused values

- **Given:** a running daemon with no accounts
- **When:** a team member calls `mail.accounts.create` with, in turn, a name with a space, `kind = "shared"`, two
  addresses, a monitored account with an SMTP host, `auth = "google"` without a client ID, `auth = "password_command"`
  without a command, `check_interval_seconds = 5`, an unknown triage role and an `allow` entry `example`
- **Then:** each call is refused `invalid_input` naming the key, the file is unchanged, and no account exists

**Verification:** test — a service test of the account operations.

#### AC-001.2 — A taken name and a triage role in use

- **Given:** an owned account `intern` whose triage role is the team role `sorter`
- **When:** a team member creates another account named `intern`, then removes the role `sorter`
- **Then:** both calls are refused `conflict`, naming the account, and nothing changes

**Verification:** test — a service test of the account operations.

### REQ-002 — Accounts live in the configuration file; secrets don't

The configuration file SHALL hold mail accounts as `[[mail_account]]` sections and the notice settings in `[mail]`
(Interfaces). It stays the single source of truth for them (S-002 REQ-022). A hand edit SHALL take effect at the next
restart, and an invalid section SHALL stop startup with an error naming the file, the account and the reason (S-002
REQ-021).

Passwords, client secrets and OAuth tokens SHALL be kept in the instance's secrets store, apart from the configuration
file. The store holds the secrets of every kind of account The Intern connects to; mail accounts are its only users
today, and a later spec, such as one for calendars and contacts, keeps its secrets there too. The store is owner-only
(S-002 REQ-006), written atomically, written only by the account operations and by sign-in and token refresh, and never
shown back. An account whose `auth` needs a secret the store doesn't hold SHALL start with status `needs_sign_in`
(REQ-005), not stop startup. Removing an account SHALL remove its secrets, and at startup the daemon SHALL remove the
secrets of any account the configuration file no longer holds.

#### AC-002.1 — A hand edit at the next restart

- **Given:** a stopped daemon and a hand-written valid `[[mail_account]]` section with `auth = "password_command"`
- **When:** the daemon starts
- **Then:** `mail.accounts.list` shows the account, and it connects with the command's output

**Verification:** test — a service test against the fake mail server.

#### AC-002.2 — A bad hand edit stops startup; a missing secret doesn't

- **Given:** in turn, a `[[mail_account]]` section with an unknown key, and a valid section with `auth = "password"`
  whose password was never given
- **When:** the daemon starts
- **Then:** the first start stops with an error naming the account and the key; the second reports ready with the
  account `needs_sign_in`

**Verification:** test — a service test of the account operations.

### REQ-003 — Adding, changing, testing and removing accounts

A valid `mail.accounts.create`, `mail.accounts.change`, `mail.accounts.remove` or `mail.notices.set` SHALL be written
to the configuration file first, atomically and owner-only, and apply at once, as S-002 REQ-022 states for settings; a
secret it carries SHALL go to the secrets store in the same step. If the file changed on disk since the daemon last
read it, the call SHALL be refused `conflict`, naming the file, and nothing changes.

A change to `imap_host`, `login` or `address` SHALL start the account afresh: mail in its inbox at the next successful
connection is left alone (REQ-006). Removing an account SHALL stop its intake and tools, leave its jobs, their saved
mail and their history in place, and leave running jobs to carry on; mail tools that name it are refused from then on.
Mail the account still owes SHALL never be sent, even if an account with the same name is added later, and each such
email SHALL get the history entry "not sent: account removed".
Removing the account the notice settings name SHALL be refused `conflict`.

`mail.accounts.test` SHALL connect and log in to IMAP, and to SMTP for an owned account with an SMTP host, send
nothing, change nothing, and report each result with the server's message on failure.

#### AC-003.1 — Create, test, change, remove

- **Given:** a running daemon and the fake mail server
- **When:** a team member creates an owned account with a password, tests it, adds `@example.com` to its allowlist and
  removes it
- **Then:** the file holds the section after the create and the change, the test reports IMAP and SMTP logged in, the
  password is in no response and not in the file, and after the removal the section and its secrets are gone

**Verification:** test — a service test against the fake mail server.

#### AC-003.2 — A hand edit is never overwritten

- **Given:** the configuration file changed on disk after the daemon read it
- **When:** a team member calls `mail.accounts.change`
- **Then:** the call is refused `conflict` naming the file, and the file keeps the hand edit

**Verification:** test — a service test of the account operations.

### REQ-004 — Sign-in

The daemon SHALL log in to each account by its `auth`:

- `password`: the password the team member gave, from the secrets store. App passwords are passwords.
- `password_command`: the standard output of the command, run as the service account each time a login needs the
  secret, with its trailing line end removed. A command that fails or prints nothing SHALL set the account `failing`
  with the command's exit status, never its output.
- `microsoft`: OAuth with the team's client ID and tenant. `mail.accounts.signin` SHALL return a code and the address
  to enter it at, which a team member uses from any device; when they finish, the account turns `ready`.
- `google`: OAuth with the team's client ID and client secret of a Google "Desktop app" client. `mail.accounts.signin`
  SHALL return an address to open in a browser and the loopback port Google's answer returns to. The daemon SHALL
  listen for that answer on `127.0.0.1` only, on a free port it picks for this sign-in, for at most 10 minutes, and
  accept nothing there but the answer; it is not an S-003 listener and carries no operations. A team member on another
  machine forwards that port, as the manual explains (REQ-025). If no answer arrives in time, the account stays
  `needs_sign_in`.
- `microsoft_app`: app-only access with the team's client ID, tenant ID and client secret, granted to the mailbox by
  the organisation's Microsoft 365 administrator. No person signs in.

The daemon SHALL refresh OAuth access tokens before they expire, with nobody present, and SHALL keep the newest refresh
token each refresh returns (REQ-020). When a provider refuses the refresh token, or no sign-in has happened yet, the
account SHALL turn `needs_sign_in` (REQ-005). `mail.accounts.signin` SHALL be refused `invalid_input` for `password`,
`password_command` and `microsoft_app` accounts; `mail.accounts.test` checks a `microsoft_app` account's access.

#### AC-004.1 — Device code sign-in

- **Given:** an owned account with `auth = "microsoft"` and a fake OAuth provider
- **When:** a team member calls `mail.accounts.signin` and the provider reports the code entered
- **Then:** the call returned a code and an address, the account turns `ready`, and intake starts

**Verification:** test — a service test against the fake mail server and fake OAuth provider.

#### AC-004.2 — Refresh with nobody present

- **Given:** a signed-in OAuth account whose access token expires every few minutes, and a provider that returns a new
  refresh token each time
- **When:** the account works for longer than several token lifetimes, and the daemon restarts in between
- **Then:** the account stays `ready`, and after the restart it uses the newest refresh token

**Verification:** test — a service test against the fake OAuth provider.

#### AC-004.3 — A revoked sign-in

- **Given:** a signed-in OAuth account
- **When:** the provider revokes its refresh token
- **Then:** the account turns `needs_sign_in` with the provider's message, intake for it pauses, and other accounts go
  on

**Verification:** test — a service test against the fake OAuth provider.

### REQ-005 — Account status

Each account SHALL have a status, reported by `mail.accounts.list`, `mail.accounts.get`, the status operation and the
`mail_account_status` delta:

- `connecting`: not checked yet since it was added, changed or the daemon started. Nobody needs to act; the first
  connection turns it into one of the other three.
- `ready`: its last connection and login succeeded.
- `needs_sign_in`: it has no usable secret or token, or the provider refused its sign-in.
- `failing`: anything else stops it, such as an unreachable server, a refused password or a failed password command.

The status SHALL carry the last error and its time, and the time of the last check. A `failing` account SHALL be
retried, first after its check interval and then at doubling pauses of at most 30 minutes, until it connects; a
`needs_sign_in` account SHALL wait for `mail.accounts.signin` or a changed secret. One account's state SHALL NOT stop
or slow another's.

#### AC-005.1 — An outage and its recovery

- **Given:** two owned accounts on the fake mail server
- **When:** the first one's server stops answering for an hour of test time, then answers again
- **Then:** the first shows `failing` with the error, its retries are spaced by growing pauses no longer than 30
  minutes, the second keeps taking in mail, and the first returns to `ready`

**Verification:** test — a service test against the fake mail server under the test clock.

#### AC-005.2 — A new account connects

- **Given:** a running daemon and the fake mail server, set to answer slowly
- **When:** a team member creates an owned account, and later restarts the daemon
- **Then:** after the create and after the restart, the account shows `connecting` until its first connection ends,
  then `ready`, and both changes reach the feed

**Verification:** test — a service test against the fake mail server.

### REQ-006 — Intake: every new email in an owned inbox becomes a job

For each owned account, the daemon SHALL take in every email that arrives in its inbox after the account's first
successful connection, or after a change that starts it afresh (REQ-003). Each such email SHALL either reach the open
job of its thread (REQ-009) or become exactly one new triage job (REQ-007). Intake SHALL NOT filter on sender, content,
headers or auto-reply markers. Each such email is a team member's request through the `email` way in, since reaching the
address makes a team member (ADR-002 decision 1); it is not an event (S-007 REQ-014).

Mail already in the inbox at the first successful connection, and mail in any other folder, SHALL NOT become a job.
Intake SHALL NOT move, flag or delete the email on the server; agents sort it with the mail tools. A monitored account
SHALL have no intake (REQ-010).

#### AC-006.1 — An existing inbox is left alone

- **Given:** an owned account whose inbox on the fake server holds 5,000 messages
- **When:** the account connects for the first time, and then one new email arrives
- **Then:** no job exists for the 5,000, and exactly one triage job exists for the new email

**Verification:** test — a service test against the fake mail server.

#### AC-006.2 — No filter

- **Given:** an owned account
- **When:** an ordinary email, an out-of-office reply, a delivery failure report and a mailing-list message arrive
- **Then:** each becomes one triage job, and nothing is sent

**Verification:** test — a service test against the fake mail server.

### REQ-007 — Saving the email and creating the triage job

Before creating the job, the daemon SHALL save the email: the message exactly as received, its text, and each
attachment as a file, byte for byte. Then it SHALL create the job through `jobs.create` with:

- the request: the sender, the subject, the date, the text, and where the saved message and attachments are
- the origin: way in `email`, with the account name, the message's `Message-ID` and the sender, which the daemon
  observes (S-004 REQ-003)
- the account's triage role as the lead's role, with that role's defaults

The job's agents SHALL be able to read the saved message and attachments as files. An email without a `Message-ID`
SHALL still become a job.

Intake SHALL NOT change when the triage role's seat has no model (S-001 REQ-003): the email is saved and the triage
job is created as above, and its lead waits for a model like a team member's job, with the no-model notice in its
transcript (S-001 REQ-027; S-004 REQ-023). It runs once a model is available (product owner, 2026-11-24, CR-002). A
reply that reaches an open job's lead (REQ-009) waits the same way when that lead has no model.

#### AC-007.1 — The saved email

- **Given:** an owned account
- **When:** an email with a 10 kB PDF and a text attachment arrives
- **Then:** the triage job `E-n` has origin `email` with the account, the `Message-ID` and the sender; its lead is the
  account's triage role; and the lead reads the saved message and both attachments, identical to what was sent

**Verification:** test — a service test against the fake mail server.

#### AC-007.2 — A new email with no model

- **Given:** an owned account whose triage role has no configured model, and pi agent settings that name no default
  model
- **When:** an email arrives, and later the settings name the fake model as the default while the daemon runs
- **Then:** the email is saved and the triage job `E-n` is created, To do, with its lead holding the first input
  followed by the no-model notice and making no model request; after the change, within 30 seconds and without a
  restart, the lead runs on that input

**Verification:** test — a service test against the fake mail server on the fake model, changing the isolated pi agent
folder while the daemon runs.

### REQ-008 — The triage job

The shipped triage instructions (REQ-019) SHALL direct a triage job's lead, as its first duty (S-004 REQ-008), to write
the job's definition of done as "a decision is taken about this email", and then to take one of these decisions:

- **Discard** (spam, auto-replies, delivery failures and the like): complete the job with a justification saying why.
- **Information only:** record what matters, relate the job to others where useful, and complete it.
- **Request:** set the request mark, rewrite the title, description and definition of done (S-004 REQ-004), and hand
  the job off to the role that should do the work (S-001 REQ-006). The job stays one job with one thread.
- **Missing information:** block the job with its question and a mail text for the sender (REQ-014).

The mark request tool SHALL be a job tool (amending S-004's job tools and REQ-013), offered to the lead of a job that
came by email whatever its role's tool set, and refused for any other agent or job. It sets or clears the request mark
until the job is Done; `jobs.get` and the Job page show the mark. Team members add triage rules for their own topics
as instructions and skills of the triage role (S-008); this spec adds no rule engine.

#### AC-008.1 — The mark only on email jobs

- **Given:** a triage job `E-3` whose lead's role names no `mail`, and a command-line job `C-4`
- **When:** each lead calls mark request, and then an invoked `gp` agent in `E-3` calls it
- **Then:** `E-3` is marked, and the calls in `C-4` and from the invoked agent are refused with a reason

**Verification:** test — a service test with the fake model.

#### AC-008.2 — Triage decisions with a real model

- **Given:** the shipped `triage` role on a real low-cost model and an owned account
- **When:** a request, a newsletter and an out-of-office reply arrive
- **Then:** each job's definition of done was written by its lead; the request is marked and handed off with a
  rewritten definition of done; the other two are completed with a justification; only the request gets a reply,
  after its job is completed

**Verification:** test — a live check over the pi agent login (`npm run test:live:mail`).

### REQ-009 — Job threads

The daemon SHALL record, for each job, the `Message-ID` of every email in its job thread: the one that started it,
every email received into it, and every email The Intern sends from it, by itself or through the send tool. An email
arriving in an owned inbox whose `In-Reply-To` or `References` names a recorded `Message-ID` SHALL be saved as in
REQ-007 and then:

- when the job isn't Done, reach the job's lead conversation as a follow-up from the sender, with way in `email`
  (S-001 REQ-020, ADR-004), which resumes a Blocked job (S-004 REQ-006)
- when the job is Done, become a new triage job related to it (S-004 REQ-009)

An email that names no recorded `Message-ID` SHALL become a new triage job. Linking SHALL use only these headers and
the daemon's own record, never anything visible in the subject or body (REQ-016).

#### AC-009.1 — Replies reach the open job

- **Given:** triage job `E-5` from `ana@example.com`, Blocked with a question sent to her
- **When:** she replies to the question, and later replies again while the job is In progress
- **Then:** both replies reach `E-5`'s lead as input from her; the first resumed the job; no new job exists

**Verification:** test — a service test against the fake mail server.

#### AC-009.2 — A reply to a Done job, and a reply without headers

- **Given:** a Done job `E-6`
- **When:** a reply in its thread arrives, then an email that quotes it but has no `In-Reply-To` or `References`
- **Then:** the first becomes a new triage job related to `E-6`, the second a new triage job related to nothing, and
  `E-6` is unchanged

**Verification:** test — a service test against the fake mail server.

### REQ-010 — Monitored accounts never feed jobs and never send

The daemon SHALL never create a job, or give input to a job, from an email in a monitored account. No operation or tool
of The Intern SHALL send from a monitored account, and the send tool SHALL be refused there before anything reaches the
server. An agent that reads a monitored account may still create a follow-up job (S-004 REQ-003); its origin names the
agent's conversation, not email.

This holds for The Intern's own paths. An agent whose role's tool set names `bash` acts with the service account's
access, as ADR-002 decision 4 states; this spec puts no limit on it and adds no instruction about it (product owner
ruling).

#### AC-010.1 — Send refused, nothing reaches the server

- **Given:** a monitored account on the fake server, and a job whose lead has the mail tools
- **When:** the lead calls send on it, and a reply to one of its messages arrives in that mailbox
- **Then:** the send is refused with a reason, the fake server's SMTP side received nothing, and no job and no input
  came from the reply

**Verification:** test — a service test against the fake mail server.

#### AC-010.2 — Sort and draft a monitored mailbox

- **Given:** a monitored account `support` with ten messages, and a scheduled job whose lead has the mail tools
- **When:** the lead moves three to an existing folder, flags two and saves two drafts replying to messages
- **Then:** the fake server shows the moves, the flags and the two drafts in the Drafts folder, nothing was sent, and
  no job came from the account's mail

**Verification:** test — a service test against the fake mail server.

### REQ-011 — The mail tools

A role SHALL be able to name `mail` in its tool set (amending S-001 REQ-003), and an agent of such a role SHALL be
offered the mail tools of Interfaces in a job's conversation. The front desk SHALL NOT be offered them. The mark
request tool is a job tool (REQ-008), not one of them. Every tool
names an account and SHALL be refused with a reason for an unknown account, an account that isn't `ready`, a folder
that doesn't exist, or a file it can't read. In addition:

- move messages SHALL accept only existing folders, and no tool SHALL delete for good, empty a folder or expunge
- save draft SHALL put the draft in the account's Drafts folder and send nothing
- send SHALL be offered for owned accounts with an SMTP host only, check every recipient (REQ-012), put one copy in
  the account's Sent folder, and join the job thread (REQ-009)
- save attachments SHALL write files byte for byte, and refuse to overwrite an existing file

A tool call with the same tool call id SHALL act once, as for S-004's job tools.

#### AC-011.1 — The tools only where the tool set names them

- **Given:** a role `reader` whose tool set is `read` and `mail`, and `gp`, whose tool set doesn't name `mail`
- **When:** an agent of each is seated in a job, and the front desk is listed
- **Then:** only the `reader` agent is offered the mail tools

**Verification:** test — a service test with the fake model.

#### AC-011.2 — No permanent deletion

- **Given:** an owned account and an agent with the mail tools
- **When:** it moves a message to Trash, and asks to move one to a folder that doesn't exist
- **Then:** the first is in Trash on the fake server and not expunged, and the second is refused with a reason

**Verification:** test — a service test against the fake mail server.

### REQ-012 — The allowlist

Every email The Intern sends from an owned account, by itself or through the send tool, SHALL go only to recipients
the account's allowlist allows. An entry is a full address, matched without regard to letter case, or `@domain`,
matching every address at that domain and not its subdomains. An empty or missing list allows anyone. The notice
address is always allowed.

When any recipient of an email isn't allowed, the daemon SHALL send none of it, tell the agent why when the send tool
asked, record the held-back email in the job's history, and send one held-back notice to the notice address naming
the account, the recipients that weren't allowed and the subject (REQ-013).

#### AC-012.1 — Held back

- **Given:** an owned account with `allow = ["@example.com"]` and a notice address
- **When:** an agent sends to `ana@example.com` and `bo@other.org` in one call
- **Then:** nothing reaches either, the agent is told `bo@other.org` isn't allowed, the job's history records the
  held-back email, and the notice address receives one notice

**Verification:** test — a service test against the fake mail server.

#### AC-012.2 — Matching

- **Given:** `allow = ["Ana@Example.com", "@team.org"]`
- **When:** the rules are checked for `ana@example.com`, `x@team.org`, `x@dev.team.org` and `ana@example.org`
- **Then:** the first two are allowed and the last two are not

**Verification:** test — a unit test.

### REQ-013 — The notice address

The notice settings SHALL name one address and one owned account with an SMTP host to send from; `mail.notices.set`
SHALL refuse any other account `invalid_input`. The notice address SHALL NOT be the address of any owned account,
compared without regard to letter case as in REQ-012: `mail.notices.set`, `mail.accounts.create`, `mail.accounts.change`
and loading the configuration file SHALL refuse that pairing `invalid_input`, because the notice mail would land in an
owned inbox and feed a job. The notice address SHALL receive:

- a held-back notice for each email the allowlist holds back (REQ-012)
- a refused-mail notice for each email the mail server permanently refuses, unless that email went to the notice
  address itself (REQ-022)
- the blocked question of any job that has no allowed email sender to ask (REQ-014), in a thread of its own for that
  job, which joins the job thread (REQ-009)

When no notice address is set, these are not mailed; held-back emails and blocked questions are still in the job's
history, on the Job page and in `bob`.

#### AC-013.1 — A command-line job's question

- **Given:** a notice address `ops@example.com` sent from `intern`, and a job `C-7` created from the command line
- **When:** `C-7`'s lead blocks it with a mail text, and `ops@example.com` replies to the question
- **Then:** the mail text went to `ops@example.com` from `intern`, and the reply resumed `C-7` as input from
  `ops@example.com`

**Verification:** test — a service test against the fake mail server.

#### AC-013.2 — A notice address that is an owned inbox

- **Given:** an owned account `intern@example.com`
- **When:** a team member sets the notice address to `intern@example.com`, and a hand edit does the same before a
  restart
- **Then:** the call is refused `invalid_input`, and the start stops with an error naming the key

**Verification:** test — a service test of the account operations.

### REQ-014 — The blocked question by email

When a lead blocks its job (S-004 REQ-006) and the question can be mailed, the block job tool SHALL require a mail
text, and the daemon SHALL send that mail text:

- to the job's sender, as a reply in the job thread, from the account the job came through, when the job came by email,
  the account can send, and the allowlist allows the sender
- otherwise, to the notice address, from the notice account, in a thread of its own for the job, when one is set

The question can be mailed when one of these two destinations exists. A mail text equal to the last one mailed for the
job SHALL NOT be mailed again, so an auto-reply that resumes the job can't start a loop. A block the daemon makes itself
(S-004 REQ-008) SHALL NOT be mailed. The subject SHALL be the subject of the email that started the job, or, for a job
that didn't come by email, the first line of the mail text, never the job's title. A reply resumes the job (REQ-009).
The Blocked reason SHALL wait on the Job page and in `bob` whether or not a question was mailed.

#### AC-014.1 — To the sender

- **Given:** a triage job from `ana@example.com` through `intern`, with `ana@example.com` allowed
- **When:** its lead blocks it with the reason "Ana's request names no server; see C-2" and the mail text "Which
  server do you mean?"
- **Then:** Ana receives one email, a reply in her thread with the mail text only, and the job's history records it

**Verification:** test — a service test against the fake mail server.

#### AC-014.2 — No loop, no daemon blocks

- **Given:** the job of AC-014.1, Blocked with its question mailed
- **When:** an out-of-office reply resumes it and the lead blocks again with the same mail text; later the reminder rule
  blocks it (S-004 REQ-008)
- **Then:** no further email is sent, and both blocks are in the job's history

**Verification:** test — a service test against the fake mail server.

#### AC-014.3 — A mail text is required

- **Given:** the job of AC-014.1
- **When:** its lead calls block job with a reason and no mail text
- **Then:** the call is refused with a reason, and the job stays In progress

**Verification:** test — a service test with the fake model.

### REQ-015 — The result reply

When a job that came by email, with the request mark set, is completed (resolution `completed`), the daemon SHALL send
the completion's mail text to the job's sender as a reply in the job thread, from the account the job came through,
when that account can send and the allowlist allows the sender. The complete job tool SHALL require a mail text for a
job with the mark. A team member's `jobs.complete` MAY give one, through `bob jobs complete --mail-text` or the Job
page's complete action; without it, no reply is sent and the history records "result reply not sent: no mail text".
A job without the mark, or a cancelled job, SHALL send nothing. The justification is never mailed.

#### AC-015.1 — Only a completed request answers

- **Given:** three triage jobs from allowed senders: one marked and completed with a mail text, one unmarked and
  completed, one marked and cancelled by a team member
- **When:** each reaches Done
- **Then:** only the first sender receives a reply, in their thread, with the mail text and not the justification

**Verification:** test — a service test against the fake mail server.

### REQ-016 — No internals in mail

What the daemon itself puts in an email (the headers, the `Message-ID`, the held-back and refused-mail notices) SHALL
contain no short number, job, conversation or request ID, role name, tool name or path of saved mail, and the daemon
SHALL add no header beyond the standard ones. The daemon SHALL never mail a Blocked reason or completion justification,
which are written for the team; only a lead's mail text is mailed (REQ-014, REQ-015).

The shipped common prompt and triage instructions (REQ-019) SHALL tell agents that mail texts and mail they send show
none of these unless the person they write to asked for one.

#### AC-016.1 — What the daemon adds is clean

- **Given:** every email the service tests of this spec cause The Intern to send, with leads whose reasons and
  justifications hold short numbers and paths, and a command-line job titled "Fix the C-7 regression" whose question
  goes to the notice address
- **When:** a check scans subjects, bodies and headers
- **Then:** no email holds a reason, a justification or a job title, and nothing the daemon added holds a short
  number, an ID, a role or tool name, or a saved-mail path

**Verification:** test — a check run over the sent mail of the service tests.

#### AC-016.2 — Agent-written mail

- **Given:** the shipped instructions on a real low-cost model
- **When:** a request job is worked, blocked with a question and completed, and its agent writes to the sender with the
  send tool
- **Then:** no mail text or sent email names a job number or internal name

**Verification:** test — a live check over the pi agent login (`npm run test:live:mail`).

### REQ-017 — The `bob mail` commands

The `mail` group SHALL leave S-005's reserved groups and hold the commands of Interfaces. `bob mail list` SHALL print
each account's name, address, kind, status and last check; `bob mail show` its settings, allowlist, triage role, status
and last error, never a secret; `bob mail signin` SHALL print the code and address, or the address to open, and wait
until the account is `ready` or the sign-in fails. A secret SHALL be read without echo or from standard input, never
from a flag or the environment. `bob jobs list --mail` SHALL filter by account.

#### AC-017.1 — The commands

- **Given:** a running daemon and the fake mail server
- **When:** a team member runs `bob mail create intern --kind owned ...` typing the password, then `list`, `show`,
  `test`, `change --allow @example.com`, `notices set`, `remove` and `bob jobs list --mail intern`
- **Then:** each prints what this requirement names, `--json` gives the same data, no output holds the password, and a
  refused call exits with S-005's code for it

**Verification:** test — a command-line service test.

### REQ-018 — The Mail page and email on the Job page

The Mail page SHALL list the accounts with their status, update it from the feed, and let a team member do what the `bob
mail` commands do: create, change, test, sign in, remove, and set the notice settings. Sign-in SHALL show the Microsoft
code and address, or a link to Google's sign-in. A secret field SHALL never be filled from the service. The Job page of
a job that came by email SHALL show the account, sender, subject, saved message, the name and size of each attachment,
the job thread and the request mark. It SHALL offer no download of an attachment: only the job's agents read
attachments, as files (REQ-007).

#### AC-018.1 — The page

- **Given:** a browser on the Mail page and the fake mail server
- **When:** a team member creates an owned account, tests it, signs in a `microsoft` account against the fake provider
  and opens a triage job's Job page
- **Then:** the account appears `ready` without a reload, the code and address show during sign-in, and the Job page
  shows the email, each attachment's name and size with no download link, and the request mark

**Verification:** test — a web test.

### REQ-019 — The shipped `triage` role

The Intern SHALL ship a `triage` role (amending S-001 REQ-001 and S-008 REQ-001), whose tool set is `read` and `mail`,
whose default skills are `about-the-intern`, and whose instructions direct the agent to:

- write the definition of done as its first duty, read the saved email and its attachments
- take one of the decisions of REQ-008, and set the request mark only when the email asks The Intern for something
- write mail texts for the person who will read them
- for a request, rewrite the job so that its definition of done states the work, and hand off to a suitable role
- show no internals in any mail it writes (REQ-016)
- follow the team's own triage instructions and skills

A team member SHALL be able to change the role's instructions, tool set and defaults like any shipped role's (S-001
REQ-003, S-008).

#### AC-019.1 — The shipped instructions match

- **Given:** the shipped `triage` instruction file
- **When:** a reviewer reads it against this requirement
- **Then:** it covers reading, the four decisions, the request mark, the rewrite and handoff, no internals, and the
  team's own rules

**Verification:** inspection — the shipped instruction file; a unit test checks the role's tool set.

## Quality Requirements

### REQ-020 — Secrets stay secret

Passwords, client secrets and OAuth tokens SHALL appear in none of: the database, the export, logs, the feed, operation
results, command output, web pages, error messages, job history, or any model context or tool result. Each refreshed
token SHALL be written to the secrets store before it is used, atomically, so a crash never loses the newest one.

ADR-002 decision 5 and S-002 REQ-018 say that no credential is copied into the instance; this spec amends them so that
the instance keeps the account secrets a team member gives it, and the tokens it obtains, in its owner-only secrets
store.
The service account can read that store, as it can read every credential it acts with (ADR-002 decision 4).

#### AC-020.1 — Nowhere but the store

- **Given:** an account set up with a password and another with OAuth, after intake, sending, a refresh and an export
- **When:** a check searches the database, the export, the logs, the recorded feed, command output and the model
  requests the fake model received for each secret
- **Then:** no secret is found

**Verification:** test — a service test.

### REQ-021 — No email lost or doubled

Every email that arrives in an owned inbox after the account's starting point SHALL be taken in exactly once, whatever
crashes, restarts, server outages or sign-in pauses happen in between. The email stays on the server, so intake that
was interrupted resumes at the next connection. If the server can no longer tell old mail from new, the daemon SHALL
take in none of the mail present at that moment, and the account's last error SHALL say so. The guarantee holds within
one database's history: a rollback (S-010 REQ-009) or an import of an older copy (S-004 REQ-017) can take in again mail
that arrived after the copy was taken. The record this needs
amends ADR-001 decision 4 and S-004 REQ-018 (Assumptions and Dependencies).

#### AC-021.1 — Kill and restart

- **Given:** an owned account receiving 20 emails
- **When:** the daemon is killed at random points during intake and restarted each time, and the server is down for a
  while
- **Then:** exactly 20 triage jobs or thread inputs exist, one per email

**Verification:** test — a service test that kills the daemon.

### REQ-022 — Sending at most once

Each email The Intern sends SHALL go out at most once. A blocked question or result reply SHALL be recorded as owed in
the same step as the job change that causes it, so a crash between the two leaves neither. After a restart, an owed
email whose sending never began SHALL be sent. When a crash leaves it unknown whether an email that began sending went
out, the daemon SHALL NOT send it again, and SHALL record in the job's history that it may not have gone out. The
guarantee holds within one database's history: a rollback (S-010 REQ-009) or an import of an older copy (S-004
REQ-017) can send again an email the copy still records as owed.

When the mail server permanently refuses an email The Intern sends, such as an address that doesn't exist, the daemon
SHALL NOT try it again, SHALL record "refused by the server" with the server's message in the job's history, and SHALL
send one notice about it to the notice address (REQ-013), unless the refused email was itself addressed to the notice
address. A server that only fails for now, or can't be reached, is retried as REQ-005 states.

#### AC-022.1 — A crash while sending

- **Given:** a request job being completed, its result reply in flight
- **When:** the daemon is killed before the server's answer is recorded, and restarted
- **Then:** the fake server received the reply at most once, and the job's history says it may not have gone out

**Verification:** test — a service test that kills the daemon.

#### AC-022.2 — A crash before sending began

- **Given:** a request job whose completion is written
- **When:** the daemon is killed before it begins sending the result reply, and restarted
- **Then:** the fake server receives the reply exactly once

**Verification:** test — a service test that kills the daemon.

#### AC-022.3 — A refused email

- **Given:** a request job whose sender the fake server refuses permanently, and a notice address
- **When:** the job is completed with a mail text, and later a blocked question to the notice address is refused too
- **Then:** the result reply is tried once; the history records "refused by the server" with the server's message for
  both; the notice address receives one notice for the first and none for the second

**Verification:** test — a service test against the fake mail server.

### REQ-023 — Timeliness

While the daemon is ready and an owned account is `ready`, a new email SHALL become a job or thread input within the
account's check interval of its arrival, or within 10 seconds when the server announces new mail at once.

#### AC-023.1 — Within the interval

- **Given:** an owned account with a 60-second interval on a server that doesn't announce new mail, and one that does
- **When:** an email arrives in each
- **Then:** the first is taken in within 60 seconds and the second within 10 seconds

**Verification:** test — a service test against the fake mail server under the test clock.

### REQ-024 — Saved mail travels with the export

The export SHALL stay the one file S-004 REQ-016 and S-003 REQ-016 define, and SHALL carry every saved message and
attachment; `bob import` SHALL restore them with their jobs (S-004 REQ-017). The configuration file and the secrets
store stay out of the export, so after an import on another machine the accounts must be set up and signed in again.

#### AC-024.1 — Export and import

- **Given:** an instance with a triage job and its saved PDF
- **When:** it is exported to one file and imported into an empty instance
- **Then:** the job's lead in the imported instance reads the PDF, identical

**Verification:** test — a service test.

### REQ-025 — Documentation

The manual SHALL have a page on email, in place of `docs/manual/index.md`'s "This page comes with its feature",
covering: the two kinds; setting up an account with a password, an app password or a password command; registering an
app and signing in with Google (a Workspace "Internal" app or the team's own project, the loopback sign-in and how to
forward it from another machine, and personal Gmail by app password) and with Microsoft (device code, and app-only
access for Microsoft 365); the allowlist and the notice address; triage, the request mark and how to add triage rules;
what The Intern sends and when; the connection security choices; and that accounts and secrets aren't in an export.
The command reference SHALL match `bob mail --help`.

#### AC-025.1 — The manual matches

- **Given:** the merged work
- **When:** a reviewer builds the manual and compares it with `bob mail --help`, the Mail page and this list
- **Then:** every command, key and topic appears, and the site builds with no error

**Verification:** inspection — `npm run docs:build`, read by the reviewer.

## Configuration Requirements

- **Mail accounts.**
  - **What:** the accounts The Intern reaches, as `[[mail_account]]` sections (REQ-001).
  - **Where:** `config.toml` in the config directory (S-002 REQ-021). Written by hand, by the operations or by the
    Mail page; changes at runtime through operations and at the next restart by hand.
  - **Constraints:** REQ-001 and REQ-012. A trusted, owner-only input that holds no secret.
  - **Missing:** no accounts: no intake and no mail tools to use. An invalid section stops startup (REQ-002).
- **Notice settings.**
  - **What:** the notice address and the owned account that sends to it, as `[mail]` (REQ-013).
  - **Where:** `config.toml`, as above.
  - **Constraints:** one address; `notice_from` names an owned account with an SMTP host.
  - **Missing:** nothing is sent to a notice address; questions and held-back mail stay in the job record.
- **Mail secrets.**
  - **What:** passwords, client secrets and OAuth tokens (REQ-002, REQ-020).
  - **Where:** the instance's owner-only secrets store, written by `bob mail create`, `change` and `signin`, the Mail
    page and token refresh; never edited by hand.
  - **Constraints:** never shown back or copied anywhere else.
  - **Missing:** the account starts `needs_sign_in`.

## Assumptions and Dependencies

- **Google and Microsoft keep IMAP and SMTP with OAuth.** Research of 2026-11-17 against their current documentation:
  Google states that outside clients can still use Gmail over IMAP, and Microsoft documents OAuth for IMAP, POP and SMTP
  for Microsoft 365 and Outlook.com. Their changes in the last six years removed password sign-in, with 3 to 19 months'
  notice. If a provider retires IMAP or SMTP, a new spec adds its own interface.
- **Google gives no device-code sign-in for mail scopes**, so Google sign-in returns to a loopback address on The
  Intern's machine (REQ-004). Confirmed in Google's documentation, 2026-11-17.
- **Each team registers its own OAuth app.** A Google Workspace "Internal" app or a project under 100 users needs no
  Google verification; Microsoft single-tenant apps need no publisher verification. Confirmed in the providers'
  documentation, 2026-11-17.
- **An owned account belongs to The Intern alone.** Nobody else works through its inbox.
- **Servers speak standard IMAP and SMTP,** with TLS, STARTTLS or no encryption as each account sets (REQ-001).
  Announcing new mail at once (IMAP IDLE) is optional (REQ-023).
- **The service account is the boundary (ADR-002).** Reaching an owned address makes a team member, as decision 1
  states; the rules of REQ-010 bind The Intern's own paths, and a role with `bash` acts with the service account's
  access.
- **Amendments this planning branch carries,** to be approved with this spec at Gate 1:
  - S-000 v0.9: Users ("its email address" becomes any number of owned addresses); Email's Responsibility (any number
    of owned accounts and monitored ones, in place of "The Intern's own mailbox"), Boundary (it may read, sort and
    draft in monitored mailboxes, in place of "does not read or triage team members' own mailboxes") and Works with
    (Command line, Web interface, Skills and instructions); Command line's and Web interface's Responsibility and
    Works with (managing mail accounts, Email); use case 6, the notice address and the triage job.
  - S-001: the shipped `triage` role (REQ-001, REQ-002, AC-001.1's "exactly `bob`, `gp` and `desk`"); `mail` in a
    role's tool set (REQ-003); removing a role refused while an owned account names it as its triage role (REQ-003).
  - S-002: REQ-018 and AC-018.1 (the instance keeps account secrets in its owner-only secrets store); REQ-006 (the
    directory that holds that store); REQ-021 and Configuration Requirements (`[mail]` and `[[mail_account]]`);
    REQ-012 (the email origin names the account); REQ-002 step 8 (mail starts with the listeners and the scheduler,
    after removing the secrets of accounts the file no longer holds);
    the operation catalogue (the nine `mail.*` operations); the instance feed (`mail_account_status`); the status
    operation (account status).
  - S-003 REQ-007: `email` is a way in no listener stamps; no change to the export route, which REQ-024 keeps as one
    file.
  - S-004: the job fields (the request mark and the email details) and REQ-003 (the email origin names the account);
    the job tools table and REQ-013 (mark request; `mailText` on block job and complete job); `jobs.complete`'s
    `mailText`; the History definition and history entries (email received, sent, held back, may not have gone out,
    result reply not sent: no mail text, refused by the server, not sent: account removed);
    `jobs.list`'s account filter; REQ-016 and REQ-017 (the export and import carry saved mail); REQ-018 (owed mail and
    the intake record).
  - S-005: `mail` leaves the reserved groups (Definitions, Users, Exclusions "Commands for later components", the
    conventions' reserved groups); Interfaces rows for `bob mail` and `bob jobs list --mail`; `bob jobs complete`
    gains `--mail-text`; `bob jobs show` prints a job's email details and request mark.
  - S-006: REQ-003, the Job page's email section; REQ-004, the complete action takes an optional mail text; the Users
    row of later specs adds Email.
  - S-007 REQ-014: an email to an owned account is a team member's request through the `email` way in, not an event.
  - S-008 REQ-001: the shipped `triage` instructions and default skills; the common prompt covers mail texts and
    mail without internals; `bob-command-line` teaches `bob mail` (AC-001.2).
  - ADR-001 decision 4: the intake record, retries, job threads, owed mail and sends are new kinds of facts and a new
    pairing of a job write.
  - ADR-002: decision 1 (owned addresses only are a way in), decision 5, Consequences and Alternatives (the instance
    keeps account secrets); `docs/development/coding_guidelines.md` ("No credentials in the repository, state directory,
    database or logs").
  - ADR-004: the request id of an email follow-up (decision 3) and its place in decision 5's list.
  - `docs/system_overview.html`: the spec map, the Ways in line, the Email boxes, the `email` value of Way in, and the
    terms owned account, monitored account, triage job, request mark, mail text and notice address.

## Success Criteria

1. A team member sets up an owned account with each of a password, a password command, Microsoft device code and
   Google sign-in against fakes, and each shows `ready` in `bob mail list` and on the Mail page (REQ-001 to REQ-005,
   REQ-017, REQ-018).
2. An email to an owned account becomes one `E` job whose lead reads the saved message and attachments; marked,
   handed off and completed, it sends exactly one reply in the sender's thread (REQ-006 to REQ-009, REQ-015).
3. A blocked job's question reaches its sender, or the notice address, and a reply resumes the job (REQ-013,
   REQ-014).
4. On a monitored account, send is refused before anything reaches the server and no email becomes a job (REQ-010).
5. Killing the daemon during intake and during sending leaves every email taken in once and no email sent twice
   (REQ-021, REQ-022).
6. No secret appears outside the secrets store, and no composed mail shows an internal (REQ-016, REQ-020).
7. **Live check.** With a real low-cost model, the shipped `triage` role marks and hands off a request, completes a
   newsletter and an auto-reply without a reply, and writes mail with no internals (`npm run test:live:mail`).

## Implementation Order

| Phase | Delivers | Depends on |
|---|---|---|
| 1 | Accounts: the configuration sections, the secrets store, sign-in by password, command and OAuth, status and retries, the account operations and `bob mail` | Nothing |
| 2 | The mail tools on both kinds, the `mail` tool set entry, and monitored accounts usable end to end | Phase 1 |
| 3 | Intake: saving mail, the triage job, the shipped `triage` role, the request mark, job threads, exactly-once intake | Phase 2 |
| 4 | Sending: the allowlist, the notice address, the blocked question, the result reply, the send tool, at most once, no internals | Phase 3 |
| 5 | The Mail page and the Job page's email section, saved mail in the export, the manual, the live check | Phase 4 |
| 6 | A triage job whose lead has no model waits for a model, as does a reply to an open job whose lead has none (CR-002) | Phase 5, S-001 phase 8 |

## Open Questions

None. Feature Architecture settled them: the mail libraries and test servers in `docs/development/tech_stack.md`,
Email; the shared accounts layer and the secrets store in ADR-010; saved mail inside the one-file export in ADR-011;
and the request id of an email follow-up in ADR-004 decisions 3 and 5.

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-11-19 | v0.2. REQ-002, REQ-020 and the Assumptions list: the secrets store holds the secrets of every kind of account The Intern connects to, with mail accounts its only users today, in place of a store for mail secrets only; S-002 and S-004 on this branch and the ADR-002 amendment follow. Open Questions: a shared accounts layer (sign-in, token refresh, the secrets store, account status) apart from the mail-specific code. No behaviour of email changes and no identifier is added, changed or retired. | Product owner decision, 2026-11-19: calendars and contacts will get their own spec, and S-009 shouldn't make them reopen S-002, S-004 and ADR-002. | None yet; S-009 isn't broken down |
| 2026-11-19 | v0.3. REQ-005, Definitions and new AC-005.2: a fourth status, `connecting`, for an account not checked yet since it was added, changed or the daemon started. REQ-003: mail a removed account still owes is never sent, and each gets "not sent: account removed". REQ-022, REQ-013, REQ-016, Interfaces and new AC-022.3: an email the server permanently refuses isn't tried again; the history records "refused by the server" with the server's message, and the notice address gets one notice unless the refused email went to it. REQ-018, AC-018.1 and Interfaces: the Job page shows each attachment's name and size, with no download. Open Questions: settled by Feature Architecture. S-004 and S-006 on this branch follow. The feed events paragraph and the Assumptions list name every mail history entry (consistency review G2, G3). | Feature Architecture Spec findings F-A to F-D; product owner decisions, 2026-11-19. | None yet; S-009 isn't broken down |
| 2026-11-21 | v0.4. AC-008.2, AC-016.2 and Success Criterion 7 name the live check `npm run test:live:mail`, the script that runs it, in place of `npm run test:live`, which runs the daemon's live check. No behaviour changes and no identifier is added, changed or retired. | B-054; product owner decision, 2026-11-21. | T-457 (already built to `test:live:mail`) |
| 2026-11-21 | spec-truth reconciliation — PASS | S-009 v0.4 and its amendments to S-001, S-002, S-004, S-005, S-006 and S-008 hold for T-396 to T-463 and B-049 to B-054; ADR-011 Consequences corrected (b0982f85); AC-016.2's live run is still open under B-053 | none |
| 2026-11-21 | spec-truth reconciliation — PASS | v0.4 confirmed after B-053: two live runs of `npm run test:live:mail` on openai-codex/gpt-6-sol exited 0, closing the B-053 gap on AC-016.2 and Success Criterion 7 (AC-008.2 shown again); triage now hands requests to `bob` or the role the team's rules name and sends interim mail itself before the handoff, within REQ-008, REQ-016, REQ-019 and AC-011.1 | none |
| 2026-11-22 | spec-truth reconciliation — PASS | Corrects the row above: openai-codex/gpt-6-sol is the top tier, not a low-cost model (light = luna, workhorse = terra, top = sol; the base name decides, not the version). The low-cost evidence for AC-008.2, AC-016.2 and Success Criterion 7 is one live run of `npm run test:live:mail` on openai-codex/gpt-6-luna at 49944bc1, which exited 0 with "PASS triage decisions, one reply, and mail without internals". The sol runs remain supporting evidence | Product owner correction, 2026-11-22 | none |
| 2026-11-22 | Gate 5 sign-off | S-009 v0.4 signed off by the product owner: T-396 to T-463 completed, B-049 to B-054 resolved, the spec-truth reconciliation passed, and the live check passed on the low-cost model (gpt-6-luna) | Product owner decision, 2026-11-22 | none |
| 2026-11-22 | v0.5. REQ-021 and REQ-022: "exactly once" and "at most once" hold within one database's history; a rollback (S-010 REQ-009) or an import of an older copy (S-004 REQ-017) can take in or send mail again. No behaviour changes and no identifier added or retired. | S-010 architecture consistency review, finding M4; product owner decision of 2026-11-22: rollback warns about repeated mail, and S-009's guarantees are clarified. | None |
| 2026-11-24 | v0.6. Work without a model (CR-002). REQ-007 and new AC-007.2: intake doesn't change when the triage role's seat has no model; the email is saved, the triage job is created, and its lead waits for a model with the no-model notice and runs once a model is available; a reply to an open job whose lead has no model waits the same way. Workflow follows. No identifier changed or retired. | CR-002, approved by the product owner on 2026-11-24. | CR-002's tasks |
| 2026-11-24 | v0.6, same version, revised on the planning branch after the Architect's consistency review (corrections C2, C13). AC-007.2: the lead runs within 30 seconds of the default model appearing. Implementation Order: new phase 6. No identifier added or retired. | Architect's consistency review of 2026-11-24; product owner, CR-002 settled details, 2026-11-24. | CR-002's tasks |
