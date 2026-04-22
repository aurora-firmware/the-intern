# The Intern — OpenClaw Implementation Plan

## Table of Contents

- [Purpose](#purpose)
- [Target OpenClaw architecture](#target-openclaw-architecture)
- [Logical component mapping](#logical-component-mapping)
- [Capability inventory](#capability-inventory)
  - [Built into OpenClaw](#built-into-openclaw)
  - [Available through OpenClaw plugins or tools](#available-through-openclaw-plugins-or-tools)
  - [Custom work required](#custom-work-required)
- [Agents](#agents)
  - [Personal Assistant](#personal-assistant)
  - [Researcher](#researcher)
- [Core flows](#core-flows)
  - [Inbound Telegram message](#inbound-telegram-message)
  - [Checking email](#checking-email)
  - [Research delegation](#research-delegation)
- [Email integration](#email-integration)
- [OpenClaw configuration](#openclaw-configuration)
- [Logging and memory](#logging-and-memory)
- [Implementation sequence](#implementation-sequence)
- [Decisions and trade-offs](#decisions-and-trade-offs)
- [Open questions](#open-questions)

-----

## Purpose

This document maps the logical components in `app_docs/system_overview.md` to a concrete OpenClaw implementation.

Unlike the system overview, this file should mention specific OpenClaw features, existing plugins, built-in tools, and missing pieces that require custom work. The purpose is to keep the implementation honest: use OpenClaw where it already provides the required component, and write custom code only where the logical architecture has no built-in OpenClaw equivalent.

-----

## Target OpenClaw architecture

```text
+----------------+      +------------------+      +----------------------+
| Telegram user  |----->| OpenClaw gateway |----->| Channel binding      |
| External input |      | Channel adapter  |      | telegram -> PA       |
+-------^--------+      +------------------+      +----------+-----------+
        |                                                   |
        | reply                                             v
+-------+--------+                               +----------+-----------+
| Telegram reply |<------------------------------| Personal Assistant   |
| Response path  |                               | Primary agent        |
+----------------+                               +----+------------+----+
                                                    |            |
                                      email tools   |            | subagent task
                                                    v            v
                                           +--------+--+    +----+---------+
                                           | Himalaya  |    | Researcher   |
                                           | IMAP/SMTP |    | Subagent     |
                                           +-----+-----+    +----+---------+
                                                 |               |
                                                 v               v
                                           +-----+-----+    +----+---------+
                                           | Mailbox   |    | Web tools    |
                                           | Email     |    | search/fetch |
                                           +-----------+    +--------------+

                +------------------+     +------------------+
                | command-logger   |     | session-memory   |
                | Audit hook       |     | Memory hook      |
                +------------------+     +------------------+
```

-----

## Logical component mapping

| System overview component | OpenClaw mapping | Status |
|---------------------------|------------------|--------|
| External channel | Telegram channel | Built in |
| Interface adapter | OpenClaw gateway and channel adapter | Built in |
| Policy engine | Telegram allowlist, channel bindings, agent tool restrictions, agent plugin restrictions | Partly built in |
| Orchestrator | Gateway routing, agent lifecycle, subagent delegation | Built in |
| Context manager | Workspace bootstrap instructions, session context, `session-memory` hook | Built in / configured |
| Model router | Per-agent model and provider configuration | Built in |
| Primary agent | `personal-assistant` agent | Built in / configured |
| Specialist agent | `researcher` subagent | Built in / configured |
| Action executor | Himalaya email plugin, web tools, future custom skills/plugins | Plugin/tool based |
| Response writer | Telegram reply path through gateway | Built in |
| Audit trail | Session transcripts, `command-logger`, `session-memory` | Built in / hook based |

-----

## Capability inventory

### Built into OpenClaw

| Capability | OpenClaw feature | Notes |
|------------|------------------|-------|
| Telegram channel | Native channel | Primary input/output path. Use sender allowlist for access control. |
| Gateway routing | Channel bindings | Route all Telegram traffic to `personal-assistant`. |
| Agents | Agent definitions | Define `personal-assistant` and `researcher` as separate roles. |
| Subagents | Agent delegation | PA can call Researcher for bounded research tasks. |
| Model selection | Per-agent model config | Assign model/provider per role. |
| Web research | `web_search`, `web_fetch` tools | Expose only to Researcher. |
| Session transcripts | Built-in session logs | Full conversation and tool-call trace. |
| Command audit | `command-logger` hook | Records commands and lifecycle events. |
| Session summaries | `session-memory` hook | Writes summaries for later context. |

### Available through OpenClaw plugins or tools

| Capability | Tool or plugin | Notes |
|------------|----------------|-------|
| Email read/search/send/reply | Himalaya plugin | Existing OpenClaw email plugin using IMAP/SMTP. |
| Email credentials | Himalaya plugin config | Store as env-var references, not literal secrets in config. |
| Mailbox state changes | Himalaya tools | Sending, replying, marking read/unread are side-effecting actions. |
| Calendar support | CalDAV-style plugin or custom skill | Not part of the current baseline plan unless a suitable plugin exists. |
| Internal document search | OpenClaw tool/plugin or custom index | Needs confirmation against available OpenClaw plugins before implementation. |

### Custom work required

| Need | Why OpenClaw is not enough by itself | Likely implementation |
|------|--------------------------------------|-----------------------|
| Strong action confirmation policy | Prompt instructions are not a hard security boundary. | A `before_tool_call` hook or policy plugin for sensitive tools such as email send/reply. |
| Email push notifications | Himalaya handles mailbox access, but push behavior needs a trigger. | IMAP IDLE watcher, polling job, or OpenClaw hook that sends a channel notification. |
| Email sender allowlist beyond channel access | Telegram allowlist does not constrain mailbox senders. | Filter in a wrapper tool, plugin policy, or pre-processing layer before returning messages to the agent. |
| Structured data classification | OpenClaw config can restrict tools, but document/email sensitivity needs domain policy. | Metadata tags plus policy checks before context is forwarded to agents. |
| Retention policy for audit logs | OpenClaw can log, but retention and rotation are operational concerns. | Log rotation, archival, redaction, and deletion policy. |
| Token/cost accounting | Not covered by the baseline logging plan. | Hook on model output/tool events into a daily JSONL or metrics store. |
| Local document ingestion | Search needs indexing and sensitivity metadata. | Folder watcher, text extraction, embeddings/index, and access policy. |

-----

## Agents

### Personal Assistant

| Property | Value |
|----------|-------|
| Agent ID | `personal-assistant` |
| Role | Primary user-facing agent |
| Channel binding | Telegram channel |
| Model | Configured OpenClaw model, initially Claude Sonnet if using Anthropic |
| Plugins/tools | Himalaya email plugin; no web tools by default |
| Response path | Replies through the originating Telegram session |

Responsibilities:

- Handle direct user conversation.
- Read, search, summarize, send, and reply to email through Himalaya.
- Decide when a request should be delegated to Researcher.
- Keep user-visible responses concise and action-oriented.
- Avoid sending email or performing other side effects when required details are missing.

Restrictions:

- Should not receive unrestricted shell, filesystem write, browser, or code-editing tools.
- Should not perform web research directly if that is assigned to Researcher.
- Should not forward sensitive email or document contents to Researcher unless policy explicitly allows it.

### Researcher

| Property | Value |
|----------|-------|
| Agent ID | `researcher` |
| Role | Specialist subagent |
| Channel binding | None |
| Model | Configured OpenClaw model, initially Claude Sonnet if using Anthropic |
| Tools | `web_search`, `web_fetch` |
| Response path | Returns findings to Personal Assistant |

Responsibilities:

- Perform web search and page retrieval.
- Return structured findings with sources.
- Indicate confidence when source quality is weak or incomplete.

Restrictions:

- No direct Telegram binding.
- No email plugin.
- No write/edit/shell tools.
- No user-visible response path except through the PA.

-----

## Core flows

### Inbound Telegram message

```text
Telegram message
  |
  v
OpenClaw gateway
  |
  | sender allowlist + channel binding
  v
Personal Assistant
  |
  | direct answer, email tool call, or specialist delegation
  v
Telegram reply
```

### Checking email

```text
User asks about email
  |
  v
Personal Assistant
  |
  v
Himalaya plugin
  |
  | IMAP list/read/search
  v
Mailbox
  |
  v
Personal Assistant summarizes results
  |
  v
Telegram reply
```

Himalaya provides the email tool surface. Custom policy may still be needed for sender allowlists, sensitivity filters, and hard confirmation before send/reply actions.

### Research delegation

```text
User asks research question
  |
  v
Personal Assistant
  |
  | bounded subtask
  v
Researcher
  |
  | web_search / web_fetch
  v
Web sources
  |
  v
Researcher findings
  |
  v
Personal Assistant final answer
```

The Researcher should receive the question and relevant non-sensitive context, not the full user session or mailbox contents.

-----

## Email integration

Email should use the Himalaya plugin if it is available in the target OpenClaw installation.

Expected Himalaya capabilities:

| Tool capability | Purpose |
|-----------------|---------|
| List inbox | Fetch recent messages and read/unread state. |
| Read message | Retrieve a specific message body. |
| Search messages | Search by sender, recipient, subject, date, or free text. |
| Send message | Send a new outbound email. |
| Reply message | Reply while preserving thread headers. |
| Flag message | Mark messages read/unread or otherwise update mailbox state. |

Configuration requirements:

- IMAP host and port.
- SMTP host and port.
- Username.
- Password or OAuth token, referenced through an environment variable.
- From address.

Implementation boundary:

- Himalaya is the action executor for email.
- The PA is the only agent that should receive the email tool surface.
- Confirmation and sender filtering should not rely only on the PA prompt if they are security requirements.

-----

## OpenClaw configuration

The OpenClaw config should wire the logical components explicitly:

| Section | Required content |
|---------|------------------|
| Profiles/providers | API keys or local provider configuration via environment variables. |
| Models | Named models available for agent assignment. |
| Channels | Telegram channel token and sender allowlist. |
| Bindings | Route Telegram messages to `personal-assistant`. |
| Agents | `personal-assistant` and `researcher` role definitions. |
| Plugins | Himalaya plugin configured only for PA. |
| Tools | Researcher gets `web_search` and `web_fetch`; PA gets email tools only. |
| Hooks | Enable `command-logger` and `session-memory`. |
| Workspace | Bootstrap/context files and memory directory. |

Minimum intended shape:

```text
profiles/providers
models
channels
  telegram
bindings
  telegram -> personal-assistant
agents
  personal-assistant
    model
    telegram binding
    himalaya plugin
    restricted tools
  researcher
    model
    no channel binding
    web_search/web_fetch only
plugins
  himalaya
hooks
  command-logger
  session-memory
workspace
  bootstrap/context
  memory
```

-----

## Logging and memory

| Layer | OpenClaw feature | Captures |
|-------|------------------|----------|
| Session transcripts | Built-in session logs | Messages, tool calls, tool results. |
| Command audit | `command-logger` hook | User commands and lifecycle events. |
| Session memory | `session-memory` hook | Summaries written for future context. |

The logging plan covers traceability, but it does not automatically solve retention, redaction, or access-control policy for logs. Those are operational/custom requirements.

-----

## Implementation sequence

1. Configure the Telegram channel and sender allowlist.
2. Define `personal-assistant` and bind Telegram traffic to it.
3. Configure the model provider and assign a model to PA.
4. Enable session transcripts, `command-logger`, and `session-memory`.
5. Configure Himalaya and expose email tools only to PA.
6. Test email read/search before enabling send/reply.
7. Add hard confirmation policy for send/reply if required.
8. Define `researcher` with no channel binding.
9. Expose only `web_search` and `web_fetch` to Researcher.
10. Test PA-to-Researcher delegation and verify Researcher cannot access email tools.
11. Review audit logs for each flow: Telegram request, email tool call, research delegation, and response.
12. Add custom pieces only where the capability inventory marks OpenClaw as insufficient.

-----

## Decisions and trade-offs

### Why two agents?

- The PA needs direct channel access and email tools.
- The Researcher needs web tools but should not see email tools or direct user channels.
- Separate agents make tool restrictions easier to reason about.
- A specialist role can be replaced or tuned without changing the user-facing PA.

### Why Himalaya for email?

| Approach | Benefit | Cost |
|----------|---------|------|
| Himalaya plugin | Uses existing OpenClaw email integration and typed tools. | Limited by plugin behavior and available policy hooks. |
| Custom email wrapper | Full control over sender filtering, confirmations, and logging shape. | More code, more edge cases, more maintenance. |

Use Himalaya first for mailbox operations. Add a custom wrapper or policy hook only when a security or workflow requirement cannot be enforced through OpenClaw configuration.

### Where prompts are not enough

Prompts can describe behavior, but they should not be treated as hard enforcement for:

- Sender allowlists.
- Sensitive data forwarding.
- Email send/reply confirmation.
- Tool access boundaries.
- Log retention and redaction.

Those belong in OpenClaw config, tool restrictions, hooks, plugins, or external policy code.

-----

## Open questions

- Does the target OpenClaw version include the Himalaya plugin and the exact email tools listed here?
- Which OpenClaw hook should enforce hard confirmation before email send/reply?
- Can sender filtering for inbound email be implemented inside Himalaya config, or does it require a wrapper?
- Which provider/model should be assigned to PA and Researcher for the first working setup?
- What is the minimum audit retention period?
- Should email push notifications be in scope, or should email remain pull-only until the core flows work?
