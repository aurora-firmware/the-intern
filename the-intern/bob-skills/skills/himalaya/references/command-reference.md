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

**Worked example: retrieving identity headers in one call.** A caller that
needs a message's identity headers — `From`, `Subject`, `Date`, and
`Message-ID` — to build a stable item-identifier (for example, `email-triage`'s
`Message-ID`-discriminated identifier) repeats `-H` once per header, and
combines it with `--preview` whenever the read must not set `\Seen`:

```bash
himalaya message read --preview -H From -H Subject -H Date -H Message-ID 42
```

`--preview` here is the same flag documented above — it reads without
marking the envelope `Seen` — and applies regardless of how many `-H` flags
are given alongside it.

Reading a message (without `--preview`) sets its `Seen` flag as a side
effect — this is how the mailbox itself, not a separate state file, tracks
what has already been looked at.

**Attachment `filename=` path pitfall (Observed).** When a message
has an attachment, `message read` renders its MML part as `<#part
type=... filename="..."><#/part>`, and that `filename=` value looks like a
real, already-usable local path — but it isn't one yet. It's synthesized
by joining the account's configured `downloads-dir` (see [Handling
Attachments](#handling-attachments)) with the bare basename recovered from
the message's own `Content-Disposition: filename` header, with no check
that a file actually exists there. The rendered path is identical whether
or not `himalaya attachment download` has ever been run for that message:

```text
$ himalaya message read -f INBOX --preview 254
From: Daneel AFW <daneel@aurorafw.com>
To: daneel@aurorafw.com
Subject: Attachment verification

<#part type=application/pdf filename="/home/daneel/Downloads/b5793ba8-3e11-4640-bbf5-fc56ee7f7e02.pdf"><#/part>

$ ls /home/daneel/Downloads/b5793ba8-3e11-4640-bbf5-fc56ee7f7e02.pdf
ls: cannot access '/home/daneel/Downloads/b5793ba8-3e11-4640-bbf5-fc56ee7f7e02.pdf': No such file or directory

$ himalaya attachment download -f INBOX 254
1 attachment(s) found for message 254!
Downloading "/home/daneel/Downloads/b5793ba8-3e11-4640-bbf5-fc56ee7f7e02.pdf"…
Downloaded 1 attachment!

$ ls -la /home/daneel/Downloads/b5793ba8-3e11-4640-bbf5-fc56ee7f7e02.pdf
-rw-r--r-- 1 daneel daneel 49 Sep 20 16:07 /home/daneel/Downloads/b5793ba8-3e11-4640-bbf5-fc56ee7f7e02.pdf
```

Treat a `filename=` value shown by `message read` as a prediction of where
`attachment download` *would* save the file, never as proof it's already
there — run `attachment download` (or check the filesystem directly)
before assuming the rendered path can be opened. The prediction can also
be wrong: if the attachment's basename collides with a file already
downloaded from an earlier message, `attachment download` applies its own
`_N` collision-avoidance renaming, so the file can end up saved somewhere
other than the path `message read` rendered — the render never accounts
for this.

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
`template send` doesn't need this — piped in (see below), it takes no
`TEMPLATE` argument of its own to protect.

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

Compose-and-send in one step: generate the template and pipe its output
straight into `template send` ([Composing and Sending](#composing-and-sending)
covers why it must be a pipe, not a captured-and-spliced `$(...)`
substitution). `BODY` here is composed/quoted reply text derived
from the message being replied to — load it via the heredoc pattern in
[Embedding message-derived text safely](#embedding-message-derived-text-safely)
first, then:

```bash
himalaya template reply 42 -- "$BODY" | himalaya template send
himalaya template reply -A 42 -- "$BODY" | himalaya template send
```

**To attach a real file to a reply, do not use this `-- "$BODY"` shape.**
`template reply`'s own `BODY` argument silently escapes MML attachment
syntax instead of sending it (Observed) — see [Sending an
Attachment](#sending-an-attachment-mml-syntax) for the working,
no-`BODY`-argument composition pattern.

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
`BODY` is again message-derived text — load it via the same heredoc pattern,
then pipe the template straight into `template send`, the same corrected
shape [Composing and Sending](#composing-and-sending) explains:

```bash
himalaya template forward 42 -- "$BODY" | himalaya template send
```

`template forward` was Observed to share `template write`/`template
reply`'s MML attachment-escaping defect on its own `BODY` argument
(Observed) — the same `-- "$BODY"` shape above silently drops any
`<#part>` attachment in `BODY` instead of sending it. See [Sending an
Attachment](#sending-an-attachment-mml-syntax) for the working pattern;
the no-`BODY`-argument-plus-splice approach documented there for
`template reply` is expected to apply the same way to `template forward`'s
own quoted-original skeleton, though this was not itself re-verified for
`forward` in this session.

---

## Composing and Sending

For a scripted/agent session, prefer the `template` family over
`message write/edit` (which, like reply/forward, launch `$EDITOR` per
their own `--help` text and need a real interactive session).

`himalaya template write [OPTIONS] [BODY]...` generates a new-message
template (prefilled `From` + signature) and prints it — Observed directly:

```bash
$ himalaya template write --header "To:someone@example.com" --header "Subject:Test Subject" "Hello world"
From: Example User <user@example.invalid>
To: someone@example.com
Subject: Test Subject

Hello world
```

Verified `template write` options: `-H, --header <KEY:VAL>` (repeatable,
`KEY:VAL` pattern); `-a, --account <NAME>`.

`himalaya template send [OPTIONS] [TEMPLATE]...` compiles the given raw
template (headers + MML body) into a MIME message and sends it. Verified
options: `-a, --account <NAME>`.

**Sent-copy pitfall (Observed).** A `Message successfully sent!` result is
not evidence that a copy was saved to a Sent mailbox — whether one is
saved depends entirely on the account's own `message.send.save-copy`
Himalaya configuration setting. At least one deployed account is confirmed
to run with `save-copy = false`, so nothing appears in that account's Sent
mailbox even though the send succeeded — for the account this was
Observed against, its Sent mailbox happens to be named `INBOX.Sent`, which
is that account's own config value, not a general default; another
account's Sent mailbox may be named or namespaced differently. A
no-duplicate-send check that searches Sent mailboxes for a prior
escalation is only reliable once `save-copy` is confirmed enabled for the
account in use — check the account's Himalaya config, or send a test
message and immediately search for it, before relying on a Sent-mailbox
search. When `save-copy` is disabled or unconfirmed, treat the send
command's own success output, or another locally recorded record of
having sent it (e.g. a worklog entry), as the retained evidence instead.

**Positional-argument pitfall (Observed).** Despite `--help`
advertising `[TEMPLATE]...` as a positional argument, `template send`
cannot actually parse a template handed to it that way: capturing another
command's output and splicing it in via `$(...)` —
`himalaya template send "$(himalaya template write ...)"` — fails outright
with `Error: 0: cannot parse template`, confirmed against the installed
binary. Piping the identical content on stdin instead works. Always
compose with a pipe, never a captured-and-spliced `$(...)` substitution.
`template save` fails the same way for the same reason, so the same rule
applies there too (see below).

Compose and send in one step by piping `template write`'s output straight
into `template send`. When `SUBJECT`/`BODY` are derived from a message (as
opposed to fixed text like the "Hello world" transcript above), load them
via the heredoc pattern in
[Embedding message-derived text safely](#embedding-message-derived-text-safely)
first:

```bash
himalaya template write \
  -H 'To:person@example.com' \
  -H "Subject:$SUBJECT" \
  -- "$BODY" | himalaya template send
```

To attach a real file, do not put an MML `<#part>` block in `BODY` this
way — `template write`'s own `BODY` argument silently escapes it instead
of sending it (Observed). See [Sending an
Attachment](#sending-an-attachment-mml-syntax) for the working pattern.

To save a draft instead of sending, pipe the same way into `himalaya
template save [OPTIONS]` (same corrected pipe shape as `template send`,
plus `-f, --folder <NAME>`, default `INBOX` — point it at the account's
Drafts folder).

Two lower-level, raw-message counterparts also exist for cases where the
message body is already a fully-formed MIME message rather than an MML
template: `himalaya message send [OPTIONS] [MESSAGE]...` and
`himalaya message save [OPTIONS] [MESSAGE]...` (the latter also takes
`-f, --folder <NAME>`). Prefer the `template` commands above when
composing from headers/body text — they build the MIME message for you.

**Composition pattern corrected and live-exercised.** An earlier
revision of this reference showed the composition above built with `$(...)`
capture-and-splice rather than a pipe. That shape was tried against the
installed binary and failed outright — `Error: 0: cannot parse template` —
because `template send`/`template save` cannot parse a template supplied as
a positional CLI argument, even though `--help` advertises `[TEMPLATE]...`
as accepting one. The pipe form shown above is the corrected, working
shape: this was confirmed twice in the same session, once by a manual
control test isolating the positional-vs-pipe behavior directly, and once
by a live escalation-send that actually completed using the pipe form.
`template write`'s own output format was Observed directly (the "Hello
world" transcript above); the remaining command shapes and flags are
confirmed from `--help`.

---

## Sending an Attachment (MML Syntax)

A real file attachment is an MML *part* directive, compiled by `template
send` into a real MIME attachment when it appears anywhere in the
template text handed to it:

```text
<#part type=<MIME-TYPE> filename="<ABSOLUTE-PATH>"><#/part>
```

`type` is the attachment's MIME type (e.g. `application/pdf`,
`application/octet-stream`); `filename` must be an absolute path to a file
that already exists on disk. `himalaya template --help` documents MML as
backed by the [`mml-lib`](https://crates.io/crates/mml-lib) crate.

**MML attachment-escaping pitfall (Observed).** `template write`,
`template reply`, and `template forward` (confirmed for all three)
unconditionally escape any `<#...>`/`<#/...>` MML syntax found in their
own `BODY` positional argument into inert `<#!...>` text — before the
result is ever piped anywhere. Passing an MML `<#part>` block as `BODY`
the same way the rest of this reference passes ordinary message text (see
[Embedding message-derived text
safely](#embedding-message-derived-text-safely)) silently fails to attach
anything:

```text
$ BODY='<#part type=application/pdf filename="/home/daneel/Documents/quarterly-report.pdf"><#/part>'
$ himalaya template write -H 'To:daneel@aurorafw.com' -H 'Subject:Quarterly report' -- "$BODY"
From: Daneel AFW <daneel@aurorafw.com>
To: daneel@aurorafw.com
Subject: Quarterly report

<#!part type=application/pdf filename="/home/daneel/Documents/quarterly-report.pdf"><#!/part>
```

The `<#!part ...><#!/part>` above is `template write`'s own stdout, before
any piping — the escaping happens inside `template write`/`template
reply`/`template forward` themselves, not in `template send`'s parsing of
piped input. Piped into `template send` regardless, the message still
sends (`Message successfully sent!`), but `envelope list -o json` shows
`"has_attachment":false` and the recipient sees the escaped tag text
verbatim instead of a file — nothing in the command's output signals the
failure.

**Verified working pattern.** Call `template write`/`template reply` with
**no `BODY` argument at all** — the escaping only happens when `BODY` is
given, so the headers-only (`template write`) or headers-plus-quoted-
original-skeleton (`template reply`) output produced without it is
unaffected. Splice the raw, un-escaped `<#part>...<#/part>` block into the
template's empty new-body slot yourself, keeping **exactly one blank line
before and after** the spliced part — getting this wrong (e.g. dropping
the blank line that separates headers from body) silently breaks MML
parsing a different way and also produces `has_attachment:false`, with no
error. Then pipe the whole assembled template into `template send`, the
same corrected pipe shape every other composition example in this
reference uses.

Composing a new message with an attachment:

```bash
HEADERS=$(himalaya template write -H 'To:person@example.com' -H 'Subject:Quarterly report')
PART='<#part type=application/pdf filename="/path/to/file.pdf"><#/part>'
printf '%s' "$HEADERS"$'\n\n'"$PART"$'\n' | himalaya template send
```

Observed working transcript from a live account (the assembled template,
before piping):

```text
From: Daneel AFW <daneel@aurorafw.com>
To: daneel@aurorafw.com
Subject: Quarterly report

<#part type=application/pdf filename="/home/daneel/Documents/quarterly-report.pdf"><#/part>
```

Delivered message: `envelope list -o json` shows `"has_attachment":true`;
`himalaya attachment download <id>` downloads a copy that is
byte-identical (`diff`) to the source file.

Replying with an attachment: `template reply`'s no-`BODY` skeleton
includes the quoted original after the empty new-body
slot, so the part has to land between the header/body separator and the
blank line before the quote, not just be appended at the end. The empty
new-body slot in a no-`BODY` reply skeleton is exactly a 4-newline run
(header/body separator + empty body + separator before the quote);
replacing it with 2 newlines + the part + 2 newlines keeps exactly one
blank line on each side:

```bash
SKELETON=$(himalaya template reply <id> -H 'To:person@example.com')
PART='<#part type=application/pdf filename="/path/to/file.pdf"><#/part>'
FULL="${SKELETON/$'\n\n\n\n'/$'\n\n'"$PART"$'\n\n'}"
case "$FULL" in
  *"$PART"*) ;;
  *) echo 'splice did not apply — skeleton lacked the expected 4-newline run; sending now would silently drop the attachment' >&2; exit 1 ;;
esac
printf '%s' "$FULL" | himalaya template send
```

Observed working transcript from a live account (the assembled reply
template, before piping — replying to message 247, subject "Quarterly
numbers", body
"Draft body for the seed message."):

```text
From: Daneel AFW <daneel@aurorafw.com>
To: daneel@aurorafw.com
In-Reply-To: <18d70bf4c36964c4.55de1fe2b2a292f0.22ebeef29a4ed330@auroralab>
Subject: Re: Quarterly numbers

<#part type=application/pdf filename="/home/daneel/Documents/quarterly-report.pdf"><#/part>

On 20/09/2026 13:55, Daneel AFW wrote:
> Draft body for the seed message.
```

Same result: `has_attachment:true`, downloaded attachment byte-identical
to the source. This `${SKELETON/pattern/replacement}` splice assumes the
standard single-`<#part>`, single-paragraph-quote reply shape. If
`$SKELETON` doesn't contain that exact 4-newline run, bash's
`${var/pattern/replacement}` returns the string **unchanged, with exit
status 0** — `$FULL` silently becomes the un-spliced skeleton, and piping
it into `template send` sends a normal reply with no attachment and no
error, the same silent-failure class as the two pitfalls above. The `case`
guard in the snippet above catches this by checking `$FULL` actually
contains `$PART` before sending; don't drop it. For a one-off reply,
splicing the part into the captured skeleton text by hand (rather than a
shell substitution) works identically, as long as the
one-blank-line-before-and-after rule above is kept — getting it wrong
looks exactly like this (Observed, dropping the header/body blank line):

```text
From: Daneel AFW <daneel@aurorafw.com>
To: daneel@aurorafw.com
In-Reply-To: <18d70bf4c36964c4.55de1fe2b2a292f0.22ebeef29a4ed330@auroralab>
Subject: Re: Quarterly numbers
<#part type=application/pdf filename="/home/daneel/Documents/quarterly-report.pdf"><#/part>

On 20/09/2026 13:55, Daneel AFW wrote:
> Draft body for the seed message.
```

— sends successfully but delivers `"has_attachment":false`, the same
silent failure as the escaping pitfall above, from a different cause.

`template forward` was Observed to escape its own `BODY` argument the
same way (see [Forwarding](#forwarding)); the no-`BODY`-argument-plus-
splice pattern above is expected to apply there too but was not itself
re-verified for `forward` in this session.

**`text/plain` attachment trailing-CRLF pitfall (Observed).** An
MML `<#part>` whose `type` attribute is the exact lowercase string
`text/plain` can be delivered with a spurious trailing blank line
appended to the attached file's content — a different, unrelated defect
from the escaping pitfall above (this one corrupts real content
bytes rather than failing to attach at all). The defect is
**content-shape/size dependent, not universal**: himalaya auto-selects
the attachment's `Content-Transfer-Encoding` based on the content, and
only `7bit`/`quoted-printable` (selected for multi-line content, content
missing its own trailing newline, or long single-line content) expose the
appended terminator as real corrupted bytes. Short, single-line,
already-newline-terminated content happens to select `base64`, which
absorbs the extra terminator and round-trips clean — do not treat a clean
result on small test content as proof the pitfall doesn't apply; verify
with multi-line or otherwise larger content instead.

```text
$ cat multi-line.txt
This is line one.
This is line two of the re-verification file.
Third line here.

$ wc -c multi-line.txt
91 multi-line.txt

$ HEADERS=$(himalaya template write -H 'To:daneel@aurorafw.com' -H 'Subject:RED verification')
$ PART='<#part type=text/plain filename="/path/to/multi-line.txt"><#/part>'
$ printf '%s' "$HEADERS"$'\n\n'"$PART"$'\n' | himalaya template send
Message successfully sent!

$ himalaya envelope list -o json -s 1
[{"id":"269", ..., "has_attachment":true}]

$ himalaya attachment download 269
1 attachment(s) found for message 269!
Downloading "/home/daneel/Downloads/multi-line.txt"…
Downloaded 1 attachment!

$ diff multi-line.txt /home/daneel/Downloads/multi-line.txt
3a4
>

$ wc -c /home/daneel/Downloads/multi-line.txt
93 /home/daneel/Downloads/multi-line.txt

$ himalaya message export -F 269 | grep -i content-t
Content-Type: text/plain
Content-Transfer-Encoding: quoted-printable
```

The downloaded copy is 2 bytes longer than the source — a spurious extra
blank line — even though `has_attachment` correctly reported `true` and
nothing in `template send`'s output signalled the corruption.

**Verified working pattern.** Spell the MML part's `type` attribute with
any casing other than the exact lowercase string `text/plain` — e.g.
`TEXT/PLAIN`. Per RFC 2045, MIME type/subtype matching is
case-insensitive, so this is a standards-valid `text/plain` media type
for the recipient, not a hack that changes what the file is delivered
as — it only avoids the internal himalaya composition path that has the
defect, which is keyed on the *exact* lowercase spelling:

```text
$ HEADERS=$(himalaya template write -H 'To:daneel@aurorafw.com' -H 'Subject:GREEN verification')
$ PART='<#part type=TEXT/PLAIN filename="/path/to/multi-line.txt"><#/part>'
$ printf '%s' "$HEADERS"$'\n\n'"$PART"$'\n' | himalaya template send
Message successfully sent!

$ himalaya envelope list -o json -s 1
[{"id":"270", ..., "has_attachment":true}]

$ himalaya attachment download 270
1 attachment(s) found for message 270!
Downloading "/home/daneel/Downloads/multi-line.txt"…
Downloaded 1 attachment!

$ diff multi-line.txt /home/daneel/Downloads/multi-line.txt
$ echo $?
0

$ wc -c /home/daneel/Downloads/multi-line.txt
91 /home/daneel/Downloads/multi-line.txt

$ himalaya message export -F 270 | grep -i content-t
Content-Type: TEXT/PLAIN
Content-Transfer-Encoding: base64
```

Byte-identical to the source, same file and same content that reliably
corrupted above as `type=text/plain`.

A binary or opaque MIME type such as `application/octet-stream` — or a
real type like `application/pdf` as shown earlier in this section — is
also always safe: neither one ever enters the text-body-formatting path
this defect lives in, regardless of content shape or size, so either
remains a valid alternative to the case-spelling workaround for callers
that don't need the recipient to see a `text/plain` type specifically.

---

## Finding the Account's Own Address

`himalaya template write`, invoked with no arguments, emits a draft whose
first line is a `From:` header carrying the account's display name and
configured email address (Observed — the same command as the "Hello
world" transcript above, run with nothing supplied):

```bash
$ himalaya template write
From: Example User <user@example.invalid>
To:
Subject:


```

This is the CLI's route to the account's own configured address: nothing
else covered in this reference exposes it. `himalaya account list` (see
[Selecting an Account](#selecting-an-account)) reports only account name,
backend(s), and default flag, in both `plain` and `-o json` output, and
`himalaya account doctor` reports only integrity-check results (Observed):

```bash
$ himalaya account doctor
Checking TOML configuration integrity for default account… OK
Checking IMAP integrity… OK
Checking SMTP integrity… OK
```

Neither command's output contains an email address. To recover just the
address (not the display name) from `template write`'s output, parse the
`From:` line: the address is the text inside the trailing `<...>` angle
brackets.

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

**Hardcoded trash-destination pitfall (Observed).** Despite the
`--help` text above, `message delete`'s move-to-trash destination and its
already-in-trash detection are both hardcoded to the literal folder name
`Trash`, never consulting the account's configured `folder.alias.trash`.
On any account whose real trash folder isn't literally named `Trash` (a
localized name, or one nested under an `INBOX.` namespace, such as this
account's `folder.alias.trash = "INBOX.Papelera"`), `message delete` fails
outright:

```text
$ himalaya message delete 42
unexpected NO response: Client tried to access nonexistent namespace. (Mailbox name should probably be prefixed with: INBOX.)
```

`-f` only selects delete's *source* folder, never its broken destination
resolution, so no `-f` value works around this — confirmed against the
installed binary: the identical error occurs both for an ordinary INBOX
message and for a message already sitting in the account's real trash
folder (`himalaya message delete -f INBOX.Papelera 8` fails the same way).
Both commands below take the destination as an explicit argument with no
hardcoded fallback, and were Observed to work directly against the same
account. `<trash-folder>` is a placeholder, not a literal value to
copy — every account (and every provider) can name its trash folder
differently; resolve the real name first from `folder.alias.trash` in
the account's config, or by listing folders (see [Moving and
Copying](#moving-and-copying)). For the account used in this session it
happens to be `INBOX.Papelera`, per the pitfall transcript above — that
is this account's own config value, not a general default:

**Replacement for `message delete`:**

```bash
himalaya message move <trash-folder> 42                # ordinary message -> trash
himalaya flag add 42 deleted -f <trash-folder>          # already-in-trash -> soft delete
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

This section covers *downloading* attachments from an existing message.
To attach a file to an outgoing message (compose, reply, or forward), see
[Sending an Attachment](#sending-an-attachment-mml-syntax) — do not pass
an MML `<#part>` block as `BODY` to `template write`/`template
reply`/`template forward`, it gets silently escaped instead of sent
(Observed).

Before assuming a message's attachment is already available locally, see
[Reading a Message](#reading-a-message) for the `filename=` path pitfall
(Observed) — the local path `message read` renders for an
attachment part is a synthesized prediction, not evidence the file
already exists on disk.

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
| NAME    | BACKENDS   | DEFAULT |
|---------|------------|---------|
| my_user | IMAP, SMTP | yes     |
```

`himalaya account list --help` confirms the same global options as other
read commands (`-w, --max-width`, `-o, --output`, `-c, --config`). Account
*creation* (`account configure`) and diagnostics (`account doctor`) are
out of scope for this skill — account setup is assumed to already exist.

Neither `account list` nor `account doctor` exposes the account's
configured email address — to obtain that, use `himalaya template write`
instead; see [Finding the Account's Own Address](#finding-the-accounts-own-address).
