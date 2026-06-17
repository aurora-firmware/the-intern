# Extension & Channel-Adapter Author Guide

This guide is for developers building on top of `bob`'s public surfaces: the
extension protocol used by `the-intern/extensions/bob.ts`, the pi-agent
compatibility contract, and the channel-adapter interface. A reader who works
through each section will know which sockets to talk to, which framing to use,
and which architectural decisions they must respect.

## JS Extension Protocol

The bob extension (`the-intern/extensions/bob.ts`) is a pi-agent extension.
pi loads it once per session. When loaded, `bob.ts` connects to a Unix domain
socket whose path is given in the `BOB_EXTENSION_SOCK_PATH` environment
variable, using the session id carried in `BOB_SESSION_ID`. Both variables
are set by the bob service's pi-agent supervisor before it spawns pi.

### Wire framing

All frames on `extension.sock` are **newline-delimited JSON** (one JSON
object per line, terminated by a single `\n`). This matches the framing used
on `admin.sock`: one JSON object per line with no literal newlines inside a
frame payload.
Inner JSON must not contain literal newlines.

### Outbound frames (extension → bob service)

`bob.ts` sends two kinds of frames:

**Event frame** — sent for every pi event except `tool_call`:

```json
{"kind":"event","session":"<BOB_SESSION_ID>","payload":{"event":"<name>","data":<object>}}
```

The full list of forwarded events is the `PI_EVENTS` constant exported from
`bob.ts`. At the time of writing it covers all events reachable via the
`ExtensionAPI.on()` overloads of the installed package, excluding `tool_call`,
which is handled by the authz hook instead.

**Authz frame** — sent for `tool_call` events, blocking the tool call until
a verdict arrives:

```json
{"kind":"authz","session":"<BOB_SESSION_ID>","tool":"<name>","arguments":<object>}
```

### Inbound frames (bob service → extension)

The bob service sends back only one frame type:

**AuthzVerdict frame**:

```json
{"kind":"authz_verdict","session":"<BOB_SESSION_ID>","verdict":"allow"|"block"}
```

Verdicts are resolved in FIFO order. If a verdict does not arrive within the
configured timeout (default 5 000 ms, overridable via `BOB_AUTHZ_TIMEOUT_MS`),
`bob.ts` fails closed and blocks the tool call.

### Failure behaviour

- If either `BOB_SESSION_ID` or `BOB_EXTENSION_SOCK_PATH` is unset at load
  time, `bob.ts` emits one warning and disables forwarding for the session.
- If the UDS connect fails on the first event, the transport is marked dead
  (one warning, then silent no-op) for the remainder of the session.
- If the pending-frames queue exceeds its cap (64 frames), the transport is
  likewise marked dead with a single warning.

### Building your own extension

If you want to consume `extension.sock` events from a different program (not
the `bob.ts` extension itself), connect to the socket path, read
newline-delimited JSON frames, and decode each line as an `InboundFrame`
as defined in `the-intern/service/crates/extension-ipc/src/framing.rs`. The
socket is a Unix domain socket created inside a `0o700` parent directory; only
the service-owner uid may connect.

## pi-agent Compatibility

The bob extension is tested against exactly one version of the pi-agent
package:

**`@earendil-works/pi-coding-agent@0.75.3`**

This version is declared as a pinned (no caret, no tilde) `devDependency` in
`the-intern/extensions/package.json`.

### How the compatibility test works

`the-intern/extensions/pi-agent-compat.test.ts` runs as part of `npm test` in
the extensions package. It checks three things:

1. The declared dependency in `package.json` is exactly `0.75.3` with no
   semver range prefix.
2. The installed package's `package.json` reports version `0.75.3`. If a
   different version is installed, the test fails with a message in the form:

   ```
   INCOMPATIBLE pi-agent version detected.
     Installed:  <actual version>
     Supported:  0.75.3
   ```

   The error message includes the command to restore compatibility:
   `npm install @earendil-works/pi-coding-agent@0.75.3`.

3. The `PI_EVENTS` list exported from `bob.ts` exactly covers the events
   exposed by the installed package's `ExtensionAPI.on()` overloads, excluding
   `tool_call`. This detects both missing events (new events added in a newer
   package) and stale events (events removed from an older package).

If you upgrade the pi-agent package, the compatibility test will fail until
you update `PI_EVENTS` in `bob.ts`, pin the new version in `package.json`,
and update the `SUPPORTED_PI_AGENT_VERSION` constant in the compatibility test
file.

## Channel-Adapter Contract

The interactive-chat adapter (`the-intern/service/crates/chat-adapter/`) is
the reference implementation of a channel adapter. It demonstrates the contract
every adapter must satisfy.

### What the interactive-chat adapter does

The adapter receives a `ChatFrame` struct carrying a text message, a `UserId`
for the peer, and an optional conversation context identifier. For each frame
it:

1. Normalizes the message into an `InternalEvent` with `kind = DeliveryKind::Sync`
   and the message text as `payload`.
2. Constructs a `RequestContext` that carries the peer's `UserId` as `sender`,
   the adapter's fixed `ChannelId` as `source`, and the optional context
   identifier.
3. Submits the `(InternalEvent, RequestContext)` pair to the requests-handler
   intake path via its `Handle`.

The adapter applies no policy logic. Every delivered frame is forwarded
unconditionally; admission and policy decisions belong to the requests-handler
and the policy engine.

### Application identity

Each request self-asserts its application-level identity inside the request
itself. The `UserId` placed in `RequestContext.sender` comes from the request
data — not from the OS-level peer credentials. The socket's `0o700` parent
directory is the transport trust gate; once a caller is inside that boundary,
the identity it declares is accepted as authoritative. A request that declares
no identity is rejected at intake.

### Contract for new adapters

Any new channel adapter must:

- Translate each external input into an `InternalEvent` with the appropriate
  `DeliveryKind` (sync, async, or periodic — see
  the delivery semantics summarized below for the meaning of each kind).
- Populate `RequestContext` with an application-level `UserId` supplied by the
  request itself, a fixed `ChannelId` identifying the adapter, and any
  available context identifier.
- Submit the normalized pair to the requests-handler via its `Handle`.
- Apply no policy logic — that is not the adapter's job.

This guide intentionally summarizes the externally visible adapter contract
without linking back into the internal project specifications.

## Pointers to ADRs

These three internal decisions directly constrain extension and adapter authors:

**ADR-001 — Admin-RPC framing: newline-delimited JSON over UDS**
The wire framing rule — one JSON object per line, `\n` terminated, no literal
newlines inside JSON values — applies to both `admin.sock` (JSON-RPC 2.0) and
`extension.sock`. Any new client or adapter that writes to these sockets must
follow this framing.

**ADR-004 — Inbound request interface typed by delivery kind (sync/async/periodic)**
The core recognizes requests by their delivery and response semantics, not by
their channel of origin. An adapter must classify each inbound event as one of
three kinds and produce an `InternalEvent` accordingly:

- **sync** — the caller is waiting for an answer. The caller receives an
  immediate acknowledgement (or error), and the agent's later answer is routed
  back over the originating connection.
- **async** — the caller receives only an acknowledgement (or error); no answer
  is routed back. Any agent-side output is a separate outbound action, not a
  response to this request.
- **periodic** — timer-triggered with no caller to answer; nothing is returned.

The core never enumerates channel types.

**ADR-005 — Application-level request identity is self-asserted within the local-socket trust boundary**
Transport trust is enforced by socket filesystem permissions (the `0o700`
parent directory). Application-level identity is declared inside each request,
not derived from the OS uid. Every request must carry a non-empty, structurally
valid `UserId`; a request with no identity is rejected at intake.
