---
id: CR-002
title: bob chat launches an interactive pi session
status: pending
created: '2026-06-22'
---

# bob chat launches an interactive pi session

## Desired Changes

**`bob chat` opens a real interactive pi-agent session.** Instead of being an
`admin.sock` JSON-RPC client that feeds the in-process chat adapter, `bob chat`
launches an interactive `pi` agent chat — a launcher around an interactive `pi`
session rather than a custom REPL talking JSON-RPC over the admin socket.

Constraints on that launcher:

- **Service-owned, supervised session.** `bob chat` requires the bob service to be
  running and fails with a clear error if it is not — it is a front-end to the live
  service, not a standalone `pi` launcher. The interactive `pi` session is **owned and
  supervised by `bob serve`** (not spawned by the `bob chat` client), so it is wired
  with `BOB_SESSION_ID` and the extension socket path
  (`$XDG_RUNTIME_DIR/bob/extension.sock`, ADR-009), loads the bob extension (CR-003),
  and is visible to monitoring / `sessions list` / reaping. Without this the extension
  membrane would be inert.
- **Gated by socket access + the `tool_call` authz membrane, not pre-flight admission.**
  Interactive chat is **exempt from per-user pre-flight admission** (ADR-010). Its gates
  are (1) socket access — the 0700 owner-only Unix-socket trust boundary (ADR-005 /
  ADR-007 "Layer 1") — and (2) the blocking `tool_call` authorization hook hosted by the
  bob extension (S-004 action gate), which remains fully in force. The `config.toml`
  `admitted_users` allow-list no longer gates interactive chat; it remains in force for
  non-interactive / programmatic intake that traverses the Requests Handler.

> **Scope note.** This change request was split. The original CR-002 also bundled "load
> the bob extension by path instead of pre-installed"; that half is now tracked
> separately in **CR-003**. Both depend on the XDG filesystem layout in **ADR-009**; the
> admission exemption is recorded in **ADR-010**.

## Context

Today the design splits interactive chat across three approved specs:

- **S-006** makes `bob chat` an external client that opens a `chat` JSON-RPC
  subscription on `admin.sock`; the Admin-RPC actor hands each user-input frame to an
  in-process interactive-chat adapter, which normalizes it into a `Sync`-kind internal
  request and submits it through the channel intake handle onto the bounded queue.
- **S-008** adds the outbound half: a chat reply router, a `chat.open`/forwarder push
  channel, and CLI changes so the same `bob chat` process prints replies delivered over
  `admin.sock`.

The requested behaviour collapses the interactive-chat experience back onto pi itself:
`bob chat` runs an interactive pi session directly. This bypasses the admin-socket
inbound/outbound chat machinery that S-006 and S-008 specify and that has already been
implemented. (Note: the back half of that machinery — dequeue → dispatch to pi → reply
via the chat router — is not yet wired in `bob serve`; the inbound path stops at the
persistence queue. The deferred outbound work is tracked in CR-001.)

## Resolution / scope decisions

- **Admission model (ADR-010).** A directly-launched interactive pi session traverses
  none of the chat-adapter → intake → Requests-Handler path where pre-flight admission
  (S-004) is enforced, so per-user admission has no enforcement point for it (Gate-1
  finding, 2026-06-23). Decision: **exempt interactive chat from pre-flight admission**
  and rely on the socket trust boundary + the `tool_call` authz membrane (**ADR-010**).
  This **amends S-004 and ADR-005** — so for this aspect a new ADR is created rather than
  a pure in-place amendment.
- **Process model.** The interactive pi is a **supervised child of `bob serve`**, not the
  `bob chat` client, so it acquires its session id, extension socket path, extension, and
  monitoring from the service. How the user's terminal is brokered to a service-owned pi
  session (stdio brokering / attach) is an implementation detail for the new tasks.
- **Other specs amended in place.** S-006, S-008, and S-002 are amended in place; new
  tasks correct the implementation.

## Potential Impact

**Affected specs (amendments):**

- **S-004 — Policy control pre-flight admission.** Amend: pre-flight admission applies to
  queue-borne requests, **not** to interactive chat (per ADR-010). The action-level
  `tool_call` authorization path is unchanged.
- **S-006 — Channel-adapter framework and interactive-chat adapter.** The interactive-chat
  path (`admin.sock` chat subscription → in-process chat adapter → intake handle) is
  bypassed for the interactive use case. Amend in place; the amendment decides whether the
  chat adapter / admin-socket chat path is retired or kept for non-interactive /
  programmatic intake.
- **S-008 — Outbound chat response path over the admin socket.** Amend in place — mark
  superseded or re-scope for a future programmatic chat path, decided within the amendment.
- **S-002 — bob service shell architecture.** Amend the `bob chat` subcommand surface,
  including the new service-required precondition; note that the S-002 workflow currently
  asserts `bob chat` goes through Requests Handler → Policy Control, which this change
  contradicts.
- **S-007 / user docs.** Update the end-user CLI guide describing the current admin-socket
  flow.

**Affected ADRs:**

- **ADR-010 (new).** Records the admission exemption this change relies on; amends S-004
  and ADR-005.
- **ADR-005 — application-level request identity.** The intake-rejection expectation is
  relaxed for the interactive-chat channel (per ADR-010).
- **ADR-009.** XDG layout (extension socket path under `runtime`, etc.).

**At-risk / possibly-obsoleted completed work (needs review):**

- T-072 (chat adapter wired into `bob serve`), T-073 / T-088 (chat send intake /
  context-id mapping), T-024 (`bob` chat subcommand), T-091 / T-078 (user docs for
  interactive chat), and the S-008 chat-router tasks. Some of this code (the admin-socket
  chat dispatch, chat-adapter, chat reply router) may become dead or need rework via the
  new tasks.

**Code likely touched:** `crates/bob/src/cli/commands/chat.rs`,
`crates/admin-rpc/src/chat_router.rs` and dispatch, `crates/chat-adapter`, and the
pi-agent supervisor spawn path.

**Risks:**

- **Process / session integration (the main risk).** The interactive pi must be a
  supervised `bob serve` child to get the env contract, monitoring, and extension;
  brokering an interactive terminal to a daemon-owned session (stdio attach) is the
  principal implementation challenge. Define in the new tasks.
- **Admission exemption is single-user-local only.** Dropping per-user admission for chat
  is acceptable under ADR-008 (sole local user, socket-gated) but must be revisited if
  multi-user is ever in scope. Security-relevant — see ADR-010.
- **pi availability precondition.** This makes `pi` a hard runtime dependency of
  `bob chat` itself (per the project precondition that `pi` is on `PATH`); behaviour when
  `pi` is absent must be defined.

## Possible Spec Amendments

- **S-004** — exempt interactive chat from pre-flight admission (ADR-010); leave the
  `tool_call` authorization path unchanged.
- **ADR-005** — relax the intake-identity rejection for the interactive-chat channel
  (ADR-010).
- **S-006** — amend in place to reflect interactive chat through pi; decide
  retire-vs-retain-for-programmatic-intake within the amendment.
- **S-008** — amend in place; mark superseded or re-scope depending on whether an
  admin-socket chat path is retained.
- **S-002** — amend the `bob chat` subcommand description, including the service-required
  precondition.
- Related: **CR-003** (extension by path), **ADR-009** (XDG layout), **ADR-010**
  (admission exemption), **ADR-011** (terminal brokering via SCM_RIGHTS),
  **CR-001** (deferred outbound chat path).
