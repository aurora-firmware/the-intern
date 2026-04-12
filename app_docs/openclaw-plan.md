# The Intern — MVP Design Document

**Date:** 2026-04-12
**Status:** Draft
**Scope:** MVP — single user, minimal security, core features only

---

## 1. Overview

The Intern is a personal AI assistant built on OpenClaw. It connects to the
user through Telegram and business email, runs two specialised agents, and uses
a mix of a local model (Ollama + Gemma) and the Claude API depending on the
task. Email is integrated through a workspace skill and a small Python CLI
rather than a built-in channel.

### Goals for MVP

- Receive and respond to messages via Telegram
- Read, search, send, and reply to business email (IMAP/SMTP)
- Delegate research tasks (web search, document lookup) to a specialised agent
- Keep all personal data local by default; use the cloud API only for research
- Log all agent activity with zero custom code using built-in hooks

### Out of scope for MVP

- Calendar and reminders integration
- Web UI chat interface
- Multi-user support
- Advanced security (allowlist is the only guard)
- Approval flows for sensitive actions

---

## 2. Architecture

```
User
├── Telegram (mobile + web.telegram.org)
│     └──► Personal Assistant Agent
│                │  (spawns subagent when research is needed)
│                └──► Researcher Agent
│
└── Business Email (IMAP/SMTP)
      └──► Personal Assistant Agent
               (via email-cli.py + business-email SKILL)
```

### Data flow — inbound message

```
Telegram message
  │
  ▼
OpenClaw Gateway (route resolver)
  │  matches: channel=telegram, account=main → agent=personal-assistant
  ▼
Personal Assistant (Ollama / Gemma)
  │  if email task → reads business-email SKILL → runs email-cli.py
  │  if research task → spawns Researcher subagent
  ▼
Researcher (Claude API)
  │  web_search + web_fetch tools
  ▼
Result returned to Personal Assistant → reply sent to user
```

### Data flow — inbound email

```
Email arrives in INBOX
  │
  ▼
User tells the PA via Telegram: "any new emails?"
  │
  ▼
PA reads business-email SKILL → runs:
  email-cli.py list --limit 10
  │
  ▼
Summarises unread messages → replies on Telegram
```

> **Note:** Email is pull-only in the MVP. The agent reads email when asked;
> it does not push Telegram notifications on new email arrival. That can be
> added later via a polling cron job or an IMAP IDLE watcher hook.

---

## 3. Components

| Component | Role | Built-in? |
|-----------|------|-----------|
| Telegram channel | Primary input/output | Native |
| Personal Assistant agent | Main agent, email + reminders | Native (config only) |
| Researcher agent | Web + document research | Native (config only) |
| Ollama + Gemma | Local model for PA | Native plugin |
| Claude API | Cloud model for Researcher | Native plugin |
| `email-cli.py` | IMAP/SMTP wrapper script | Custom (new file) |
| `business-email` SKILL | Teaches agent email CLI | Custom (new file) |
| `command-logger` hook | Command audit log | Native, needs enabling |
| `session-memory` hook | Session summaries | Native, needs enabling |
| Session transcripts | Full conversation JSONL | Native, always on |

---

## 4. Agents

### 4.1 Personal Assistant

| Property | Value |
|----------|-------|
| Agent ID | `personal-assistant` |
| Model | Gemma 3 via Ollama (local) |
| Channel binding | `telegram:main` (all messages) |
| Auto reply | Yes |
| Skills | `business-email` |

**Responsibilities:**
- Handle all Telegram conversations
- Read, search, send, and reply to business email via the email SKILL
- Manage reminders (in-context, no external calendar for MVP)
- Delegate research requests to the Researcher subagent

**System description (in config):**
```
You are a personal assistant called The Intern. You handle business email,
reminders, and day-to-day requests.

For email: use the business-email skill. Always confirm recipients and
subjects before sending or replying unless explicitly told to proceed.

For research (finding information online, analysing documents, looking things
up): spawn the researcher subagent rather than attempting it yourself.

Be concise. Prefer bullet points over paragraphs for summaries.
```

### 4.2 Researcher

| Property | Value |
|----------|-------|
| Agent ID | `researcher` |
| Model | Claude (claude-sonnet-4-6) via Anthropic API |
| Channel binding | None (spawned as subagent only) |
| Auto reply | No |
| Tools | `web_search`, `web_fetch` |

**Responsibilities:**
- Web search and page retrieval
- Internal document lookup (later iteration)
- Return structured summaries: findings, sources, confidence level

**System description (in config):**
```
You are a research specialist. Search the web and fetch pages to answer
questions accurately. Always return a structured summary with:
- Key findings (bullet points)
- Sources (URLs)
- Confidence: high / medium / low

Be thorough. Prefer primary sources. Note when information may be outdated.
```

---

## 5. Models

| Agent | Provider | Model | Reason |
|-------|----------|-------|--------|
| Personal Assistant | Ollama | gemma3 | Local, private, fast, no API cost |
| Researcher | Anthropic | claude-sonnet-4-6 | Stronger reasoning, better tool use |

The PA uses a local model because its tasks (email summaries, reminders,
conversation) are low-stakes and benefit from privacy. The Researcher uses
Claude because research tasks require stronger reasoning and the latency
tradeoff is acceptable.

---

## 6. Email Integration

Email is not a built-in OpenClaw channel. Instead it is implemented as a
**workspace skill**: a small Python CLI script the agent invokes directly,
guided by a `SKILL.md` instruction file.

### 6.1 How skills work in OpenClaw

OpenClaw injects a list of available skills into the agent's system prompt at
each turn (name + description + file path). When the agent decides a skill is
relevant, it reads the `SKILL.md` to get precise CLI instructions, then
executes the commands using its shell tool.

This means:
- The agent only loads the skill when email is relevant (lazy — no token cost
  on unrelated turns)
- Swapping the backend (different IMAP library, different CLI tool) only
  requires changing the Python script, not the SKILL.md or the config
- Credentials never appear in the OpenClaw config or agent context

### 6.2 Workspace structure

```
~/the-intern/
├── BOOTSTRAP.md                    ← runs at session start
├── skills/
│   └── email/
│       ├── SKILL.md               ← agent reads this on demand
│       └── bin/
│           ├── email-cli.py       ← IMAP/SMTP wrapper (Python stdlib only)
│           └── email.env          ← credentials (never committed)
└── memory/                        ← session-memory hook outputs
```

### 6.3 `email.env`

```bash
# Business email credentials — do not commit this file
EMAIL_IMAP_HOST=mail.yourcompany.com
EMAIL_IMAP_PORT=993
EMAIL_SMTP_HOST=mail.yourcompany.com
EMAIL_SMTP_PORT=587
EMAIL_USER=you@yourcompany.com
EMAIL_PASS=your-app-password-or-token
EMAIL_FROM=Your Name <you@yourcompany.com>
```

Use an app-specific password or OAuth token. Do not use your main account
password.

### 6.4 `skills/email/SKILL.md`

````markdown
---
name: business-email
description: Read, search, reply to, and send business email over IMAP/SMTP.
  Use this skill whenever the user asks about emails, wants to send a message,
  check the inbox, find a thread, or reply to someone.
openclaw:
  requires:
    bins: [python3]
  emoji: "📧"
---

# Business Email Skill

All email operations go through a single script:

  python3 ~/the-intern/skills/email/bin/email-cli.py <command> [args]

Credentials are loaded from email.env automatically. All commands output JSON.
Always parse JSON and present results in natural language — never show raw JSON.

---

## Commands

### List inbox
```
python3 ~/the-intern/skills/email/bin/email-cli.py list --limit 20
```
Output: `[{ id, from, subject, date, read, snippet }, ...]`

### Read a message
```
python3 ~/the-intern/skills/email/bin/email-cli.py read --id <message-id>
```
Output: `{ id, from, to, cc, subject, date, body, thread_id }`
This also marks the message as read.

### Search messages
```
python3 ~/the-intern/skills/email/bin/email-cli.py search --query "from:boss@co.com subject:invoice since:2026-04-01"
```
Supported prefixes: `from:`, `to:`, `subject:`, `since:YYYY-MM-DD`,
`before:YYYY-MM-DD`, free text.
Output: same shape as list.

### Send a new message
```
python3 ~/the-intern/skills/email/bin/email-cli.py send \
  --to "recipient@example.com" \
  --subject "Subject line" \
  --body "Message body"
```

### Reply to a message
```
python3 ~/the-intern/skills/email/bin/email-cli.py reply \
  --id <message-id> \
  --body "Reply text"
```
Sets Reply-To, References, and In-Reply-To headers automatically.

### Mark as read or unread
```
python3 ~/the-intern/skills/email/bin/email-cli.py flag --id <id> --read true
python3 ~/the-intern/skills/email/bin/email-cli.py flag --id <id> --read false
```

---

## Rules

- Never show the user raw JSON.
- Before sending or replying, confirm recipient and subject with the user
  unless they explicitly said "go ahead" or "send it".
- "Check email" or "any new messages" → run list --limit 10, filter to unread.
- Errors return `{ "error": "..." }` — report them clearly.
````

### 6.5 `skills/email/bin/email-cli.py`

```python
#!/usr/bin/env python3
"""
Business email CLI for The Intern.
Uses Python stdlib only (imaplib + smtplib). No external dependencies.
Reads credentials from email.env in the same directory.
All output is JSON to stdout.
"""

import argparse
import email as email_lib
import imaplib
import json
import os
import smtplib
import sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid
from pathlib import Path


# ── Credentials ───────────────────────────────────────────────────────────────

def load_env() -> None:
    env_path = Path(__file__).parent / "email.env"
    if not env_path.exists():
        sys.exit(json.dumps({"error": f"email.env not found at {env_path}"}))
    for line in env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            key, _, value = line.partition("=")
            os.environ.setdefault(key.strip(), value.strip())

load_env()

IMAP_HOST  = os.environ["EMAIL_IMAP_HOST"]
IMAP_PORT  = int(os.environ.get("EMAIL_IMAP_PORT", "993"))
SMTP_HOST  = os.environ["EMAIL_SMTP_HOST"]
SMTP_PORT  = int(os.environ.get("EMAIL_SMTP_PORT", "587"))
EMAIL_USER = os.environ["EMAIL_USER"]
EMAIL_PASS = os.environ["EMAIL_PASS"]
EMAIL_FROM = os.environ.get("EMAIL_FROM", EMAIL_USER)


# ── IMAP helpers ──────────────────────────────────────────────────────────────

def imap_connect() -> imaplib.IMAP4_SSL:
    conn = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT)
    conn.login(EMAIL_USER, EMAIL_PASS)
    return conn

def parse_message(raw: bytes) -> dict:
    msg = email_lib.message_from_bytes(raw)
    body = ""
    if msg.is_multipart():
        for part in msg.walk():
            if part.get_content_type() == "text/plain":
                payload = part.get_payload(decode=True)
                if payload:
                    charset = part.get_content_charset() or "utf-8"
                    body = payload.decode(charset, errors="replace")
                    break
    else:
        payload = msg.get_payload(decode=True)
        if payload:
            charset = msg.get_content_charset() or "utf-8"
            body = payload.decode(charset, errors="replace")

    return {
        "id":         msg.get("Message-ID", ""),
        "thread_id":  msg.get("In-Reply-To", ""),
        "references": msg.get("References", ""),
        "from":       msg.get("From", ""),
        "to":         msg.get("To", ""),
        "cc":         msg.get("Cc", ""),
        "subject":    msg.get("Subject", ""),
        "date":       msg.get("Date", ""),
        "read":       False,
        "body":       body.strip(),
        "snippet":    body.strip()[:150],
    }


# ── Commands ──────────────────────────────────────────────────────────────────

def cmd_list(args) -> None:
    conn = imap_connect()
    conn.select("INBOX")
    _, data = conn.search(None, "ALL")
    ids = data[0].split()[-args.limit:][::-1]
    results = []
    for uid in ids:
        _, raw   = conn.fetch(uid, "(RFC822)")
        parsed   = parse_message(raw[0][1])
        _, flags = conn.fetch(uid, "(FLAGS)")
        parsed["read"] = b"\\Seen" in flags[0]
        results.append(parsed)
    conn.logout()
    print(json.dumps(results, ensure_ascii=False))


def cmd_read(args) -> None:
    conn = imap_connect()
    conn.select("INBOX")
    _, data = conn.search(None, f'HEADER Message-ID "{args.id}"')
    ids = data[0].split()
    if not ids:
        print(json.dumps({"error": f"message not found: {args.id}"}))
        return
    _, raw = conn.fetch(ids[0], "(RFC822)")
    parsed = parse_message(raw[0][1])
    parsed["read"] = True
    conn.store(ids[0], "+FLAGS", "\\Seen")
    conn.logout()
    print(json.dumps(parsed, ensure_ascii=False))


def cmd_search(args) -> None:
    conn = imap_connect()
    conn.select("INBOX")
    criteria = []
    for token in args.query.split():
        if   token.startswith("from:"):    criteria.append(f'FROM "{token[5:]}"')
        elif token.startswith("to:"):      criteria.append(f'TO "{token[3:]}"')
        elif token.startswith("subject:"): criteria.append(f'SUBJECT "{token[8:]}"')
        elif token.startswith("since:"):   criteria.append(f'SINCE {token[6:]}')
        elif token.startswith("before:"):  criteria.append(f'BEFORE {token[7:]}')
        else:                              criteria.append(f'TEXT "{token}"')
    imap_query = " ".join(criteria) if criteria else "ALL"
    _, data = conn.search(None, imap_query)
    ids = data[0].split()[-20:][::-1]
    results = []
    for uid in ids:
        _, raw = conn.fetch(uid, "(RFC822)")
        results.append(parse_message(raw[0][1]))
    conn.logout()
    print(json.dumps(results, ensure_ascii=False))


def cmd_send(args) -> None:
    msg = EmailMessage()
    msg["From"]       = EMAIL_FROM
    msg["To"]         = args.to
    msg["Subject"]    = args.subject
    msg["Date"]       = formatdate()
    msg["Message-ID"] = make_msgid()
    msg.set_content(args.body)
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.ehlo()
        s.starttls()
        s.login(EMAIL_USER, EMAIL_PASS)
        s.send_message(msg)
    print(json.dumps({"ok": True, "message_id": msg["Message-ID"]}))


def cmd_reply(args) -> None:
    conn = imap_connect()
    conn.select("INBOX")
    _, data = conn.search(None, f'HEADER Message-ID "{args.id}"')
    ids = data[0].split()
    if not ids:
        print(json.dumps({"error": f"original not found: {args.id}"}))
        return
    _, raw = conn.fetch(ids[0], "(RFC822)")
    original = parse_message(raw[0][1])
    conn.logout()

    msg = EmailMessage()
    msg["From"]        = EMAIL_FROM
    msg["To"]          = original["from"]
    msg["Subject"]     = "Re: " + original["subject"].removeprefix("Re: ")
    msg["Date"]        = formatdate()
    msg["Message-ID"]  = make_msgid()
    msg["In-Reply-To"] = original["id"]
    msg["References"]  = (original.get("references") or "") + " " + original["id"]
    msg.set_content(args.body)
    with smtplib.SMTP(SMTP_HOST, SMTP_PORT) as s:
        s.ehlo()
        s.starttls()
        s.login(EMAIL_USER, EMAIL_PASS)
        s.send_message(msg)
    print(json.dumps({"ok": True, "replied_to": original["id"]}))


def cmd_flag(args) -> None:
    conn = imap_connect()
    conn.select("INBOX")
    _, data = conn.search(None, f'HEADER Message-ID "{args.id}"')
    ids = data[0].split()
    if not ids:
        print(json.dumps({"error": f"message not found: {args.id}"}))
        return
    conn.store(ids[0], "+FLAGS" if args.read else "-FLAGS", "\\Seen")
    conn.logout()
    print(json.dumps({"ok": True}))


# ── CLI wiring ────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(prog="email-cli")
    sub    = parser.add_subparsers(dest="cmd", required=True)

    p = sub.add_parser("list");   p.add_argument("--limit", type=int, default=20)
    p = sub.add_parser("read");   p.add_argument("--id", required=True)
    p = sub.add_parser("search"); p.add_argument("--query", required=True)

    p = sub.add_parser("send")
    p.add_argument("--to",      required=True)
    p.add_argument("--subject", required=True)
    p.add_argument("--body",    required=True)

    p = sub.add_parser("reply")
    p.add_argument("--id",   required=True)
    p.add_argument("--body", required=True)

    p = sub.add_parser("flag")
    p.add_argument("--id",   required=True)
    p.add_argument("--read", required=True,
                   type=lambda x: x.lower() == "true")

    args = parser.parse_args()
    dispatch = {
        "list":   cmd_list,
        "read":   cmd_read,
        "search": cmd_search,
        "send":   cmd_send,
        "reply":  cmd_reply,
        "flag":   cmd_flag,
    }
    try:
        dispatch[args.cmd](args)
    except KeyError as e:
        print(json.dumps({"error": f"missing env var: {e}"}))
    except Exception as e:
        print(json.dumps({"error": str(e)}))

if __name__ == "__main__":
    main()
```

---

## 7. OpenClaw Configuration

### `.openclaw.yml`

```yaml
# ── API credentials ───────────────────────────────────────────────────────────

profiles:
  anthropic:
    api_key: "${ANTHROPIC_API_KEY}"

# Ollama: no credentials needed, uses http://localhost:11434 by default

# ── Models ────────────────────────────────────────────────────────────────────

models:
  default: gemma3           # Local model for the PA

# ── Channels ─────────────────────────────────────────────────────────────────

channels:
  telegram:
    - name: main
      bot_token: "${TELEGRAM_BOT_TOKEN}"
      security:
        allowlist:
          - "user_id:YOUR_TELEGRAM_USER_ID"   # Only you

# ── Workspace ────────────────────────────────────────────────────────────────

workspace:
  dir: ~/the-intern

# ── Skills ───────────────────────────────────────────────────────────────────

skills:
  load:
    extraDirs:
      - ~/the-intern/skills   # picks up the email skill

# ── Hooks ────────────────────────────────────────────────────────────────────

hooks:
  internal:
    entries:
      command-logger:
        enabled: true
      session-memory:
        enabled: true
        messages: 20   # messages to include in each summary

# ── Agents ───────────────────────────────────────────────────────────────────

agents:
  personal-assistant:
    name: "Intern"
    description: |
      You are a personal assistant called The Intern.
      You handle business email, reminders, and day-to-day requests.

      For email: always use the business-email skill. Confirm recipients and
      subject before sending or replying unless explicitly told to proceed.

      For research (finding information online, analysing documents): spawn
      the researcher subagent instead of attempting it yourself.

      Be concise. Prefer bullet points for summaries.
    auto_reply: true
    model:
      default: gemma3
      provider: ollama
    bindings:
      - channel: telegram
        account: main

  researcher:
    name: "Researcher"
    description: |
      You are a research specialist. Search the web and fetch pages to answer
      questions accurately. Return a structured summary with:
      - Key findings (bullet points)
      - Sources (URLs)
      - Confidence: high / medium / low
    auto_reply: false
    model:
      default: claude-sonnet-4-6
      provider: anthropic
    tools:
      web_search: true
      web_fetch: true
```

---

## 8. Logging

Three logging layers are active after enabling the hooks above:

| Layer | Location | What is captured | Setup |
|-------|----------|-----------------|-------|
| Session transcripts | `~/.openclaw/agents/<id>/sessions/*.jsonl` | Full conversation: every message, tool call, tool result | Always on, nothing to do |
| Command audit log | `~/.openclaw/logs/commands.log` | `/new`, `/reset`, `/stop` — timestamp, session, channel, sender | `command-logger: enabled: true` |
| Session summaries | `~/the-intern/memory/YYYY-MM-DD-slug.md` | LLM-generated summary of each session at `/new` or `/reset` | `session-memory: enabled: true` |

### What the command log looks like

```jsonl
{"timestamp":"2026-04-12T09:14:00.000Z","action":"new","sessionKey":"agent:personal-assistant:main","senderId":"12345678","source":"telegram"}
{"timestamp":"2026-04-12T17:32:11.000Z","action":"stop","sessionKey":"agent:personal-assistant:main","senderId":"12345678","source":"telegram"}
```

### Querying activity after the fact

```bash
# Commands today
grep "2026-04-12" ~/.openclaw/logs/commands.log | jq .

# Session transcripts for the PA agent
ls ~/.openclaw/agents/personal-assistant/sessions/

# Today's session summaries
ls ~/the-intern/memory/2026-04-12-*.md
```

---

## 9. Setup Sequence

### Phase 1 — Telegram + PA + local model (Day 1, ~1 hour)

1. Install Ollama and pull the model:
   ```bash
   brew install ollama          # or the Linux equivalent
   ollama pull gemma3
   ollama serve                 # keep running in background
   ```
2. Create a Telegram bot via `@BotFather`. Note the bot token.
3. Find your Telegram user ID via `@userinfobot`. Note the numeric ID.
4. Create `~/.openclaw.yml` with the config above (Telegram section only,
   single agent).
5. Start the gateway:
   ```bash
   openclaw gateway run
   ```
6. Send a message to your bot on Telegram. Verify the PA replies.

### Phase 2 — Email skill (Day 1–2, ~30 minutes)

1. Create the workspace structure:
   ```bash
   mkdir -p ~/the-intern/skills/email/bin
   mkdir -p ~/the-intern/memory
   ```
2. Create `email.env` with your IMAP/SMTP credentials.
3. Copy `email-cli.py` into `~/the-intern/skills/email/bin/`.
4. Make it executable: `chmod +x ~/the-intern/skills/email/bin/email-cli.py`
5. Create `SKILL.md` in `~/the-intern/skills/email/`.
6. Add the `skills.load.extraDirs` line to `.openclaw.yml`.
7. Test the script directly:
   ```bash
   python3 ~/the-intern/skills/email/bin/email-cli.py list --limit 5
   ```
8. Reload the gateway and ask the PA: "do I have any new emails?"

### Phase 3 — Researcher subagent (Day 2, ~15 minutes)

1. Add `ANTHROPIC_API_KEY` to your environment:
   ```bash
   export ANTHROPIC_API_KEY=sk-...    # add to ~/.profile or equivalent
   ```
2. Add the `researcher` agent block to `.openclaw.yml`.
3. Add the Anthropic profile block.
4. Reload the gateway.
5. Test: ask the PA "research the latest news on open source LLMs".

### Phase 4 — Logging hooks (Day 2, ~5 minutes)

1. Add the `hooks` block to `.openclaw.yml`.
2. Reload the gateway.
3. Issue a `/new` command to trigger the first `session-memory` write.
4. Check `~/the-intern/memory/` for the generated summary.

---

## 10. Decisions and Trade-offs

### Why two agents instead of one?

A single agent with all capabilities would need to switch models per-task,
which OpenClaw does not support mid-conversation. Keeping them separate lets
the PA run locally (fast, private, no cost) and the Researcher run on Claude
(better reasoning, tool use). The subagent pattern is also the natural
OpenClaw idiom for task delegation.

### Why a SKILL for email instead of a channel plugin?

A channel plugin would require writing TypeScript against the OpenClaw plugin
SDK, deploying it, keeping it in sync with SDK changes, and handling inbound
email push (IMAP IDLE or polling). The SKILL approach needs only a Python
script and a markdown file. It is sufficient for one user checking email on
demand and is trivially swappable.

### Why pull-only email for MVP?

Push notifications (agent messages you when a new email arrives) require
either IMAP IDLE (a persistent connection) or a polling cron job. Both add
infrastructure complexity. For MVP, the user asks the agent about email — the
agent fetches it. Push can be added later as a cron hook.

### Why Gemma for the PA?

Personal assistant tasks (email summaries, reminders, conversation) are
low-stakes, latency-sensitive, and privacy-relevant. A local model keeps
personal email content off external APIs. Gemma 3 handles these tasks
adequately. Upgrade to a stronger local model later if needed.

### Why Claude for the Researcher?

Research tasks require stronger reasoning, better tool-use, and access to
current web content. The Researcher is invoked less frequently so latency
and cost are acceptable. Claude's `web_search` and `web_fetch` tool
integrations are mature.

---

## 11. Future Iterations

| Feature | Approach |
|---------|---------|
| Email push notifications | Add IMAP IDLE watcher as a cron hook or standalone daemon |
| Calendar integration | New SKILL + CalDAV CLI scripts (same pattern as email) |
| Internal document search | Researcher agent + local vector DB (LanceDB, built-in) |
| Web UI chat | Matrix channel (has web client) or custom channel plugin |
| Token/cost tracking | Plugin with `llm_output` hook → daily JSONL log |
| Second user | Add to Telegram allowlist; assign a separate agent binding |
| Approval flows | `before_tool_call` plugin hook for send/reply confirmation |
