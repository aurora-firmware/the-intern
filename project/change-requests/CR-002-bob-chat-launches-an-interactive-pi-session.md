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
should launch an interactive `pi` agent chat — the user experience is equivalent
to invoking `pi` directly from the terminal. The command becomes (in effect) a
thin launcher around the `pi` interactive chat, not a custom REPL talking
JSON-RPC over the admin socket.

Two constraints on that launcher:

- **Requires the bob service to be running.** `bob chat` is a front-end to the
  live service, not a standalone `pi` launcher. If the bob service is not up,
  `bob chat` fails with a clear error rather than starting a bare `pi` session —
  there is no point in using `bob chat` merely to run `pi`. Requiring the service
  also guarantees the interactive session runs in a context where the extension
  socket (`$XDG_RUNTIME_DIR/bob/extension.sock`, ADR-009), session id, and
  monitoring exist.
- **No policy-admission bypass.** Interactive chat remains subject to
  policy/pre-flight admission. For now admission is granted via `config.toml`
  admitting the chat default identity (`chat_application_identity`), exactly as
  the current stopgap; the service-up requirement above is what keeps that gate
  enforceable.

> **Scope note.** This change request was split. The original CR-002 also
> bundled "load the bob extension by path instead of pre-installed"; that half is
> now tracked separately in **CR-003**, which builds on the XDG filesystem
> layout in **ADR-009**. CR-002 below is the pi-invocation change only.

## Context

Today the design splits interactive chat across three approved specs:

- **S-006** makes `bob chat` an external client that opens a `chat` JSON-RPC
  subscription on `admin.sock`; the Admin-RPC actor hands each user-input frame
  to an in-process interactive-chat adapter, which normalizes it into a
  `Sync`-kind internal request and submits it through the channel intake handle
  onto the bounded queue.
- **S-008** adds the outbound half: a chat reply router, a `chat.open`/forwarder
  push channel, and CLI changes so the same `bob chat` process prints replies
  delivered over `admin.sock`.

The requested behaviour collapses the interactive-chat experience back onto pi
itself: `bob chat` runs an interactive pi session directly. This gives a
genuinely interactive agent session, but it bypasses the admin-socket
inbound/outbound chat machinery that S-006 and S-008 specify and that has already
been implemented. (Note: the back half of that machinery — dequeue → dispatch to
pi → reply via the chat router — is not yet wired in `bob serve`; the inbound
path stops at the persistence queue. The deferred outbound work is tracked in
CR-001.)

## Resolution / scope decisions

- **Amend specs in place.** S-006, S-008, S-002 (and S-003 via CR-003) are
  amended **in place** to reflect interactive chat through pi; no new spec and no
  new ADR are created. The implementation is corrected by new tasks generated
  from the amended specs.
- **Service required; no bypass.** See Desired Changes — `bob chat` fails if the
  service is down, and policy admission still applies via `config.toml`.

## Potential Impact

**Affected specs (amendments — in place):**

- **S-006 — Channel-adapter framework and interactive-chat adapter.** The
  interactive-chat path (the `admin.sock` chat subscription → in-process chat
  adapter → intake handle flow) is bypassed for the interactive use case. Amend
  in place to state that interactive chat runs through pi; the amendment decides
  whether the chat adapter / admin-socket chat path is retired or kept for
  non-interactive/programmatic intake.
- **S-008 — Outbound chat response path over the admin socket.** The reply
  router, `chat.open` forwarder, and CLI reply-printing exist specifically to
  make the admin-socket `bob chat` interactive. Amend in place — mark superseded
  or re-scope for a future programmatic chat path, decided within the amendment.
- **S-002 — bob service shell architecture.** Defines the `bob chat` subcommand
  surface; the subcommand's behaviour changes (including the service-required
  precondition). Amend the subcommand description in place.
- **S-007 / user docs.** The end-user CLI guide and the interactive-`bob chat`
  documentation describe the current admin-socket flow; update.

**At-risk / possibly-obsoleted completed work (needs review):**

- T-072 (chat adapter wired into `bob serve`), T-073 / T-088 (chat send intake /
  context-id mapping), T-024 (`bob` chat subcommand), T-091 / T-078 (user docs
  for interactive chat), and the S-008 chat-router tasks. Some of this code (the
  admin-socket chat dispatch, chat-adapter, chat reply router) may become dead or
  need rework via the new tasks.

**Code likely touched:** `crates/bob/src/cli/commands/chat.rs`,
`crates/admin-rpc/src/chat_router.rs` and dispatch, `crates/chat-adapter`, and
the pi-agent supervisor spawn path.

**Risks:**

- **Event forwarding / session integration.** S-003's extension forwards events
  to `extension.sock` using `BOB_SESSION_ID` and the extension socket path
  (`$XDG_RUNTIME_DIR/bob/extension.sock`, ADR-009) set by the supervisor. Because
  `bob chat` requires the service to be up, the interactive session runs in the
  live service's context, so these are available — but exactly how the
  directly-launched pi session attaches to the supervisor and acquires its
  session id must be defined by the in-place amendments and new tasks.
- **Policy admission.** Resolved: no bypass — admission continues via
  `config.toml` (chat default identity) as the current stopgap, kept enforceable
  by the service-required precondition. Security-relevant; revisit if interactive
  chat ever runs without the service gate.
- **pi availability precondition.** This makes `pi` a hard runtime dependency of
  `bob chat` itself (per the project precondition that `pi` is on `PATH`);
  behaviour when `pi` is absent must be defined.

## Possible Spec Amendments

- **S-006** — amend in place to reflect that interactive chat runs through pi
  directly; decide retire-vs-retain-for-programmatic-intake within the amendment.
- **S-008** — amend in place; mark superseded or re-scope depending on whether an
  admin-socket chat path is retained.
- **S-002** — amend the `bob chat` subcommand description, including the
  service-required precondition.
- Related: **CR-003** (extension by path), **ADR-009** (XDG layout), **CR-001**
  (deferred outbound chat path).
