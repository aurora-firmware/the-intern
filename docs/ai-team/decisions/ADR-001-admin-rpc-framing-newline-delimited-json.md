---
id: ADR-001
title: Admin-RPC framing newline-delimited JSON
status: accepted
created: '2026-05-16'
---

# ADR-001: Admin-RPC framing — newline-delimited JSON over UDS

## Context

S-002 (Bob Service Shell Architecture) fixes the admin surface as JSON-RPC
2.0 over a Unix domain socket (`admin.sock`), but leaves the on-wire framing
as an Open Question:

> Newline-delimited JSON is assumed for v1. If a later subscription stream
> needs interleaved large payloads, length-prefix framing may be preferable.
> The choice does not change any external contract with the CLI as long as
> it is fixed before phase 6.

S-002 phase 6 is implemented by T-024 (client subcommands) — so the framing
must be locked in by the time T-019 (server dispatch) and T-024 land. JSON-RPC
2.0 itself does not specify framing; both newline-delimited JSON and
length-prefixed framing are common in the ecosystem (LSP famously uses
`Content-Length` headers; the Tower JSON-RPC ecosystem typically uses
newline-delimited).

Forces:

- The admin surface multiplexes single-shot RPCs *and* long-lived
  subscriptions (audit tail, chat) on the same persistent connection.
- The expected payload sizes are small: status objects, session lists,
  audit records, chat messages. No file transfers, no embedded binaries.
- Debuggability matters: operators will use `socat` / `nc` to poke the
  socket during development.
- Backpressure on subscriptions is handled at the subscription registry
  layer (T-020), not at the framing layer.

## Decision

The admin-RPC wire protocol is **newline-delimited JSON** (NDJSON / JSON
Lines): one JSON-RPC 2.0 message per line, terminated by a single `\n`. No
length prefix, no `Content-Length` header, no chunked envelope. Inner JSON
must not contain literal `\n` (escape as `\n` in strings).

This applies to both requests, responses, and subscription notifications, in
both directions, over `admin.sock` only. The extension channel
(`extension.sock`) is governed separately by S-001.

## Consequences

### Positive

- Trivially debuggable: `socat - UNIX-CONNECT:$XDG_RUNTIME_DIR/bob/admin.sock`
  plus typing JSON by hand works end to end.
- Standard tooling for streaming JSON (jq's `--stream`, ndjson clients in
  every language) reads notification streams without ceremony.
- Server and client framing code is small and well-trodden — `tokio::io::BufReader::lines()` on the read side, `write_all` + `\n` on the
  write side.
- Cheap to implement on the bob CLI (T-023) and any future GUI/API client.

### Negative

- Disallows literal newlines inside JSON values; both sides must rely on
  serde's default behaviour (which escapes `\n` to `\\n`) rather than
  emitting "pretty" JSON. Easy to enforce in code; potential trap for naïve
  hand-written clients.
- If a future subscription needs to carry large interleaved payloads (e.g.
  audit events with embedded blobs), each whole message must still fit on
  one line. Mitigation: such payloads should be referenced by id and fetched
  via a separate RPC, not embedded.
- Migrating to length-prefixed framing later is a wire-incompatible change;
  it would require a versioned admin protocol or a parallel transport.

### Neutral

- The wire format choice is invisible to the user-facing `bob` CLI; only
  the `AdminClient` primitive (T-023) implements it.

## Alternatives Considered

### Alternative A: Length-prefixed framing (`Content-Length` + body, LSP-style)

**Description:** Each message is preceded by a small header carrying a
content-length value, then the body. Allows arbitrary bytes (including
newlines) inside a message.
**Rejected because:** Strictly heavier for the payload sizes we expect, with
no offsetting benefit (subscription back-pressure is solved at a different
layer). Loses casual `nc` / `socat` debuggability. Adds a header parser that
must be kept in sync between server and every client.

### Alternative B: A binary frame format (CBOR / MessagePack with length prefix)

**Description:** Compact binary representation, length-prefixed.
**Rejected because:** Optimises the wrong axis. The admin surface is a
control plane with small messages, not a data plane. The cost in
debuggability and tooling outweighs the kilobytes saved.

### Alternative C: HTTP/1.1 over the UDS

**Description:** Run hyper over the Unix socket; each RPC is a POST, each
subscription is a server-sent-events stream.
**Rejected because:** S-002's Exclusions explicitly bar HTTP/REST over the
admin surface ("UDS with JSON-RPC 2.0 is the sole transport"). HTTP would
also force us back into REST resource modelling, which S-002 deliberately
rejected when picking JSON-RPC.
