# Intern — system overview

**Version:** 0.1 (initial design)
**Platform:** macOS (Apple Silicon) / Linux
**Runtime:** Native Python process — no container
**Status:** Architecture draft

---

## Purpose

The Intern is a locally-hosted AI agent that can interact with an office environment on behalf of a user — reading and sending email, managing calendar events, and handling messaging channels. It is designed to operate with strict access controls, full auditability, and a security posture where sensitive data never leaves the local machine.

---

## Design principles

- **Security is deterministic, not AI-driven.** Access control, data classification, and routing policy are enforced by static rules configured by a Sys Admin, never decided by the AI model.
- **Local by default.** All secrets, documents, logs, and models run on-device. Cloud API calls are opt-in per task and blocked entirely for sensitive data.
- **Native OS process.** The application runs directly on macOS or Linux with no container layer. This simplifies development, debugging, and access to OS-native APIs (Keychain, EventKit, Messages).
- **Human in the loop.** Any outbound action (sending an email, replying to a message) requires explicit approval before execution.
- **Swappable models.** AI model selection is driven by a YAML routing config. Changing provider or model requires no code changes.
- **Process isolation as the security boundary.** Without a container, the security boundary is the OS user account. The Intern runs as a dedicated low-privilege user with only the filesystem permissions it explicitly needs.

---

## Architecture layers

### 1. Interface layer

Entry points into the Intern. All channels funnel into the same internal pipeline — security and orchestration logic is written once.

| Channel | Technology | Notes |
|---|---|---|
| iMessage | AppleScript / `imessage-cli` | macOS only — direct native access |
| WhatsApp | WhatsApp Business API | Sends data to Meta — sensitive threads blocked at classifier |
| Email | IMAP (read) / SMTP (send) | Credentials stored in macOS Keychain or Linux Secret Service |
| Admin UI | FastAPI + minimal HTML | Bound to `127.0.0.1` only — config, logs, and approval gates |

---

### 2. Security layer

Enforced before any AI model call. All components are deterministic rule engines — no ML involvement.

#### 2a. OS user isolation

The Intern runs as a dedicated OS user (`intern-svc`) with minimal permissions:

- Read access to the documents folder only (not the entire home directory)
- Read/write access only to `~intern-svc/data/`
- No sudo or admin privileges
- macOS: only the specific entitlements required (Mail, Calendar, Messages) granted via System Preferences — scoped to the specific Python binary, not the developer account

This is the primary security boundary in the no-container model. Configuring this correctly is the most important step before running the application.

#### 2b. Sys Admin config (`config.yaml`)

A single YAML file, version-controlled, readable only by `intern-svc` and the admin account (`chmod 600`). Defines:

- User accounts and their permitted scopes (e.g. `read:email`, `send:email`, `calendar:write`)
- API key registry — maps key → identity → scope list
- Sensitivity rules — regex/keyword patterns that tag data as `confidential` or `restricted`
- Routing policy — which sensitivity tags force local-only model routing

```yaml
users:
  alice:
    scopes: [read:email, calendar:read]
  admin:
    scopes: ["*"]

sensitivity_rules:
  - pattern: "\\bIBAN\\b"
    tag: restricted
  - pattern: "\\b[A-Z][a-z]+ [A-Z][a-z]+\\b"   # named contacts
    tag: confidential
    match_field: body

routing_policy:
  restricted: local_only
  confidential: local_only
```

#### 2c. Secrets management

**macOS:** Secrets (email passwords, API keys, WhatsApp tokens) are stored in the macOS Keychain and accessed at runtime via the `keyring` Python library. Secrets are read into memory on demand and never written to disk or environment variables.

**Linux:** The `SecretService` API (GNOME Keyring or KWallet) is supported by `keyring` with the same interface. On headless Linux servers, `keyrings.alt` with an encrypted file backend is the fallback — the encryption key is derived from the `intern-svc` user password.

```python
import keyring

# Read at runtime — never stored in code or config files
password = keyring.get_password("intern", "email_account")
api_key  = keyring.get_password("intern", "anthropic_api_key")
```

No `.env` files. No environment variables for secrets. No plaintext credentials in `config.yaml`.

> **Security note:** On macOS, the first time the Intern accesses each Keychain item, the OS will prompt the user for permission. After granting, subsequent accesses by the same binary path are silent. If the binary path changes (e.g. after a Python env update), macOS will prompt again — this is expected and correct behaviour.

#### 2d. ACL check

Every request is validated against the caller's declared scope before its payload is read. A caller with `read:email` scope attempting `send:email` receives a 403 and no further processing occurs. This is a static lookup — not AI logic.

#### 2e. Data classifier

The request payload is scanned against the sensitivity rules defined in `config.yaml`. Matches are tagged in memory. The original payload is not modified. The classifier runs locally, always, before any model call.

#### 2f. Audit log

Every request — including rejected ones — is appended to a local, append-only SQLite log at `~intern-svc/data/audit.db`. Written in WAL mode; the application layer permits only `INSERT` — no `UPDATE` or `DELETE` statements on the audit table.

| Field | Content |
|---|---|
| `timestamp` | ISO 8601 |
| `caller_id` | Identity from API key |
| `action` | Requested operation |
| `sensitivity_tags` | Tags found by classifier |
| `model_used` | Which model handled the request |
| `approval_required` | Whether human gate was triggered |
| `approved_by` | User who approved (if applicable) |
| `outcome` | `allowed`, `rejected`, `pending` |

> **Security note:** Error responses must never include payload data or classifier output. A `400` that echoes back a matched pattern leaks the sensitivity classification to the caller.

---

### 3. Orchestration layer

The orchestrator is `claude-sonnet-4` running with Anthropic's native tool use. Each capability (email read, email send, calendar lookup, doc search) is a Python function registered as an MCP tool. The orchestrator decomposes a task into subtasks and calls tools sequentially.

There is no external framework (no LangGraph, no AutoGen) in v0.1 — just the model + tools pattern. This keeps the system inspectable and debuggable from day one.

#### Approval gate

Any tool that produces an outbound action (`send_email`, `send_whatsapp`, `create_event`) is gated. Before execution, the orchestrator pushes a preview to the Admin UI and holds the action in a pending queue. A human must approve or reject within 5 minutes — after which the action is automatically rejected and logged.

#### Context and memory

The orchestrator has access to the document index for retrieving relevant files. No cross-session memory is persisted in v0.1. Conversation context is held in memory for the duration of a task only.

---

### 4. AI model router

Implemented using **LiteLLM** — a single unified Python library providing one `completion()` call across all providers. Swapping a model means editing one line in `routing.yaml`.

#### Routing config (`routing.yaml`)

```yaml
routes:
  classify:     ollama/mistral
  summarise:    claude-sonnet-4-20250514
  embed:        ollama/nomic-embed-text
  draft_email:  claude-sonnet-4-20250514
  quick_reply:  ollama/phi3
  sensitive:    ollama/mistral   # always local — overrides all above if data is tagged
```

#### Routing policy

1. If any sensitivity tag is present → route to `sensitive` (local model), regardless of task type.
2. Otherwise → look up task type in `routing.yaml` and dispatch accordingly.
3. LiteLLM handles retries and provider fallbacks transparently.

#### Local model runtime

Ollama runs natively on Apple Silicon (Metal acceleration) and on Linux (CPU or CUDA). It is installed and managed independently of the Intern application.

| Model | Use |
|---|---|
| `mistral` | Classification, sensitive tasks, quick reasoning |
| `phi3` | Fast short replies, low-latency tasks |
| `nomic-embed-text` | Document embedding for index search |

---

### 5. Connectors

Thin, stateless adapters. Each connector only reads or writes what the orchestration layer explicitly requests via a tool call.

#### Email

- Read: `imaplib` (Python stdlib)
- Send: `smtplib` (Python stdlib)
- Credentials fetched from Keychain at call time via `keyring`
- Attachments written to `~intern-svc/tmp/`, scanned by classifier, then immediately deleted

#### WhatsApp

- WhatsApp Business API (official)
- Outbound messages require approval gate
- Threads involving contacts or content tagged `restricted` are read-only — sending blocked at ACL layer before the connector is reached

> **Security note:** WhatsApp message content is sent to Meta's servers. Enforcement must happen at the ACL layer, not inside the connector. The connector must not be trusted as a safety check.

#### Document index

- SQLite with FTS5 full-text search
- Stores metadata and file pointers only — never file contents
- Located at `~intern-svc/data/index.db`

```sql
CREATE TABLE documents (
  id           TEXT PRIMARY KEY,
  file_path    TEXT NOT NULL,
  title        TEXT,
  doc_type     TEXT,      -- email | contract | invoice | note
  author       TEXT,
  date         DATE,
  tags         TEXT,      -- JSON array
  sensitivity  TEXT DEFAULT 'normal',  -- normal | confidential | restricted
  summary      TEXT,      -- 2-3 sentence AI-generated summary
  fts_content  TEXT,      -- full text for FTS5
  embedding    BLOB       -- optional: vector for semantic search
);
```

The `sensitivity` column is checked before any file path is passed to a model call. File paths are never passed to cloud models if `sensitivity != 'normal'`.

#### Calendar

- **macOS:** EventKit via `pyobjc` — direct native access
- **Linux:** CalDAV via `caldav` Python library
- Read: free/busy, event details
- Write: create/update events — requires approval gate

#### iMessage (macOS only)

- Sends via AppleScript / `imessage-cli`
- Receives by polling the Messages SQLite database at `~/Library/Messages/chat.db` (read-only)

> **Security note:** Reading `chat.db` requires Full Disk Access in macOS System Preferences. This is a broad permission — grant it to the specific Python binary only, and revoke it if the iMessage connector is not actively used.

---

## Project layout

```
intern/
├── config.yaml              # Sys Admin ACL and sensitivity rules  [chmod 600]
├── routing.yaml             # Model routing config
├── requirements.txt
├── main.py                  # Entry point — starts FastAPI + agent loop
├── security/
│   ├── acl.py               # Scope enforcement
│   ├── classifier.py        # Sensitivity tagging
│   └── audit.py             # Append-only SQLite audit log
├── orchestrator/
│   ├── agent.py             # Claude tool-use loop
│   └── approval.py          # Pending action queue
├── router/
│   └── litellm_router.py    # LiteLLM dispatch + routing.yaml loader
├── connectors/
│   ├── email.py             # IMAP / SMTP
│   ├── whatsapp.py          # WhatsApp Business API
│   ├── imessage.py          # AppleScript / chat.db (macOS only)
│   ├── calendar_mac.py      # EventKit via pyobjc (macOS)
│   ├── calendar_caldav.py   # CalDAV (Linux)
│   └── doc_index.py         # SQLite FTS5 document index
├── api/
│   └── admin_ui.py          # FastAPI — bound to 127.0.0.1:8080
└── data/                    # Owned by intern-svc, not checked into version control
    ├── index.db             # Document index
    └── audit.db             # Audit log
```

---

## OS setup checklist

Steps required before running the application for the first time:

1. **Create dedicated OS user** — `sudo useradd -m intern-svc` (Linux) or equivalent on macOS
2. **Set filesystem permissions** — `intern-svc` has read access to the documents folder; read/write only to `~intern-svc/data/`
3. **Store all secrets via keyring** — run `python -c "import keyring; keyring.set_password('intern', 'email_account', '...')"` for each credential; never write them to config files
4. **Set config.yaml permissions** — `chmod 600 config.yaml && chown intern-svc config.yaml`
5. **macOS only: grant entitlements** — in System Preferences → Privacy, grant Mail, Calendar, and Messages access to the specific Python binary under `intern-svc`
6. **Confirm Ollama is running** — `ollama serve`; pull required models with `ollama pull mistral` etc.
7. **Start the Intern** — `python main.py`; Admin UI at `http://127.0.0.1:8080`

---

## Security oversight summary

| Risk | Mitigation |
|---|---|
| Intern process has broad OS permissions | Run as dedicated `intern-svc` user with minimal filesystem grants |
| macOS Full Disk Access for iMessage | Grant to specific Python binary only; revoke if iMessage not in use |
| WhatsApp sends data to Meta | Block sensitive/confidential threads at ACL layer before connector is called |
| Secrets in `.env` files or environment variables | Prohibited — all secrets via `keyring` + OS Keychain / SecretService only |
| `config.yaml` readable by other users | `chmod 600`, owned by `intern-svc` |
| API key with overly broad scope | Admin UI enforces minimal-scope key creation; wildcard scopes require explicit override |
| Audit log tampered with by Intern process | SQLite WAL mode; application layer permits `INSERT` only on audit table |
| Error messages leaking classified content | `400`/`403` responses never include payload data or classifier output |
| Rate limiting absent | Per-key rate limits enforced at ACL layer to prevent connector flooding |
| Admin UI exposed on network | Bound to `127.0.0.1:8080` only — never `0.0.0.0` |
| Webhook endpoints unauthenticated | All inbound webhooks require HMAC signature validation |
| macOS Keychain access after binary path change | Expected OS re-prompt — treat as a canary for unexpected binary changes |

---

## Open decisions

The following items are deferred to subsequent design iterations:

- STT/TTS interface for voice interaction
- LoRA fine-tuning pipeline for writing style adaptation
- Multi-user support and per-user context isolation
- Document ingestion pipeline (folder watching, auto-indexing, embedding generation)
- Telegram connector
- Cross-session memory and long-term preference learning
- Linux headless Keychain fallback strategy (`keyrings.alt` evaluation)
- `launchd` / `systemd` service definition for auto-start on boot

---

*Document maintained alongside the codebase. Update this file when architecture decisions change.*