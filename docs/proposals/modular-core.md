# Proposal: modular core

*Status: proposal for discussion, not a spec. Written 2026-10-17 from a brainstorming session. It builds on
[S-001](../ai-team/specs/S-001-agent-roles-and-conversations.md) and
[S-002](../ai-team/specs/S-002-daemon-and-host-runtime.md) and only lists what it adds or changes.*

## Goal

A personal "open Claude": an always-on assistant with a minimal working core and a clear way to grow it. New
abilities are added as self-contained folders (instructions, skills, documents, permissions), not as code changes to
the core.

## Principle 0

The working philosophy in [AGENTS.md](../../AGENTS.md#working-philosophy-cornerstone): deterministic code for what is
repeatable and exact, the LLM for what is contextual and varied, no purism. Every module below follows it.

## The five modules

Each module is a boundary: nothing outside it depends on what is inside.

| # | Module | Job | Already covered by |
|---|---|---|---|
| 1 | **Brain** (model connector) | One way to call any model; per-role model choice | S-002 Model runtime (pi-ai via pi-durable) |
| 2 | **I/O** (communication) | Receive from channels, reply to the channel the request came from | S-002 service layer; `submit({requestId, whenBusy})` |
| 3 | **Capabilities** (roles, skills, tools, permissions) | What each role knows and is allowed to do | S-001 roles, seats, workspaces, invocation |
| 4 | **Archive** (memory) + archivist | Long-term memory with metadata, maintained over time | Nothing yet |
| 5 | **Logs** + steward | Audit, alarms, periodic review, health checks | Audit JSONL (feature review: keep) |

### 1. Brain

pi-ai already is the multi-provider connector, so nothing is built here beyond S-002. The proposal is only the rule:
no code outside the model runtime imports a provider SDK. The first setup is one provider (Anthropic or an
OpenAI-compatible endpoint); every role runs on it "with a different hat", and a role can move up or down a model,
or to a local one, through its default model (S-001 R-3).

### 2. I/O

- **Inbound envelope.** Every adapter produces the same shape: `channel`, `thread_id`, `sender`, `received_at`,
  `content`, `attachments`, and a **reply address**. Known facts are set by code, never by a model.
- **Outbound.** `reply(replyAddress, content)`. The adapter that received the request sends the answer. S-001 covers
  reports between conversations; this covers the answer that leaves the system.
- **First adapter: Telegram.** A bot with long polling (`getUpdates`), so there is no inbound listener (fits the
  local-first scope). A deterministic allowlist of chat ids decides who is heard.
- **Email** is both an input and a capability. Split them:
  - *Ingress* (deterministic): a scheduled poll lists new messages since the last seen id and submits each one, with
    `thread_id` from `Message-ID`/`References`, to a new conversation seated with the email role.
  - *Capability*: the email role reads full messages and acts through himalaya (skill + `bash`; pi-durable has no MCP,
    see the feature review).
  - *Reply*: replying to an outside person is an **action of the email role**, not an automatic I/O output, because
    writing to third parties is high-risk (candidate for an `ask` approval). Answers to the user (Telegram, chat) go out
    automatically through I/O.

### 3. Capabilities

- **Role = folder.** A registry maps a role name to a folder, like a DNS:
  `role.md` (what it does and doesn't do), `skills/`, `docs/`, workspace files, and a **manifest**: default model,
  tools offered, network egress, which roles it may invoke, memory namespaces it reads and writes.
- **Invocation with a return shape.** S-001 R-8 invocation plus an optional schema the invoked agent must return
  (a structured tool call). The caller chain travels with the job ("I am the email role, working on X, I need Y").
- **Per-role limits enforced below the model.** S-001 runs every agent in one process and v1 is allow-all. For the
  internet role to mean anything:
  - only the internet role is offered a web tool (S-001 R-5 already gives each agent exactly its role's tools);
  - `bash` for every other role runs in a sandbox without open network (`bwrap`/`unshare -n` on Linux,
    `sandbox-exec` on macOS) or behind an egress proxy with a per-role allowlist (the email role needs its IMAP and
    SMTP hosts, not the open web);
  - the internet role gets as little private context as possible (queries are where data leaks), and returns typed
    fields, not free text (returned text is where injection travels).

### 4. Archive and archivist

pi-durable keeps transcripts, not memory. The proposal adds a memory store (pi-durable documents or a table in the
same SQLite database).

**Record:** `id`, `content`, `kind` (fact, preference, decision, episode…), `source` (channel, thread, conversation,
role), `trust` (user, internal, external), `tags`, `valid_from`, `valid_to`, `superseded_by`, `created_at`.

- **Write path (cheap, any role):** a `remember` tool appends a record. Code fills source, time and trust; the model
  supplies content, kind and topic tags.
- **Read path (deterministic):** a `recall(query, filters)` tool: full-text search, optionally embeddings, current
  records only unless `include_history` is set.
- **Archivist (scheduled role):** merges duplicates, adds topic tags, links related threads, and marks superseded
  facts. "I had a cat, I gave it away" sets `valid_to` and `superseded_by` on the old fact; nothing is deleted.
- **Provenance rule:** content from email or the web is stored as `trust: external` and never becomes an
  instruction.

Open: whether scheduled runs read memory (S-001 R-13 says fires keep no memory; recall from the archive is different
from continuing a conversation, and is probably compatible).

### 5. Logs and steward

- **Tripwires (code, immediate):** a burst of policy denials, a role trying to reach the network without permission,
  a crash loop.
- **Hourly review (LLM):** the last hour of audit log, compacted first by code (repeated lines grouped with counts),
  sent with a forced output: `{status: ok|warning|critical, findings: [{line, explanation}]}`.
- **Doctor (mostly code):** every registered role points to an existing folder with a valid manifest, schedules
  parse, invoked roles exist. A monthly LLM pass only for "do these schedules still make sense together".

## Mapping to the roles we talked about

| Role | In this proposal |
|---|---|
| Receptionist | The default role on the root conversation and on I/O entries (S-001 `bob`): answers simple things, delegates the rest |
| Internet | A core role, shipped and updated with the core; the only one with open web access |
| Archivist | A core scheduled role over module 4 |
| Doctor + log reviewer | One "steward" role over module 5 |
| Email, and anything else | Role folders added by the user |

## Points to agree with S-001

1. S-001 v1 has exactly two fixed roles; this proposal wants roles as folders in a registry.
2. S-001 excludes memory across scheduled runs; this proposal adds a separate memory store.
3. S-001 v1 is allow-all; the internet role needs per-role capabilities from the start.
4. Replies to external channels (Telegram, email) are not specified yet.
5. Typed return shapes for invocations.
