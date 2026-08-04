# Himalaya Command Reference

Verified against installed `himalaya --version`:
`himalaya v1.2.0 +maildir +smtp +wizard +sendmail +pgp-commands +imap`
(build: linux musl x86_64). Every command and flag below was checked
against that binary's own `--help` output (`himalaya --help`,
`himalaya <command> --help`, `himalaya <command> <subcommand> --help`) —
none of it is written from memory. A few entries also note behavior
observed by running the command against a live, already-configured
account; those are marked "Observed" so a later re-verification pass knows
which lines to re-check by execution versus by `--help` alone.

Global options accepted by (almost) every command below, confirmed on each
subcommand's own `--help`:

- `-a, --account <NAME>` — override the default account (see
  [Selecting an Account](#selecting-an-account)).
- `-c, --config <PATH>` — override the default config file path.
- `-o, --output <FORMAT>` — `plain` (default; table/text) or `json`.
- `--quiet` / `--debug` / `--trace` — logging verbosity.

**Argument-order pitfall (Observed).** Options must be given *before* a
free-form query or body positional argument, not after. Once himalaya
starts consuming the variadic positional (a query, a body, a template),
any later `-`-prefixed token is parsed as part of that positional and
fails:

```bash
$ himalaya envelope list not flag seen -s 3
Error: cannot parse search emails query `not flag seen -s 3`
 ...found '-' expected space between filters, `and`, `or`, or end of input

$ himalaya envelope list -s 3 not flag seen   # correct: options first
| ID | FLAGS | SUBJECT | FROM | DATE |
...
```

---

## List and Search Envelopes

```bash
himalaya envelope list [OPTIONS] [QUERY]...
```

`envelope list` is both "list" (no query) and "search" (with a query) —
there is no separate search subcommand.

Verified options:

- `-f, --folder <NAME>` — folder to list (default `INBOX`).
- `-p, --page <NUMBER>` — page number, starting from 1 (default `1`).
- `-s, --page-size <NUMBER>` — envelopes per page.
- `-a, --account <NAME>` — override the default account.
- `-w, --max-width <PIXELS>` — cap table width (plain output only).
- `-o, --output <FORMAT>` — `plain` or `json`.

The `QUERY` grammar (from `himalaya envelope list --help`) has 3
operators and 8 conditions:

- Operators: `not <condition>`, `<condition> and <condition>`,
  `<condition> or <condition>`.
- Conditions: `date <yyyy-mm-dd>`, `before <yyyy-mm-dd>`,
  `after <yyyy-mm-dd>`, `from <pattern>`, `to <pattern>`,
  `subject <pattern>`, `body <pattern>`, `flag <flag>`.
- A sort suffix starts with `order by`, followed by `date|from|to|subject`
  and optionally `asc`/`desc`, e.g. `order by date desc subject`.

Examples (from `--help`, and Observed against a live account):

```bash
himalaya envelope list                                  # first page, INBOX
himalaya envelope list -f Archive -s 20                 # a different folder, 20/page
himalaya envelope list subject foo and body bar          # filter query
himalaya envelope list order by date desc                # sort query
himalaya envelope list -o json -s 2                      # machine-readable, 2 results
```

Observed JSON shape (`-o json`), one envelope:

```json
{"id":"89","flags":[],"subject":"...","from":{"name":"...","addr":"..."},"to":{"name":"...","addr":"..."},"date":"2026-07-22 13:42-07:00","has_attachment":false}
```

`flags` is `[]` for an unseen envelope and includes `"Seen"` (and any
other applied flags) once read — this is what backs the unseen filter
below.

---

## Filtering on the Unseen Flag

There is no `unseen` flag keyword. `flag <flag>` matches one of the named
flags himalaya tracks: `seen`, `answered`, `flagged`, `deleted`, `draft`
(others are treated as custom flags a given backend may not support).
Filter for unseen mail by negating `seen`:

```bash
himalaya envelope list not flag seen
```

**Pitfall (Observed).** `himalaya envelope list flag unseen` does **not**
error — it silently matches zero envelopes, because `unseen` is parsed as
a *custom* flag name that nothing has, not as "not seen". Always use
`not flag seen`, never `flag unseen`:

```bash
$ himalaya envelope list -s 1 flag unseen     # wrong: parses, matches nothing
| ID | FLAGS | SUBJECT | FROM | DATE |
|----|-------|---------|------|------|

$ himalaya envelope list -s 3 not flag seen   # correct
| ID | FLAGS | SUBJECT ...
| 89 |  *    | ...
```

---

## Reading a Message

```bash
himalaya message read [OPTIONS] <ID>...
```

Verified options: `-f, --folder <NAME>` (default `INBOX`); `-p, --preview`
(read without applying the "seen" flag); `--no-headers` (body only);
`-H, --header <NAME>` (choose which headers to show; repeatable);
`-a, --account <NAME>`.

```bash
himalaya message read 42                 # marks the envelope Seen
himalaya message read --preview 42       # reads without marking Seen
himalaya message read -f Archive 42 43   # multiple ids, one command
```

Reading a message (without `--preview`) sets its `Seen` flag as a side
effect — this is how the mailbox itself, not a separate state file, tracks
what has already been looked at.

---

## Embedding message-derived text safely

Every `SUBJECT`/`BODY`/header value in the sections below that is copied,
quoted, or paraphrased from an incoming message must never be typed as
literal characters directly inside a shell-quoted argument. Incoming mail is
untrusted input from an arbitrary sender: a naive `'...'`-quoted argument
breaks open on an embedded `'` followed by shell syntax, and whatever
follows runs as a real command. There is no `--body-file`/stdin option on
the `template` subcommands that avoids this, so load the text into a shell
variable first, through a *quoted* heredoc — quoting the delimiter
(`<<'TOKEN'`) disables all expansion of the heredoc's contents, so embedded
quotes, `$()`, backticks, and `;` inside the pasted text stay inert data —
then reference the variable only in double-quoted form (`"$VAR"`), never
bare, and never re-embedded into a further quoted literal.

Choose a delimiter of at least 20 random-looking alphanumeric characters,
decided *before* reading the message content you're about to escalate/reply
to — not influenced by what you're about to transcribe (a predictable
delimiter, or one chosen while already reading the content, is weaker:
it leaves the safety of the construction resting on a judgment call made
while processing untrusted input). As defense-in-depth on top of that, not
as the primary safety mechanism, confirm the chosen delimiter doesn't
already appear as a standalone line in the text you're about to paste.

```bash
SUBJECT=$(cat <<'Q7MK3XPZBODYRANDOMTOKEN'
<paste the message-derived subject text here verbatim, unescaped>
Q7MK3XPZBODYRANDOMTOKEN
)
# Subject is a single header line: collapse any embedded newline before use.
# (Otherwise a subject containing a blank line followed by more text could
# smuggle extra headers into the outgoing message — a header-injection
# variant of the same untrusted-content problem, not just shell injection.)
SUBJECT="${SUBJECT//$'\n'/ }"

BODY=$(cat <<'H4F9WQPLBODY2RANDOMTOKEN'
<paste the message-derived body text here verbatim, unescaped>
H4F9WQPLBODY2RANDOMTOKEN
)
```

Then use `"$SUBJECT"` / `"$BODY"` — always double-quoted — anywhere the
examples below show a `'text'`/`"text"` placeholder for message-derived
content. Fixed, non-message-derived text (literal header names, folder
names, IDs) doesn't need this treatment.

One more thing every example below does: pass `-- "$BODY"` (not bare
`"$BODY"`) to `template write`/`template reply`/`template forward`. A body
that happens to start with `-` — an RFC 3676 `-- ` signature delimiter, a
markdown bullet, anything dash-led — makes clap treat it as an unknown
option and the send fails outright (`error: unexpected argument ... found`,
confirmed against the installed binary). `--` disables further option
parsing so everything after it is positional, regardless of content.
`template send "$(...)"` doesn't need this — its argument always starts
with the literal `From:` the inner command emits.

---

## Replying

Two families of commands exist for replying, and they behave differently
in a non-interactive session — this distinction was checked directly by
running `template write` below, not assumed:

- `himalaya message reply [OPTIONS] <ID> [BODY]...` — its own `--help`
  states: "using the editor defined in your environment variable
  `$EDITOR`. When the edition process finishes, you can choose between
  saving or sending the final message." This needs an interactive editor
  session and is **not suitable for a non-interactive/scripted agent
  run**.
- `himalaya template reply [OPTIONS] <ID> [BODY]...` — generates the
  reply template (prefilled `From`, quoted original body) and prints it;
  no editor is invoked. This is the scriptable path.

Verified `template reply` options: `-f, --folder <NAME>` (default
`INBOX`); `-A, --all` (reply to all recipients, adds To/Cc); `-H,
--header <KEY:VAL>` (repeatable); `-a, --account <NAME>`.

Compose-and-send in one step, generate the template then feed its output
to `template send` ([Composing and Sending](#composing-and-sending)). `BODY`
here is composed/quoted reply text derived from the message being replied
to — load it via the heredoc pattern in
[Embedding message-derived text safely](#embedding-message-derived-text-safely)
first, then:

```bash
himalaya template send "$(himalaya template reply 42 -- "$BODY")"
himalaya template send "$(himalaya template reply -A 42 -- "$BODY")"
```

---

## Forwarding

Same pattern as replying:

- `himalaya message forward [OPTIONS] <ID> [BODY]...` — its `--help`
  states it uses `$EDITOR` the same way `message reply` does; not
  suitable for a non-interactive run.
- `himalaya template forward [OPTIONS] <ID> [BODY]...` — generates the
  forward template (prefilled `From`, original message quoted with a
  separator) and prints it; no editor invoked.

Verified `template forward` options: `-f, --folder <NAME>` (default
`INBOX`); `-H, --header <KEY:VAL>` (repeatable); `-a, --account <NAME>`.
`BODY` is again message-derived text — load it via the same heredoc pattern:

```bash
himalaya template send "$(himalaya template forward 42 -- "$BODY")"
```

---

## Composing and Sending

For a scripted/agent session, prefer the `template` family over
`message write/edit` (which, like reply/forward, launch `$EDITOR` per
their own `--help` text and need a real interactive session).

`himalaya template write [OPTIONS] [BODY]...` generates a new-message
template (prefilled `From` + signature) and prints it — Observed directly:

```bash
$ himalaya template write --header "To:someone@example.com" --header "Subject:Test Subject" "Hello world"
From: Daneel AFW <daneel@aurorafw.com>
To: someone@example.com
Subject: Test Subject

Hello world
```

Verified `template write` options: `-H, --header <KEY:VAL>` (repeatable,
`KEY:VAL` pattern); `-a, --account <NAME>`.

`himalaya template send [OPTIONS] [TEMPLATE]...` compiles the given raw
template (headers + MML body) into a MIME message, sends it, and saves a
copy to the sent folder. Verified options: `-a, --account <NAME>`.

Compose and send in one step by capturing `template write`'s output and
passing it straight to `template send`. When `SUBJECT`/`BODY` are derived
from a message (as opposed to fixed text like the "Hello world" transcript
above), load them via the heredoc pattern in
[Embedding message-derived text safely](#embedding-message-derived-text-safely)
first:

```bash
himalaya template send "$(himalaya template write \
  -H 'To:person@example.com' \
  -H "Subject:$SUBJECT" \
  -- "$BODY")"
```

To save a draft instead of sending, use `himalaya template save
[OPTIONS] [TEMPLATE]...` (same shape as `template send`, plus
`-f, --folder <NAME>`, default `INBOX` — point it at the account's Drafts
folder).

Two lower-level, raw-message counterparts also exist for cases where the
message body is already a fully-formed MIME message rather than an MML
template: `himalaya message send [OPTIONS] [MESSAGE]...` and
`himalaya message save [OPTIONS] [MESSAGE]...` (the latter also takes
`-f, --folder <NAME>`). Prefer the `template` commands above when
composing from headers/body text — they build the MIME message for you.

**Not verified by live execution.** No test send was performed against
the configured account — sending a real message was out of scope for
checking CLI shape (himalaya account setup, and exercising a real send,
are both out of scope per this skill's task). The command shapes and
flags above are confirmed from `--help`; `template write`'s output format
was confirmed directly, `template send`'s argument-composition pattern
above follows from its own `--help` and `template write`'s Observed
output but has not itself been Observed end-to-end.

---

## Moving and Copying

```bash
himalaya message move [OPTIONS] <TARGET> <ID>...
himalaya message copy [OPTIONS] <TARGET> <ID>...
```

`<TARGET>` is the destination folder name; `<ID>...` is one or more
envelope ids. Verified options: `-f, --folder <SOURCE>` (source folder,
default `INBOX`); `-a, --account <NAME>`.

```bash
himalaya message move Archive 42 43
himalaya message copy -f INBOX Archive 42
```

To find valid folder names, list them first (verified via
`himalaya folder list --help`; options: `-a, --account <NAME>`,
`-w, --max-width <PIXELS>`):

```bash
himalaya folder list
```

---

## Deleting a Message

```bash
himalaya message delete [OPTIONS] <ID>...
```

Verified options: `-f, --folder <NAME>` (default `INBOX`); `-a, --account
<NAME>`. Per its own `--help`: "This command does not really delete the
message: if the given folder points to the trash folder, it adds the
`deleted` flag to its envelope, otherwise it moves it to the trash
folder. Only the expunge folder command truly deletes messages" — a soft
delete unless already acting on the trash folder.

```bash
himalaya message delete 42
himalaya message delete -f Archive 42 43
```

---

## Managing Flags

```bash
himalaya flag add [OPTIONS] <ID-OR-FLAG>...
himalaya flag set [OPTIONS] <ID-OR-FLAG>...
himalaya flag remove [OPTIONS] <ID-OR-FLAG>...
```

- `add` — attach the given flag(s) to the given envelope(s).
- `set` — replace existing flags with the given flag(s).
- `remove` — remove the given flag(s) from the given envelope(s).

Per `--help`: "Every argument that can be parsed as an integer is
considered an id, otherwise it is considered as a flag" — ids and flag
names can be freely interleaved. Verified options on all three: `-f,
--folder <NAME>` (default `INBOX`); `-a, --account <NAME>`.

```bash
himalaya flag add 42 43 flagged     # star two envelopes
himalaya flag remove 42 seen        # mark one envelope unseen again
himalaya flag set 42 seen flagged   # replace 42's flags with these two
```

---

## Handling Attachments

```bash
himalaya attachment download [OPTIONS] <ID>...
```

Downloads all attachments found in the given message(s) to the downloads
directory. Verified options: `-f, --folder <NAME>` (default `INBOX`);
`-a, --account <NAME>`; `-d, --downloads-dir <PATH>` (override the
download directory; otherwise uses the config's downloads directory or
`XDG_DOWNLOAD_DIR`).

```bash
himalaya attachment download 42
himalaya attachment download -d /tmp/downloads 42 43
```

`attachment` has only this one subcommand (`download`) per its own
`--help` — there is no separate "list attachments" command; use
`himalaya message read 42` to see which parts a message has before
downloading.

---

## Selecting an Account

Every command documented above accepts `-a, --account <NAME>` to
override the default account (an account name is an entry at the root of
the himalaya TOML config).

List configured accounts (Observed, no config secrets shown):

```bash
$ himalaya account list
| NAME   | BACKENDS   | DEFAULT |
|--------|------------|---------|
| daneel | IMAP, SMTP | yes     |
```

`himalaya account list --help` confirms the same global options as other
read commands (`-w, --max-width`, `-o, --output`, `-c, --config`). Account
*creation* (`account configure`) and diagnostics (`account doctor`) are
out of scope for this skill — account setup is assumed to already exist.
