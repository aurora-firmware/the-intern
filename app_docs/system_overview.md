# Intern — system overview

**Version:** 0.2 (architecture + roadmap)
**Platform:** macOS (Apple Silicon) / Linux
**Runtime:** OpenClaw gateway process
**Status:** Architecture draft

## Table of Contents

- [Purpose](#purpose)
- [Design principles](#design-principles)
- [Architecture layers](#architecture-layers)
  - [1. Interface layer](#1-interface-layer)
  - [2. Security layer](#2-security-layer)
  - [3. Orchestration layer](#3-orchestration-layer)
  - [4. AI model router](#4-ai-model-router)
- [Project layout](#project-layout)
- [Features](#features)
- [Roadmap](#roadmap)
- [OS setup checklist](#os-setup-checklist)
- [Security oversight summary](#security-oversight-summary)
- [Migration paths and future architecture](#migration-paths-and-future-architecture)
- [Future development roadmap](#future-development-roadmap)

-----

## Purpose

The Intern is a suite of configurations, account settings, permission constraints, and AI agents for completing office tasks. It is a locally-hosted AI agent that interacts with an office environment on behalf of a user — reading and sending email, managing calendar events, handling messaging channels, searching documents, and managing social media accounts. It operates with strict access controls, full auditability, and a security posture where sensitive data never leaves the local machine.

-----

## Design principles

- **Security is deterministic, not AI-driven.** Access control, data classification, and routing policy are enforced by static rules configured by a Sys Admin, never decided by an AI model.
  > *MVP compromise:* Runtime action policy (what the agent may do autonomously) is not yet encoded in a config file. Outbound actions requiring confirmation (email send, reply) are gated by an in-conversation confirmation prompt to the user rather than a policy rule in `openclaw.json`. A structured `action_policy` block is a planned upgrade.
- **Local by default.** All secrets, documents, logs, and models run on-device. Cloud API calls are opt-in per task and blocked entirely for sensitive data.
  > *MVP note:* The Researcher agent sends query data to the Anthropic API. This is opt-in, scoped to research tasks only, and never receives email content or local documents directly.
- **Native OS process first.** v0.1 runs directly on macOS or Linux with no container layer. This simplifies development, debugging, and access to OS-native APIs (Keychain, EventKit, Messages). Container isolation is a planned v0.2 upgrade.
  > *MVP compromise:* The Intern runs inside the OpenClaw gateway process rather than as a standalone Python process. Direct OS-native API access (Keychain, EventKit) is deferred — secrets are managed via environment variables and an `email.env` file for now.
- **Policy-driven execution.** Outbound actions are governed entirely by Sys Admin configuration. There is no runtime human approval step — what is permitted is defined in config before the system runs.
  > *MVP:* Enforced at three deterministic levels in `openclaw.json`: (1) **channel access** — `allowFrom` and `dmPolicy` control who can reach each agent; (2) **tool restrictions** — `tools.allow`/`tools.deny` per agent lock down what each agent can execute (the Researcher is restricted to `web_search` and `web_fetch` only; the PA cannot run `exec`, `write`, or `browser` tools); (3) **skill restrictions** — `agents.list[].skills` limits which workspace skills each agent can invoke (the PA is restricted to `business-email` only). Autonomous outbound email send/reply is still gated by an in-conversation confirmation prompt — a structured `action_policy` block replacing this is a planned upgrade.
- **Swappable models.** AI model selection is driven by config. Changing provider or model requires no code changes.
- **Process isolation as the v0.1 security boundary.** The security boundary is the OS user account. The Intern runs as a dedicated low-privilege user (`intern-svc`) with only the filesystem permissions it explicitly needs.
- **Modular design for reusability.** Components are kept decoupled so that individual pieces can be replaced or reused without rewriting unrelated parts.
  > *MVP note:* The email SKILL pattern (business logic in `email-cli.py`, framework registration in `SKILL.md`) keeps the Python script decoupled from the OpenClaw API. Changing the orchestration framework requires only rewriting `SKILL.md`, not the script.

-----

## Architecture layers

### 1. Interface layer

Entry points into the Intern. All user-facing channels are provided natively by OpenClaw; the Intern adds only the workspace configuration to route them to the correct agent.

|Channel  |Technology                     |Notes                                                                                                                                        |
|---------|-------------------------------|---------------------------------------------------------------------------------------------------------------------------------------------|
|Telegram |OpenClaw native channel        |Primary interactive channel. Access restricted to `allowFrom` user IDs in `openclaw.json`. `dmPolicy: allowlist`.                           |
|Email    |IMAP (read/poll) / SMTP (send) |Not a built-in OpenClaw channel. Implemented as a workspace SKILL: `email-cli.py` script + `SKILL.md` instruction file. Inbound email notification method is to be determined. Sender allowlist enforced at `email.env` config level.|

-----

### 2. Security layer

Enforced through a combination of OS-level isolation, Sys Admin configuration, and OpenClaw's built-in channel access controls. All controls are deterministic — no ML involvement.

#### 2a. OS user isolation

The Intern (OpenClaw gateway process) runs as a dedicated OS user (`intern-svc`) with minimal permissions:

- Read access to the documents folder only
- Read/write access only to `~intern-svc/data/` and `~intern-svc/.openclaw/`
- No sudo or admin privileges
- macOS: only the specific entitlements required granted via System Preferences, scoped to the OpenClaw binary

#### 2b. Sys Admin config (`~/.openclaw/openclaw.json`)

A single JSON5 file, version-controlled, `chmod 600`, owned by `intern-svc`. This is the primary Sys Admin configuration surface. It controls channel access, deterministic agent routing via bindings, per-agent tool and skill restrictions, model assignments, and logging hooks.

```json
{
  "channels": {
    "telegram": {
      "token": "${TELEGRAM_BOT_TOKEN}",
      "dmPolicy": "allowlist",
      "allowFrom": [123456789]
    }
  },
  "agents": {
    "defaults": {
      "model": "ollama/gemma3",
      "workspace": "~intern-svc/the-intern"
    },
    "list": [
      {
        "id": "personal-assistant",
        "model": "ollama/gemma3",
        "skills": ["business-email"],
        "tools": {
          "deny": ["exec", "write", "edit", "apply_patch", "browser"]
        }
      },
      {
        "id": "researcher",
        "model": "anthropic/claude-sonnet-4-6",
        "skills": [],
        "tools": {
          "allow": ["web_search", "web_fetch"],
          "deny": ["exec", "write", "edit", "apply_patch"]
        }
      }
    ]
  },
  "bindings": [
    {
      "agentId": "personal-assistant",
      "match": { "channel": "telegram", "accountId": "*" }
    }
  ],
  "hooks": {
    "internal": {
      "enabled": true,
      "entries": {
        "command-logger": { "enabled": true },
        "session-memory":  { "enabled": true }
      }
    }
  }
}
```

Config is owned by `intern-svc`. OpenClaw hot-reloads on file change. Monitor the modification timestamp — an unexpected write should be treated as a security event.

#### 2c. Secrets management

API keys and tokens are referenced in `openclaw.json` using `${VAR_NAME}` syntax. OpenClaw resolves these from the process environment, a `.env` file in the working directory, or `~/.openclaw/.env`. They are never written into the config file itself.

Email credentials are stored in `email.env` alongside the email SKILL script, never committed to version control:

```bash
EMAIL_IMAP_HOST=mail.yourcompany.com
EMAIL_IMAP_PORT=993
EMAIL_SMTP_HOST=mail.yourcompany.com
EMAIL_SMTP_PORT=587
EMAIL_USER=you@yourcompany.com
EMAIL_PASS=your-app-password
EMAIL_FROM=Your Name <you@yourcompany.com>
EMAIL_ALLOW_FROM=boss@example.com,client@example.com
```

> *Future upgrade:* Migrate API keys and the email password to macOS Keychain / Linux SecretService via `keyring`, replacing the `email.env` file and environment variables.

#### 2d. Channel access control

**Telegram:** `dmPolicy: allowlist` + `allowFrom: [user_id]` in `openclaw.json`. Only the listed numeric user IDs can reach the agent. All other messages are silently dropped by OpenClaw before the agent sees them.

**Email:** Inbound email is filtered at the `email-cli.py` level. The `EMAIL_ALLOW_FROM` variable in `email.env` defines an allowlist of sender addresses. The script discards messages from unlisted senders before returning results to the agent.

**Agent routing:** The `bindings` array in `openclaw.json` deterministically maps channels and accounts to specific agents. Bindings are matched by specificity then config order — no runtime decision is involved. See §2e for the complementary tool and skill restrictions that govern what each agent can do once routed.

#### 2e. Agent tool and skill restrictions

OpenClaw enforces tool and skill availability per agent through config — no custom code required. Restrictions are additive: later layers can only narrow further, never re-enable something denied earlier.

**Tool restrictions** (`tools.allow` / `tools.deny` per agent):

|Agent               |Allowed tools              |Denied tools                                   |
|--------------------|---------------------------|-----------------------------------------------|
|Personal Assistant  |read, shell (email script) |`exec`, `write`, `edit`, `apply_patch`, `browser`|
|Researcher          |`web_search`, `web_fetch`  |`exec`, `write`, `edit`, `apply_patch`         |

The Researcher can fetch web content but cannot write files, edit code, or execute arbitrary commands. The PA cannot open a browser or make arbitrary file edits — its only outbound action path is via `email-cli.py` invoked through the SKILL mechanism.

**Skill restrictions** (`agents.list[].skills`):

When `skills` is set on an agent, that becomes its complete and final skill set — it cannot invoke any skill not listed.

|Agent               |Skills                |
|--------------------|----------------------|
|Personal Assistant  |`["business-email"]`  |
|Researcher          |`[]` (none)           |

The Researcher has no skill access at all; it works exclusively through its web tools. The PA can only invoke the email SKILL — it cannot pick up skills added to the workspace for other agents.

#### 2f. Audit log

OpenClaw's built-in logging hooks provide three layers of activity logging with no custom code:

|Layer               |Location                                              |What is captured                                           |
|--------------------|------------------------------------------------------|-----------------------------------------------------------|
|Session transcripts |`~/.openclaw/agents/<id>/sessions/*.jsonl`            |Full conversation: every message, tool call, tool result   |
|Command audit log   |`~/.openclaw/logs/commands.log`                       |`/new`, `/reset`, `/stop` — timestamp, session, channel, sender|
|Session summaries   |`~intern-svc/the-intern/memory/YYYY-MM-DD-slug.md`    |LLM-generated summary written at `/new` or `/reset`        |

> *Future upgrade:* Supplement with a custom SQLite audit log (`audit.db`, WAL mode, INSERT-only) for structured querying and Admin UI integration.

-----

### 3. Orchestration layer

OpenClaw's gateway process handles channel routing and agent lifecycle. No custom Python gateway or RPC bridge is required. Channel bindings in `openclaw.json` route each incoming message to the correct agent.

Two agents are defined. Routing to them is **deterministic**: the `bindings` array in `openclaw.json` matches incoming messages by channel and account specificity. The Researcher has no binding and is only reachable as a subagent — no channel message can reach it directly.

- **Personal Assistant** — handles all Telegram conversations and email tasks. Runs on Gemma3 (Ollama, local). Tools restricted: no exec, write, edit, browser, or apply_patch. Skills restricted to `business-email` only. Spawns the Researcher as a subagent for research tasks.
- **Researcher** — web search and document lookup specialist. Runs on Claude (Anthropic API). Tools restricted to `web_search` and `web_fetch` — cannot write files, execute code, or use any workspace skill. No channel binding; never receives raw user messages.

#### Message flow — Telegram

```
Telegram message
  │
  ▼
OpenClaw Gateway (allowFrom check → binding match)
  │  dmPolicy=allowlist, match: {channel=telegram, accountId=*} → agentId=personal-assistant
  ▼
Personal Assistant (Ollama / Gemma3)
  │  if email task    → reads business-email SKILL → runs email-cli.py
  │  if research task → spawns Researcher subagent
  ▼
Researcher (Claude API)  ← only for research tasks
  │  web_search + web_fetch tools
  ▼
Result returned to Personal Assistant → reply sent on Telegram
```

#### Message flow — inbound email

How and when inbound email is surfaced to the agent is to be determined.

```
User asks "any new emails?" via Telegram
  │
  ▼
PA reads business-email SKILL → runs:
  email-cli.py list --limit 10  (filtered to EMAIL_ALLOW_FROM senders)
  │
  ▼
Summarises unread messages → replies on Telegram
```

#### Action confirmation

Tool and skill restrictions are the **primary** deterministic guard: the PA cannot execute arbitrary code, open a browser, or invoke skills other than `business-email`, regardless of what the model decides to do. The Researcher cannot write or send anything at all.

For the one remaining outbound action — email send/reply — the PA's system description instructs it to confirm the recipient and subject with the user before proceeding unless explicitly told to go ahead. This in-conversation confirmation is a secondary, user-experience-level guard while a formal `action_policy` config block is pending.

#### Context and memory

Session summaries are written to `~intern-svc/the-intern/memory/` at the end of each session by the `session-memory` hook. These are loaded into agent context on the next session start alongside `AGENTS.md`, `SOUL.md`, and `USER.md`.

Each agent is given a **focused context** (cases, key client events, relevant documents) and deliberately excluded from data irrelevant to its task — acting as blinders so the agent is not distracted by noise.

-----

### 4. AI model router

Model assignment is per-agent in `openclaw.json`. No separate routing config file or LiteLLM proxy is required for the MVP.

|Agent               |Provider  |Model                  |Reason                                                              |
|--------------------|----------|-----------------------|--------------------------------------------------------------------|
|Personal Assistant  |Ollama    |`gemma3`               |Local, private, fast, zero API cost; sufficient for email summaries and conversation|
|Researcher          |Anthropic |`claude-sonnet-4-6`    |Stronger reasoning and tool use required for web research           |

Sensitive data (email content, local documents) never reaches the Researcher or the Anthropic API — the PA handles all email operations locally and passes only the research question to the subagent.

#### Local model runtime

Ollama runs natively on Apple Silicon (Metal) and Linux (CPU or CUDA), installed independently.

|Model    |Use                                                           |
|---------|--------------------------------------------------------------|
|`gemma3` |Personal Assistant — email summaries, reminders, conversation |

-----

## Project layout

```
~intern-svc/
├── .openclaw/
│   ├── openclaw.json        # Sys Admin config  [chmod 600]
│   └── .env                 # API key env vars  [chmod 600, not committed]
│
└── the-intern/              # OpenClaw workspace
    ├── AGENTS.md            # Agent operating instructions — loaded every session
    ├── SOUL.md              # Agent persona and tone — loaded every session
    ├── USER.md              # User identity and preferences — loaded every session
    ├── skills/
    │   └── email/
    │       ├── SKILL.md     # Agent reads this on demand
    │       └── bin/
    │           ├── email-cli.py   # IMAP/SMTP wrapper (Python stdlib only)
    │           └── email.env      # Email credentials  [chmod 600, not committed]
    └── memory/              # session-memory hook output
```

-----

## Features

- **Email:** Read, summarise, draft replies, and suggest responses to incoming messages. Sender allowlist enforced at config level.
- **Search:** Find information across a heterogeneous document base — local files, Dropbox, web, and remote databases.
- **Consultant:** Provide personalised advice based on trained domain expertise (legal, business, client context).
- **Account manager:** Manage social media profiles — respond to messages, draft and publish posts.
- **Translation:** Translate documents in legal and business contexts across Spanish, English, and Czech.
- **Communication channels:** Telegram and email (MVP); additional channels in future iterations.
- The bot finds information and relevant documents in Dropbox or local filesystem; paths and locations are user-configurable.
- The user can switch between AI agent models and choose between cloud API agents and local models alike.
- The user can receive requests that are directly piped to the AI agent provider API without previous preprocessing.

-----

## Roadmap

1. Initial version and Minimum Viable Product (MVP):
  - Communication via Telegram with the Personal Assistant agent.
  - Local OS account (`intern-svc`) with system-level restrictions.
  - Email: read, search, send, and reply via IMAP/SMTP SKILL; sender allowlist at config level.
  - Research delegation to a Researcher subagent (Claude API, web search).
  - Session logging via OpenClaw built-in hooks.

-----

## OS setup checklist

1. Create dedicated OS user: `sudo useradd -m intern-svc`
1. Set filesystem permissions: `intern-svc` read-only on documents folder, read/write only on `~intern-svc/data/` and `~intern-svc/.openclaw/`
1. Install Ollama and pull the model: `ollama pull gemma3 && ollama serve`
1. Create a Telegram bot via `@BotFather`; note the bot token
1. Find your Telegram user ID via `@userinfobot`; note the numeric ID
1. Create `~intern-svc/.openclaw/.env` with `TELEGRAM_BOT_TOKEN` and `ANTHROPIC_API_KEY`; `chmod 600`
1. Create `~intern-svc/.openclaw/openclaw.json` with the config above; `chmod 600 && chown intern-svc`
1. Create the workspace structure and install `email-cli.py` and `SKILL.md`
1. Create `email.env` with IMAP/SMTP credentials and `EMAIL_ALLOW_FROM` allowlist; `chmod 600`
1. Start the gateway as `intern-svc`: `openclaw gateway run`
1. Send a test message via Telegram; verify the PA replies

-----

## Security oversight summary

|Risk                                               |Mitigation                                                                                       |
|---------------------------------------------------|-------------------------------------------------------------------------------------------------|
|Intern process has broad OS permissions            |Run as dedicated `intern-svc` user with minimal filesystem grants                               |
|Unauthorised Telegram access                       |`dmPolicy: allowlist` + `allowFrom` in `openclaw.json` — only listed user IDs can reach agents  |
|Unwanted email senders reaching the agent          |`EMAIL_ALLOW_FROM` allowlist in `email.env`; script discards messages from unlisted senders      |
|Agent executes arbitrary code or writes files      |Per-agent `tools.deny` in `openclaw.json` — PA and Researcher both deny exec/write/edit/apply_patch|
|Researcher invokes email or local skills           |`agents.list[].skills: []` — Researcher has no skill access; PA limited to `business-email` only |
|Agent sends email without user knowledge           |PA instructed to confirm recipient and subject before sending unless explicitly told to proceed   |
|Researcher receives sensitive local data           |PA handles all email/document operations locally; only the research question is passed to Claude |
|API keys in config file                            |Keys referenced via `${VAR_NAME}` — resolved from `~/.openclaw/.env` (`chmod 600`, not committed)|
|Email credentials exposed                          |Stored in `email.env` (`chmod 600`, not committed); app-specific password only                  |
|`openclaw.json` readable by other users            |`chmod 600`, owned by `intern-svc`                                                               |
|`openclaw.json` modified unexpectedly              |Monitor modification timestamp; treat unexpected writes as a security event                      |
|Session transcripts contain sensitive data         |Stored in `~intern-svc/.openclaw/`; protected by `intern-svc` OS user permissions               |

-----

## Migration paths and future architecture

### OpenClaw → Pi SDK direct

**When:** When custom action policy enforcement, a full data classifier, or a structured audit log are needed and cannot be cleanly hooked into OpenClaw's plugin lifecycle.

**What changes:**

|Component         |v0.1 (OpenClaw)                  |v0.2 (Pi SDK direct)               |
|------------------|---------------------------------|-----------------------------------|
|Interface layer   |OpenClaw gateway + channel config|Pi extensions (`registerTool`)     |
|Orchestration     |OpenClaw route resolver          |Python spawns Pi directly via RPC  |
|Action policy     |In-conversation confirmation     |`action_policy.py` + config block  |
|Security layer    |OS user + `openclaw.json`        |OS user + `config.yaml` (Python)   |
|Email SKILL       |`email-cli.py` + `SKILL.md`      |`email-cli.py` unchanged (reuse)   |
|AI router         |Per-agent in `openclaw.json`     |`routing.yaml` + Python gateway    |

**What survives unchanged:** OS user isolation, `email-cli.py` business logic, session memory markdown files.

**Key discipline to maintain in v0.1:** `email-cli.py` must never import from OpenClaw APIs. The script is pure Python stdlib. Only `SKILL.md` touches the framework. This makes migration a rewrite of `SKILL.md` only.

-----

### Native process → Pi in a container (sandbox isolation)

**When:** When the risk profile of the agent process having read/write access to the host filesystem is unacceptable, or when a stricter audit boundary is required.

In this model the Python security process remains on the host unchanged. The only change is how the orchestrator is spawned — from a direct process to a Docker container with `--network none`, `--read-only`, and `--cap-drop ALL`. All LLM API calls and connector calls travel back through the pipe to the Python host.

**Design discipline to maintain in v0.1:** the gateway must never pass config values, file paths, or secrets into agent prompts or tool results. Keep the boundary clean from the start.

-----

## Future development roadmap

### Near term (v0.2 / v0.3)

**Email push notifications.** Add an IMAP IDLE watcher (persistent connection) or polling cron job that proactively alerts the PA of new email from allowlisted senders. The PA sends a summary via Telegram.

**Calendar integration.** New SKILL following the same pattern as email: a CalDAV CLI script + `SKILL.md`. Read and write calendar events without adding framework dependencies.

**`launchd` / `systemd` service.** Run the Intern as a background daemon that starts on boot as `intern-svc`. Includes log rotation and a health-check endpoint.

**Formal action policy.** Add an `action_policy` config block (in `openclaw.json` or a companion file) that encodes what the agent may do autonomously, replacing the in-conversation confirmation prompt.

-----

### Medium term (v0.4 / v0.5)

**Document ingestion pipeline.** A folder watcher (`watchdog`) that monitors a designated documents directory, extracts text, generates AI summaries and embeddings, and registers each document in an index with the correct sensitivity tag.

**OpenClaw → Pi SDK migration.** Replace the OpenClaw gateway with direct Pi SDK usage (`createAgentSession`). Rewrite agent bindings and channel routing. `email-cli.py` and workspace skills survive unchanged.

**Structured audit log.** Add a SQLite audit log (`audit.db`, WAL mode, INSERT-only) as a supplement to OpenClaw's JSONL transcripts, enabling structured queries and Admin UI integration.

**Secrets migration to Keychain.** Move API keys and the email password from `.env` files to macOS Keychain / Linux SecretService via `keyring`.

-----

### Longer term (v1.0+)

**Cross-session memory.** Persistent memory across sessions using a vector store (ChromaDB or Qdrant, local). Fed into agent context on session start via `BOOTSTRAP.md`.

**Multi-user support.** Per-user context isolation — separate agent sessions, separate document index partitions, per-user action policy. Requires the containerised orchestrator model.

**Proactive agent behaviour.** Allow the Intern to initiate actions on a schedule (daily briefing, meeting preparation) rather than only responding to inbound messages.

-----

*Document maintained alongside the codebase. Update this file when architecture decisions change.*
