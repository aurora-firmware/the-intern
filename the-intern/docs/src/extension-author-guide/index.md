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

### How bob loads the extension

Bob owns extension delivery. It resolves `bob.ts` from the XDG data directory
and passes the result to each pi process with `pi --extension <resolved-path>`.
The Linux default is `~/.local/share/bob/extensions/bob.ts`, or
`$XDG_DATA_HOME/bob/extensions/bob.ts` when `XDG_DATA_HOME` is set. The macOS
default is `~/Library/Application Support/bob/extensions/bob.ts`.

Operators can set the top-level `extension_path` key in `config.toml` (or the
`BOB_EXTENSION_PATH` environment override) to select another file. Bob refuses
to spawn pi when the resolved file is missing. Installing `bob.ts` into pi's own
extension search path is neither required nor used by bob.

See the
[Operator & Deployer Guide](../operator-guide/index.md#install-the-bob-extension)
for installation commands.

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
{"kind":"authz_verdict","session":"<BOB_SESSION_ID>","verdict":{"allow":true|false,"reason":"..."|null}}
```

`verdict` is a structured object, not a string: `allow` is a boolean and
`reason` is an optional human-readable explanation. Verdicts are resolved in
FIFO order. If a verdict does not arrive within the configured timeout
(default 5 000 ms, overridable via `BOB_AUTHZ_TIMEOUT_MS`), or if a frame does
not match this shape (for example a legacy `"verdict":"allow"|"block"` string,
as sent by extension releases before this wire format was introduced),
`bob.ts` fails closed and blocks the tool call.

### One connection per session, and why it matters

pi additively loads extensions from both the `--extension` flag bob passes
and its own `~/.pi/agent/settings.json` `packages` list (see the
[Operator & Deployer Guide](../operator-guide/index.md#remove-stale-extension-copies-from-pis-own-packages-list)).
If a second `bob.ts` instance — for example a stale copy left in `packages`
— opens its own connection under the same `BOB_SESSION_ID`, the service
detects that a second live connection has registered an already-active
session id. It emits a `WARN`-level log line and a
`duplicate_extension_connection` audit `event` naming both connections,
rather than letting the two hooks silently coexist. The service does not
close either connection when this happens: both keep receiving verdicts as
normal, because the service has no reliable way to tell which connection is
the stale one. Extension authors building their own `extension.sock` client
should likewise expect at most one live connection per session id in the
intended deployment, and should treat this signal as evidence of a
misconfiguration to fix (see the operator guide section above), not as a
protocol handshake to participate in.

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

Channel adapters normalize source-specific triggers into the core request
types. For each trigger, an adapter constructs:

- an `InternalEvent` containing the appropriate `DeliveryKind` and payload;
- a `RequestContext` containing the sender `UserId`, source `ChannelId`, optional
  context id, and optional reply address; and
- a submission through the requests-handler `IntakeHandle`.

Adapters do not evaluate admission or action policy. The Requests Handler owns
pre-flight admission for *admission-gated* queue-borne requests, while the
extension and policy engine enforce tool-call authorization inside supervised pi
sessions. Not every adapter is admission-gated: under ADR-012 the scheduler's
`Periodic` events are admitted by trusted schedule-store membership and skip
pre-flight admission (see below).

### Shipped scheduler adapter

`the-intern/service/crates/scheduler-adapter/` is the concrete implementation
shipped with bob. The actor always starts with `bob serve`. It creates one task
per entry in the JSON schedule store (`schedules.json`) and, on each cron tick, submits:

- `DeliveryKind::Periodic` with the configured prompt as its payload;
- stable `UserId` and `ChannelId` values derived from the job id;
- the job id as `RequestContext.context_id`; and
- no reply address, because a periodic trigger has no waiting caller.

Reloading the schedule rebuilds the live job table. A failed intake submission
is logged and does not terminate the scheduler loop.

Under ADR-012 the scheduler is **not admission-gated**: a job present in the
trusted schedule store is admitted for firing, so its `Periodic` events bypass
pre-flight admission and do **not** require a `[policy].admitted_users` entry.
The stable `UserId` is retained only for audit attribution, not for admission.
Every resulting `tool_call` is still subject to the S-004 action gate.

### Application identity

Every queue-borne request needs a valid application-level identity. An adapter
must obtain that identity according to its source contract: an external local
client can self-assert it inside the request, while the scheduler derives a
stable identity from the configured job id. OS peer credentials protect local
socket access but do not replace `RequestContext.sender`. A request with no
valid identity is rejected at intake.

### Contract for new adapters

Any new channel adapter must:

- Translate each external input into an `InternalEvent` with the appropriate
  `DeliveryKind` (sync, async, or periodic — see
  the delivery semantics summarized below for the meaning of each kind).
- Populate `RequestContext` with a stable application-level `UserId`, a
  `ChannelId` identifying the source, and any available context or reply
  address.
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
