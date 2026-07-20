---
id: ADR-003
title: Admin client crate boundary lives in bob binary crate
status: accepted
created: '2026-05-16'
---

# ADR-003: Admin-RPC client lives in the `bob` binary crate

## Context

S-002 §Component 7 names the `bob` CLI's non-`serve` subcommands as thin
admin-RPC clients of `admin.sock`. S-002's Open Questions then ask:

> Whether the JSON-RPC client used by `bob`'s non-`serve` subcommands
> should live in `bob-core` (reusable by a future Rust GUI) or in the
> binary crate.

T-023 implements that client primitive. The placement decision determines
whether other future Rust consumers (GUIs, integration tests in sibling
crates, third-party scripts vendored into the workspace) can use the same
code path or must roll their own.

Forces:

- `bob-core` is by design **runtime-agnostic** (S-002 design principle): no
  Tokio dependency, no I/O, no sockets. The admin client requires Tokio
  (Unix-socket I/O, async framing, subscription tasks).
- A future GUI is explicitly *not* prioritised (S-002 §Exclusions: "No GUI
  built"). The "reuse by future Rust GUI" pull on `bob-core` is hypothetical.
- The admin client surface co-evolves with the admin-RPC server method
  catalogue (T-019/T-020). Splitting them across crate boundaries adds a
  versioning seam where there isn't a real audience yet.
- The bob binary crate already depends on Tokio for `bob serve`; the
  client's runtime cost there is zero.

## Decision

The admin-RPC client primitive (`AdminClient`, `Subscription`) lives in the
**`bob` binary crate** at `crates/bob/src/client/`. It does *not* live in
`bob-core`, and no separate `bob-admin-client` crate is created in this phase.

If and when a future Rust consumer (GUI, integration test outside `bob`,
external project) needs the client, this ADR is revisited and the client is
extracted into a new `crates/bob-admin-client/` library crate that:

- depends on `bob-core` for the wire types,
- depends on Tokio for the I/O layer,
- is consumed by both the binary crate and the new consumer.

The extraction is a mechanical move (rename `bob::client` →
`bob_admin_client::*`, re-export from `bob`), expected to take well under a
day.

## Consequences

### Positive

- Preserves `bob-core`'s runtime-agnostic guarantee (no Tokio creep into
  the deterministic core).
- Server method catalogue and client method catalogue live in the same
  crate during initial development, eliminating cross-crate coordination
  for early protocol churn.
- No crate exists for a consumer that does not yet exist.
- The deferred-extraction path is well-understood and cheap.

### Negative

- A motivated external project cannot reuse `AdminClient` today without
  vendoring the source or waiting for the extraction. Acceptable —
  external consumers are out of scope until a real one appears.
- Integration tests outside the bob crate (e.g. a future shared test
  utility crate) would currently have to call `bob` as a subprocess rather
  than instantiate the client directly. Acceptable for v1 of the shell;
  T-025's e2e smoke test already uses the subprocess approach.

### Neutral

- The extraction trigger is concrete (the first real second consumer of the
  client), removing speculation about "what if".

## Alternatives Considered

### Alternative A: Place `AdminClient` in `bob-core`

**Description:** Make the runtime-agnostic core also host the client.
**Rejected because:** Violates S-002's design principle that `bob-core`
holds no Tokio dependency. Would force every consumer of `bob-core`'s
domain types (including subsystem crates that have no business knowing
about UDS clients) to take on the client's transitive dependency cone.

### Alternative B: Create `bob-admin-client` as a third crate now

**Description:** Pre-emptively split the client into its own library crate.
**Rejected because:** No second consumer exists. The split would add crate
boundaries, versioning surface, and per-protocol-change overhead in
exchange for hypothetical reuse. YAGNI; reach for this when (not if) the
first real second consumer arrives.

### Alternative C: Put the client in `admin-rpc`

**Description:** Co-locate client and server next to the protocol they share.
**Rejected because:** `admin-rpc` is a service-side crate consumed by
`bob serve` only. Mixing a client into it muddies its purpose and forces
binary-crate dependencies on it for client use. The protocol module
(`admin_rpc::protocol`) is already the natural shared surface should the
extraction in this ADR's deferred path ever happen — both sides will
import it.
