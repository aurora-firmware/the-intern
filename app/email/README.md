# Email

The result of a conversation with CLAUDE, already gave us some python tooling.

## Architecture

```
┌─────────────────────────────────────────┐
│              Entry points               │
│  CLI call  │  cron/trigger  │  IMAP idle│
└─────┬──────────────┬─────────────┬──────┘
      │              │             │
┌─────▼──────────────▼─────────────▼──────┐
│           Agent Core (Claude API)        │
│         system prompt + tool loop        │
└─────────────────┬───────────────────────┘
                  │ tool calls
┌─────────────────▼───────────────────────┐
│              Mail Tools                  │
│  fetch · read · send · search · flag     │
└─────────────────┬───────────────────────┘
                  │
┌─────────────────▼───────────────────────┐
│         imaplib + smtplib                │
│         (your IT provider)               │
└─────────────────────────────────────────┘
```

## Agent structure

mail_agent/
├── main.py           # entry point — CLI or daemon
├── agent.py          # Claude tool loop
├── mail_tools.py     # imaplib + smtplib wrappers
├── config.py         # credentials, settings
└── .env              # secrets (never commit)

## Usage

```bash
# called manually
python main.py cli "Summarize my unread emails"
python main.py cli "Reply to the email from boss@example.com saying I'll be there at 10"

# daemon mode — reacts to incoming mail
python main.py watch

# cron — periodic check (simpler than IDLE)
# */15 * * * * cd /path/to/mail_agent && python main.py cli "Process any unread emails"
```

## Next steps worth thinking about

State/memory — should the agent remember past conversations per contact?
Guardrails — whitelist senders it can auto-reply to, blacklist actions in auto mode
Logging — every send action should be logged with timestamp and content
OAuth2 — if your IT provider blocks basic auth (common with M365), you'll need a token flow
