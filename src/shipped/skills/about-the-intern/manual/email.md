# Email

You can give The Intern mail accounts. An email that reaches an account The Intern owns becomes a job. Agents can
also read, sort and draft in a mailbox that belongs to a person. This page explains the two kinds of account, how to
set one up, how to sign in with Google or Microsoft, and what The Intern does with the mail and sends back.

## The two kinds of account

Each account has a kind. You choose it when you create the account, and you can't change it. To change the kind,
remove the account and add it again.

| Kind        | Whose mailbox | What The Intern does with it |
| ----------- | ------------- | ---------------------------- |
| `owned`     | The Intern's own, such as `intern@example.com`. | Every new email in its inbox becomes a job, and The Intern may send from it. |
| `monitored` | A person's mailbox or a shared one. | Agents read, sort and draft. The Intern never sends from it, and no email in it becomes a job. |

Create as many accounts as you need. A role's agents use the accounts' mail only when the role's `tools` list names
`mail`, as in `tools = ["read", "mail"]`. The shipped `triage` role has it. The front desk never has it. See
[Roles, workspaces and agents sharing a job](roles_and_agents.md).

## Add an account

You can add an account in any of three ways:

- Run [`bob mail create <name>`](commands.md#bob-mail-create-name-and-bob-mail-change-name).
- Select **Add** under **Add an account** on the Mail page, at `/ui/#/mail`. [Use the Mail page](#use-the-mail-page)
  describes it.
- Edit `config.toml` by hand.

Anyone who can reach The Intern can add an account. See [Who can use The Intern](running_the_intern.md#who-can-use-the-intern).

A password or a client secret never goes into `config.toml`. `bob mail create` asks for it and The Intern keeps it
apart from the file, where only the service account can read it. No command, page or file shows it back.

### The `[[mail_account]]` section

Each account is one `[[mail_account]]` section in `config.toml`, in any order:

```toml
[[mail_account]]
name = "intern"
kind = "owned"
address = "intern@example.com"
imap_host = "imap.example.com"
smtp_host = "smtp.example.com"
auth = "password"
allow = ["ana@example.com", "@example.com"]
```

| Key                      | Needed | Meaning |
| ------------------------ | ------ | ------- |
| `name`                   | Yes    | The account's name: 1 to 64 letters, digits and hyphens, starting with a letter or a digit. Names are case-sensitive and unique. You can't change a name. |
| `kind`                   | Yes    | `owned` or `monitored`. |
| `address`                | Yes    | The account's email address. |
| `imap_host`              | Yes    | The IMAP server. |
| `imap_port`              | No     | 1 to 65535. Without it: 993, or 143 when `imap_security` is `starttls` or `none`. |
| `imap_security`          | No     | `tls`, `starttls` or `none`. Without it: `tls`. See [Connection security](#connection-security). |
| `smtp_host`              | No     | The SMTP server. For an owned account only. An owned account without one sends nothing. A monitored account can't have one. |
| `smtp_port`              | No     | 1 to 65535. Without it: 465, or 587 when `smtp_security` is `starttls` or `none`. |
| `smtp_security`          | No     | `tls`, `starttls` or `none`. Without it: `tls`. |
| `login`                  | No     | The login name, when it isn't the address. |
| `auth`                   | Yes    | How The Intern logs in: `password`, `password_command`, `google`, `microsoft` or `microsoft_app`. |
| `password_command`       | With `password_command` | The command that prints the password, as a list of words. Refused with any other `auth`. |
| `client_id`              | With `google`, `microsoft` and `microsoft_app` | The OAuth client ID of your app. |
| `tenant`                 | With `microsoft` and `microsoft_app` | For `microsoft`, a tenant ID, `organizations`, `consumers` or `common`. For `microsoft_app`, a tenant ID. |
| `check_interval_seconds` | No     | How often The Intern looks for new mail when the server can't tell it at once: 10 to 3600. Without it: 60. |
| `triage_role`            | No     | For an owned account only. The role that triages its mail. Without it: `triage`. See [Triage](#triage). |
| `allow`                  | No     | For an owned account only. The addresses and domains The Intern may send to. See [The allowlist](#the-allowlist). |

The file uses `check_interval_seconds` and `triage_role`. The command takes `--check-interval` and `--triage-role`, and
the Mail page labels them Check interval and Triage role. Any other key is refused. A refusal names the account, the
key and the reason. The service reads hand edits of `config.toml` only at startup. If an account breaks a rule, the
service doesn't start. See [The configuration file](running_the_intern.md#the-configuration-file).

### Change, test and remove an account

| Command                    | What it does |
| -------------------------- | ------------ |
| `bob mail list`            | List the accounts with their status. |
| `bob mail show <name>`     | Show one account's settings, allowlist, triage role, status and last error. |
| `bob mail change <name>`   | Change an account. `--allow` adds an entry, `--disallow` removes one, and `--new-secret` reads a new password or client secret. |
| `bob mail test <name>`     | Log in to the account's IMAP server and, when it has one, its SMTP server. It sends nothing. |
| `bob mail remove <name>`   | Remove the account, its secrets and its intake. Its jobs and their saved mail stay. |

The [Command reference](commands.md#mail) lists every option and what each command prints. A change applies at once and
is written to `config.toml` first. A change of `address`, `imap_host` or `login` starts the account afresh: mail
already in its inbox at the next connection is left alone.

### The status of an account

Each account has a status, which `bob mail list`, `bob mail show` and the Mail page show:

| Status          | Meaning |
| --------------- | ------- |
| `connecting`    | The account hasn't been checked since you added or changed it or the service started. Wait. |
| `ready`         | Its last connection and login worked. |
| `needs_sign_in` | It has no usable secret or sign-in, or the provider refused the sign-in. Run `bob mail signin`, or give a new secret. |
| `failing`       | Something else stops it, such as an unreachable server or a refused password. `show` prints the last error. |

The Intern tries a `failing` account again after its check interval and then at longer pauses, up to 30 minutes, until
it connects. One account's trouble doesn't stop another.

## Sign in with a password

Three kinds of `auth` need no provider app.

**Password.** Use your mail provider's password for the mailbox, or an app password, which is a password the provider
makes for one program. Create the account and type the password when `bob` asks for it:

```
bob mail create intern --kind owned --address intern@example.com \
  --imap-host imap.example.com --smtp-host smtp.example.com --auth password
```

`bob` prints `Password: ` and reads what you type without showing it. To read it from a pipe instead, add
`--secret-stdin`. [How a secret is read](commands.md#how-a-secret-is-read) has the details. To replace a password later,
run `bob mail change intern --new-secret`.

**Password command.** The account keeps no password. Each time The Intern logs in, it runs your command as the service
account and reads the password from what the command prints. Give one `--password-command` option for each word of the
command. The command runs without a shell:

```
bob mail create intern --kind owned --address intern@example.com \
  --imap-host imap.example.com --smtp-host smtp.example.com \
  --auth password_command --password-command pass --password-command show --password-command mail/intern
```

If the command fails or prints nothing, the account turns `failing` and the error names the command's exit status. It
never shows the command's output.

Run `bob mail test intern` after you create the account to check the login.

## Sign in with Google

Google signs an account in with `auth = "google"`. You register an app of your own with Google once, then sign in.
Google ends the sign-in at the address `127.0.0.1` on the machine where The Intern runs. The steps follow Google's pages
"OAuth 2.0 for Desktop Apps" and "Manage App Audience", as read on 2026-11-21.

1. In the Google Cloud console, choose the project for the app. For a Google Workspace organisation, use a project
   inside the organisation's Google Cloud resource. Otherwise use a project of your own.
2. Set the app's audience:
   - **Internal** limits sign-in to members of your Google Workspace organisation, and the app needs no verification.
     Gmail's mail scope is a restricted one, so your Workspace administrator may have to allow the app to use it first.
   - **External** lets any Google Account sign in. While the app's publishing status is Testing, only listed test users
     can sign in, and Google ends their sign-in after seven days, so the account turns `needs_sign_in` each week.
     Publish the app to avoid that. Google then shows an "unverified app" warning for the mail scope until the app
     is verified.
3. Make the app ask for the scope `https://mail.google.com/`. It is the one scope The Intern requests, and it covers
   IMAP and SMTP.
4. On the Clients page, choose **Create client**, select the **Desktop app** type and create it. Copy the client ID and
   the client secret.
5. Create the account with the client ID. `bob` asks for the client secret:

   ```
   bob mail create intern --kind owned --address intern@example.com \
     --imap-host imap.gmail.com --smtp-host smtp.gmail.com \
     --auth google --client-id <client ID>
   ```

   Gmail's servers are `imap.gmail.com` on port 993 and `smtp.gmail.com` on port 465, both with `tls`, as Google's
   page "Gmail IMAP and SMTP" lists them. These are the defaults.
6. Run `bob mail signin intern`.

### The loopback sign-in

`bob mail signin` prints `Open <address> in a browser.` The Intern listens for Google's answer on `127.0.0.1` only, on a
free port it picks for this sign-in, and for at most 10 minutes. Nothing else is accepted there. If you open the
address in a browser on the machine where The Intern runs, the sign-in finishes by itself, and `bob` prints
`intern is ready`.

If you work from another machine, Google's answer must still reach the daemon's port. The command prints which port:
`On another machine, forward port <port> to this one first.` Forward it before you open the address. On the machine
with the browser, run:

```
ssh -L <port>:127.0.0.1:<port> <you>@<the machine where The Intern runs>
```

Keep that connection open, then open the address in the browser on your machine. The browser follows Google's answer to
`127.0.0.1:<port>` on your machine, and `ssh` carries it to The Intern. If no answer arrives within 10 minutes, the
account stays `needs_sign_in`; run the command again, which picks a new port.

The Mail page's **Sign in** button starts the same sign-in and shows a link to Google.

After that, The Intern renews its access with nobody present. Google can still end a sign-in, for example when the
mailbox's password changes or the sign-in goes unused for six months. The account then turns `needs_sign_in` with
Google's message, and you run `bob mail signin` again.

### Personal Gmail with an app password

A personal Gmail account can use an app password and no app of your own. Google says it doesn't recommend app
passwords, and they need 2-Step Verification on the Google Account. They aren't offered for work or school accounts
or for accounts with Advanced Protection.

1. Turn on 2-Step Verification for the Google Account.
2. Create an app password on the Google Account's App passwords page. Google shows 16 characters once.
3. Create the account with `auth password`, `imap.gmail.com` and `smtp.gmail.com`, and give the app password when `bob`
   asks for the password.

Google revokes an account's app passwords when its password changes. The account then turns `failing`. Create a new app
password and run `bob mail change <name> --new-secret`.

## Sign in with Microsoft

Microsoft signs an account in with `auth = "microsoft"` (a person signs in once) or `auth = "microsoft_app"` (the
organisation grants an app access, and nobody signs in). Both register an app in Microsoft Entra. Microsoft 365 turned
off logins with passwords for IMAP, and it turned off SMTP AUTH where it wasn't in use, so use one of these for a
Microsoft 365 mailbox. The steps follow Microsoft's pages "Authenticate an IMAP, POP, SMTP application by using OAuth",
"OAuth 2.0 device authorization grant" and "POP3 and IMAP4 in Exchange Online", as read on 2026-11-21.

The servers for Microsoft 365 are `outlook.office365.com` on port 993 with `tls` for IMAP, and `smtp.office365.com` on
port 587 with `starttls` for SMTP. Set the SMTP security and port yourself, because they aren't the defaults.

### Device code sign-in

1. In Microsoft Entra, register an application. Choose who can use it: "Single tenant only" is the usual choice.
2. On the app's Authentication page, turn on **Allow public client flows**. The device code flow needs it.
3. Under API permissions, add the delegated permissions of the Office 365 Exchange Online API that match the scopes
   The Intern requests: `IMAP.AccessAsUser.All` and `SMTP.Send`, plus `offline_access`. If your organisation requires
   it, ask an administrator to grant consent.
4. Copy the application's client ID and your tenant: a tenant ID, `organizations` for any work or school account,
   `consumers` or `common`.
5. Create the account. No client secret is needed:

   ```
   bob mail create intern --kind owned --address intern@example.com \
     --imap-host outlook.office365.com --smtp-host smtp.office365.com \
     --smtp-port 587 --smtp-security starttls \
     --auth microsoft --client-id <client ID> --tenant <tenant>
   ```

6. Run `bob mail signin intern`. It prints `Open <address> and enter the code <code>.` Open the address in a browser on
   any device, enter the code and sign in as the mailbox. The code works for 15 minutes. `bob` prints `intern is
   ready` when you finish.

The Mail page's **Sign in** button shows the same code and address. The Intern renews the sign-in with nobody present.
When Microsoft refuses a renewal, the account turns `needs_sign_in` and you sign in again.

### App-only access for Microsoft 365

For a mailbox in your own organisation, the Microsoft 365 administrator can grant an app access to it, so no person
signs in. Give the administrator the application's client ID, and have the administrator do these steps:

1. Register an application with a client secret, and add the application permissions of the Office 365 Exchange Online
   API: `IMAP.AccessAsApp`, and `SMTP.SendAsApp` for an owned account that sends. Grant administrator consent.
2. Register the application's service principal in Exchange with the Exchange Online PowerShell cmdlet
   `New-ServicePrincipal -AppId <application ID> -ObjectId <object ID>`. The object ID is the one of the application's
   page under **Enterprise applications**, not of its App registrations page.
3. Give the service principal access to the mailbox with
   `Add-MailboxPermission -Identity <address> -User <service principal ID> -AccessRights FullAccess`. For an account
   that sends, also grant the right to send as the mailbox with `Add-RecipientPermission`.

Then create the account with the tenant ID. `bob` asks for the client secret:

```
bob mail create intern --kind owned --address intern@example.com \
  --imap-host outlook.office365.com --smtp-host smtp.office365.com \
  --smtp-port 587 --smtp-security starttls \
  --auth microsoft_app --client-id <client ID> --tenant <tenant ID>
```

There is no sign-in: `bob mail signin` refuses a `microsoft_app` account. Run `bob mail test intern` to check the
access.

## Connection security

`imap_security` and `smtp_security` choose how The Intern connects to a server:

| Value      | What it does |
| ---------- | ------------ |
| `tls`      | Encrypts the connection from the start. This is the default, with IMAP port 993 and SMTP port 465. |
| `starttls` | Starts unencrypted and switches to encryption. The default ports are IMAP 143 and SMTP 587. |
| `none`     | Sends the login and the mail unencrypted. Use it only when the choice is yours to make, for example for a mail server on the same machine. |

With `tls` or `starttls`, The Intern checks the server's certificate. If it doesn't verify, the account turns `failing`
and says why.

## Triage

Intake is the way an email becomes a job. For each owned account, The Intern takes in every email that arrives in its
inbox after the account's first successful connection. Mail already in the inbox then, and mail in other folders,
doesn't become a job. Intake doesn't filter on sender, content or auto-reply markers: reaching the address makes a team
member's request. A new email becomes a job within the check interval, or within seconds when the server announces new
mail at once. Its short number has the letter `E`. See [Short numbers](jobs.md#short-numbers).

The Intern saves the email and each attachment as files, and starts a triage job. The job's first lead has the account's
triage role. It reads the saved email and takes one decision:

| Decision | What the lead does |
| -------- | ------------------ |
| Discard | For spam, auto-replies and delivery failures. It completes the job and says why. |
| Information only | It records what matters, relates the job to others where useful and completes it. |
| Request | It sets the request mark, rewrites the job and hands it off to the role that does the work. The job stays one job. |
| Missing information | It blocks the job with a question for the sender. |

The **request mark** says that the email asks The Intern for something. Only the lead of a job that came by email sets
it, and the Job page shows it. A completed job with the mark sends a [result reply](#what-the-intern-sends). A job
without it, such as a discarded email, sends nothing.

Replies stay in the job. An email in an owned inbox that answers an email of a job reaches the job's lead, and it
resumes a Blocked job. The Intern links replies only by the mail's own `In-Reply-To` and `References` headers. A reply
to a job that is Done becomes a new job related to it. Any other email becomes a new triage job.

The job's agents read a saved email and its attachments as files. The Job page shows the account, the sender, the
subject, the saved message, the name and size of each attachment, the thread and the request mark. It offers no download
of an attachment.

### Add triage rules

The shipped `triage` role follows your own rules. Add them as instructions and skills of the triage role, as
[Skills and instructions](skills_and_instructions.md) describes:

- Edit `<data dir>/instructions/roles/triage.md`, or [change it on the Roles page](web_interface.md#roles). For example,
  add "Forward every invoice to the `accounts` role."
- Add a skill and enable it for the role with `bob skills enable <name> --role triage`.

You can also create a role of your own, name it as an account's triage role, and give it the `mail` tool.

### Check the agents' work

A team member can complete a job that came by email with `bob jobs complete --mail-text <text>` or the Job page's
complete action. A job with the request mark and no mail text sends no reply, and the history records that. See
[Complete or cancel a job](jobs.md#complete-or-cancel-a-job).

## The allowlist

An owned account's `allow` list names who The Intern may send to from that account: full addresses and `@domain`
entries. An address matches without regard to letter case. `@example.com` matches every address at `example.com` and
none at its subdomains, such as `dev.example.com`. An empty or missing list allows anyone. The notice address is always
allowed.

If any recipient of an email isn't allowed, The Intern sends none of it. The agent is told which recipient isn't
allowed, the job's history records the held-back email, and a held-back notice goes to the notice address.

Change the list with `bob mail change <name> --allow <entry>` and `--disallow <entry>`. Repeat each option for several
entries.

## The notice address

The notice address is the one address that The Intern writes to about its own work. Set it with an owned account that
has an SMTP server:

```
bob mail notices set --to ops@example.com --from intern
```

In `config.toml` it is the `[mail]` section:

```toml
[mail]
notice_to = "ops@example.com"
notice_from = "intern"
```

| Key           | Needed | Meaning |
| ------------- | ------ | ------- |
| `notice_to`   | No     | The notice address. It can't be the address of an owned account, because the notice would land in an inbox and become a job. |
| `notice_from` | With `notice_to` | The name of an owned account with an SMTP server. |

`bob mail notices` shows the settings, and `bob mail notices clear` removes them. `bob mail remove` refuses the account
that sends the notices. Without a notice address, no notice is mailed: held-back mail and blocked questions stay in the
job's history, on the Job page and in `bob`.

## What The Intern sends

The Intern sends plain-text email, from the account the job came through or from the notice account. It sends nothing
from a monitored account. An agent's own mail, through the mail tools, follows the allowlist too.

| Mail | To | When |
| ---- | -- | ---- |
| Blocked question | The job's sender, as a reply in the job's thread. When the job didn't come by email, or the sender isn't allowed, the notice address, in a thread of its own. | The lead blocks the job with a mail text that differs from the last one mailed for the job. |
| Result reply | The job's sender, in the job's thread. | A job with the request mark is completed with a mail text. |
| Held-back notice | The notice address. | The allowlist holds back an email. |
| Refused-mail notice | The notice address. | The mail server permanently refuses an email, unless it was addressed to the notice address. |

A lead writes the mail text, for the person who reads it. The Blocked reason and the completion justification are
written for the team and never mailed. Mail shows no short number, job, role or file path unless the person asked
for one. The same mail text isn't mailed twice, so an auto-reply that resumes a job can't start a loop. Each email goes
out at most once: if the service stops while one is going out, it doesn't send it again, and the history says it
may not have gone out.

## Use the Mail page

The Mail page is at `/ui/#/mail`, in the sidebar. It lists each account with its address, kind, status, last error and
last check, and stays current without a reload. Each account has **Save**, **Test**, **Sign in** and **Remove**
buttons, and **Add an account** creates one. A **Notice mail** section sets the notice address and its sending
account, with **Save** and **Clear**. It does what the `bob mail` commands do. A secret field is never filled in: leave
it empty to keep the secret. See [The web interface](web_interface.md).

## Accounts and secrets aren't in an export

[The export](jobs.md#export-and-import) holds every saved email and attachment, and `bob import` restores them with
their jobs. It holds neither `config.toml` nor the secrets, so the accounts aren't in it. After you import a copy on
another machine, create the accounts again and sign them in. The same holds for the backup in
[Running The Intern](running_the_intern.md#copy-the-database-as-a-backup): back up `config.toml` on its own, and keep
your passwords and client secrets where you keep other secrets.
