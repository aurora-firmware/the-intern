/**
 * bob.ts — The bob extension for pi-agent.
 *
 * Forwards every documented pi event to the bob service's extension.sock
 * Unix domain socket, tagged with the session id allocated by the bob
 * service supervisor.  Also registers a blocking `tool_call` hook that
 * sends an Authz frame and awaits a matching AuthzVerdict before letting
 * the tool call proceed.
 *
 * Wire contract (outbound frames):
 *   InboundFrame::Event — for all non-tool_call events:
 *     {"kind":"event","session":"<BOB_SESSION_ID>","payload":{"event":"<name>","data":<object>}}\n
 *   InboundFrame::Authz — for tool_call events:
 *     {"kind":"authz","session":"<BOB_SESSION_ID>","tool":"<name>","arguments":<object>}\n
 *
 * Wire contract (inbound frames, received from the bob service):
 *   OutboundFrame::AuthzVerdict:
 *     {"kind":"authz_verdict","session":"<BOB_SESSION_ID>","verdict":{"allow":true|false,"reason":"..."|null}}\n
 *
 * Failure behaviour (one warning, then silent no-op for the session):
 *   - Missing BOB_SESSION_ID or BOB_EXTENSION_SOCK_PATH at load time.
 *   - UDS connect failure on first event.
 *   - Genuine write failure mid-session: a socket 'error' event (e.g.
 *     EPIPE/ECONNRESET), or socket.write() returning false while the socket
 *     is already destroyed/not writable (a clean peer-initiated close can
 *     reach this point without ever raising 'error').
 *   - The pendingFrames cap being exceeded while still connecting (the peer
 *     is too slow or unreachable before a socket has ever been established).
 *   - socket.write() returning false while the socket is still healthy is
 *     ordinary flow-control back-pressure, NOT a failure: the transport
 *     stays alive and queued frames flush once the socket emits 'drain'.
 *
 * Quiet-degradation behaviour (one warning, then silent, transport stays alive):
 *   - The pendingFrames cap being exceeded by a POST-CONNECT drain-wait
 *     backlog (a connected-but-backpressured socket): the oldest queued
 *     EVENT frames are dropped FIFO to bound memory, but the socket is left
 *     alive so any already-queued or future authz frame still flushes once
 *     'drain' fires. If the bounded backlog is already all authz frames, the
 *     oldest authz frame is evicted with its matching resolver and that one
 *     tool call fails closed immediately, keeping later verdicts aligned with
 *     later frames that are still queued. Killing the transport here would
 *     disable tool-call authorization for the rest of the session on nothing
 *     more than an event burst — event loss under sustained overload is
 *     acceptable (S-003), but authz must keep working as long as the socket is
 *     alive.
 *
 * Authz failure behaviour (fail-closed):
 *   - Transport failure, unparseable verdict, or timeout → block + one warning.
 *   - An authz frame stuck behind a peer that never drains fails closed via
 *     either precise queue-overflow eviction or the bounded
 *     BOB_AUTHZ_TIMEOUT_MS verdict timeout, not by killing the transport.
 */

import * as net from "node:net";
import type { ExtensionAPI, ExtensionContext, ToolCallEventResult } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Canonical list of events documented by pi at implementation time.
// Source: @earendil-works/pi-coding-agent@0.75.3 types.d.ts ExtensionAPI.on()
// overloads — all events reachable via the ExtensionAPI interface.
// The live docs at https://pi.dev/docs/latest/extensions are accessible
// but return a client-rendered SPA; the type definitions from the installed
// package are the authoritative machine-readable source.
//
// `tool_call` is intentionally excluded: it is handled by the blocking
// authz hook (see below) rather than the fire-and-forget event loop.
// ---------------------------------------------------------------------------
export const PI_EVENTS = [
  "resources_discover",
  "session_start",
  "session_before_switch",
  "session_before_fork",
  "session_before_compact",
  "session_compact",
  "session_shutdown",
  "session_before_tree",
  "session_tree",
  "context",
  "before_provider_request",
  "after_provider_response",
  "before_agent_start",
  "agent_start",
  "agent_end",
  "turn_start",
  "turn_end",
  "message_start",
  "message_update",
  "message_end",
  "tool_execution_start",
  "tool_execution_update",
  "tool_execution_end",
  "model_select",
  "thinking_level_select",
  "tool_result",
  "user_bash",
  "input",
] as const;

// ---------------------------------------------------------------------------
// Default authz verdict timeout in milliseconds.
// Overridden by BOB_AUTHZ_TIMEOUT_MS if set.
// ---------------------------------------------------------------------------
const DEFAULT_AUTHZ_TIMEOUT_MS = 5000;

// ---------------------------------------------------------------------------
// Warning helper — uses ctx.ui when available, otherwise stderr.
// ---------------------------------------------------------------------------
function warn(message: string, ctx?: ExtensionContext): void {
  const line = `[bob] warn: ${message}\n`;
  if (ctx?.ui) {
    ctx.ui.notify(message, "warning");
  } else {
    process.stderr.write(line);
  }
}

// ---------------------------------------------------------------------------
// Maximum number of frames allowed to queue in pendingFrames — whether while
// the connection is still being established, or while a connected socket is
// waiting for 'drain' after reporting ordinary write() back-pressure.
// Exceeding this limit means the peer is too slow (or permanently stuck) to
// drain; a single transient write() === false is not treated this way —
// only a backlog this deep is. The two cases are handled differently:
//   - Pre-connect (no socket yet): the transport is killed outright (one
//     warn, then silent no-op) — there is no live socket to preserve.
//   - Post-connect drain-wait (a connected, backpressured socket): the
//     socket itself is not the problem, only slow to drain, so it stays
//     alive; the oldest queued EVENT frames are dropped FIFO instead (one
//     warn, then silent) so authz frames already queued or arriving later
//     can still be sent and flushed once 'drain' eventually fires. If the
//     bounded backlog is already all authz frames, the oldest authz frame is
//     evicted together with its matching verdict resolver so later verdicts
//     still match later queued frames.
// ---------------------------------------------------------------------------
const PENDING_FRAMES_CAP = 64;

// ---------------------------------------------------------------------------
// Extension factory — default export consumed by pi's extension loader.
// ---------------------------------------------------------------------------
export default function bobFactory(pi: ExtensionAPI): void {
  const sessionId = process.env.BOB_SESSION_ID;
  const sockPath = process.env.BOB_EXTENSION_SOCK_PATH;

  if (!sessionId || !sockPath) {
    warn(
      "BOB_SESSION_ID or BOB_EXTENSION_SOCK_PATH is not set — " +
        "event forwarding disabled for this session."
    );
    return;
  }

  // Transport state for this session.
  // The socket is opened lazily on the first event so a missing socket at
  // load time does not crash extension load.
  let socket: net.Socket | null = null;
  let transportDead = false;
  let connecting = false;
  // True while waiting for a 'drain' event after socket.write() reported
  // ordinary flow-control back-pressure (write() returned false). While set,
  // flushPending defers writing any further frames rather than piling more
  // data onto an already-full kernel send buffer.
  let backpressured = false;
  // True once the post-connect drain-wait cap-breach warning has fired for
  // this session. Set once and never cleared — matches the "one warning,
  // then silent" convention used for every other failure/degradation path.
  let drainBacklogWarned = false;
  // ---------------------------------------------------------------------------
  // Pending authz verdict resolvers.
  // Each entry corresponds to one outstanding Authz frame awaiting a verdict.
  // Resolved in FIFO order as AuthzVerdict frames arrive.
  // ---------------------------------------------------------------------------
  type VerdictOutcome =
    | { kind: "allow" }
    | { kind: "block"; reason: string | null }
    | { kind: "error" }
    | { kind: "queue_overflow" }
    | { kind: "transport_error_logged" };
  type VerdictResolver = (verdict: VerdictOutcome) => void;
  const pendingVerdicts: VerdictResolver[] = [];

  // Frames queued while the connect is in progress, or while waiting for
  // 'drain' after a connected socket reports back-pressure. Authz frames carry
  // their verdict resolver so cap eviction can fail the same call closed and
  // keep the FIFO verdict queue aligned with frames that were actually sent.
  type PendingFrame =
    | { text: string; isAuthz: false }
    | { text: string; isAuthz: true; verdictResolve: VerdictResolver };
  const pendingFrames: PendingFrame[] = [];

  // Buffer for inbound NDJSON lines from the socket (verdict frames).
  let inboundBuffer = "";

  function handleInboundLine(line: string): void {
    // Each line must be a valid JSON AuthzVerdict frame with a structured
    // verdict object: {"allow": boolean, "reason": string | null}.
    // Anything else — malformed JSON, a non-object top-level frame (e.g. the
    // JSON literal null, a primitive, or an array), wrong kind, wrong session,
    // non-object verdict, or non-boolean allow — resolves as "error"
    // (fail-closed).
    if (pendingVerdicts.length === 0) return;
    const resolve = pendingVerdicts.shift()!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      resolve({ kind: "error" });
      return;
    }
    // Guard the top-level shape before treating it as a record: JSON.parse can
    // legally return null, a primitive, or an array, and reading frame.kind off
    // null would throw a TypeError inside the socket data handler rather than
    // failing closed through the resolver below.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      resolve({ kind: "error" });
      return;
    }
    const frame = parsed as Record<string, unknown>;
    if (frame.kind !== "authz_verdict" || frame.session !== sessionId) {
      resolve({ kind: "error" });
      return;
    }
    const v = frame.verdict;
    if (v === null || typeof v !== "object" || Array.isArray(v)) {
      resolve({ kind: "error" });
      return;
    }
    const verdictObj = v as Record<string, unknown>;
    if (typeof verdictObj.allow !== "boolean") {
      resolve({ kind: "error" });
      return;
    }
    if (verdictObj.allow) {
      resolve({ kind: "allow" });
    } else {
      const reason = typeof verdictObj.reason === "string" ? verdictObj.reason : null;
      resolve({ kind: "block", reason });
    }
  }

  function attachVerdictReader(sock: net.Socket): void {
    sock.setEncoding("utf8");
    sock.on("data", (chunk: string) => {
      inboundBuffer += chunk;
      const lines = inboundBuffer.split("\n");
      // All but the last part are complete lines.
      for (let i = 0; i < lines.length - 1; i++) {
        if (lines[i]!.length > 0) handleInboundLine(lines[i]!);
      }
      inboundBuffer = lines[lines.length - 1]!;
    });

    sock.on("close", () => {
      // Fail-close all pending verdict waiters with "error".
      for (const resolve of pendingVerdicts) {
        resolve({ kind: "error" });
      }
      pendingVerdicts.length = 0;
    });
  }

  function resolvePendingVerdicts(outcome: VerdictOutcome): void {
    for (const resolve of pendingVerdicts) {
      resolve(outcome);
    }
    pendingVerdicts.length = 0;
  }

  function resolveEvictedAuthzFrame(frame: PendingFrame): void {
    if (!frame.isAuthz) return;
    const idx = pendingVerdicts.indexOf(frame.verdictResolve);
    if (idx !== -1) pendingVerdicts.splice(idx, 1);
    frame.verdictResolve({ kind: "queue_overflow" });
  }

  function markDead(reason: string, ctx?: ExtensionContext): void {
    transportDead = true;
    socket?.destroy();
    socket = null;
    // Any in-flight tool_call authz must fail closed immediately and must not
    // emit a second warning in handleToolCall (this warning is the canonical one).
    resolvePendingVerdicts({ kind: "transport_error_logged" });
    warn(`transport error — event forwarding disabled for this session: ${reason}`, ctx);
  }

  function flushPending(ctx?: ExtensionContext): void {
    if (!socket || transportDead || backpressured) return;
    while (pendingFrames.length > 0) {
      const frame = pendingFrames[0]!;
      // Node always accepts a write() call and queues the frame for delivery
      // internally, regardless of the return value: false means the internal
      // buffer is over its high-water mark (ordinary flow-control
      // back-pressure), not that the frame failed to send.  Remove it from
      // our own queue either way — the socket has taken ownership of it.
      const ok = socket.write(frame.text);
      pendingFrames.shift();
      if (!ok) {
        if (socket.destroyed || !socket.writable) {
          // The socket is already gone. A false return here reports a
          // genuine failure, not ordinary back-pressure: some peer-initiated
          // close paths (a clean FIN) reach this point without ever raising
          // an 'error' event, so detect it directly rather than relying only
          // on 'error'/'close'.
          markDead("socket.write returned false on a closed socket", ctx);
        } else {
          // Ordinary back-pressure: pause further writes until 'drain'
          // signals the buffer has cleared; any frames still queued behind
          // this one stay in pendingFrames for the next flush attempt.
          backpressured = true;
        }
        return;
      }
    }
  }

  function ensureConnected(
    frame: string,
    ctx?: ExtensionContext,
    verdictResolve?: VerdictResolver
  ): void {
    if (transportDead) return;

    if (pendingFrames.length >= PENDING_FRAMES_CAP) {
      if (socket === null) {
        // Pre-connect: the peer is too slow (or unreachable) to even finish
        // connecting. There is no live socket to preserve, so drop this
        // frame and all future frames by marking the transport dead (one
        // warn, then silent) — unchanged from the original cap policy.
        markDead(
          `pendingFrames cap of ${PENDING_FRAMES_CAP} exceeded — dropping frames`,
          ctx
        );
        return;
      }
      // Post-connect drain-wait: the socket itself is alive, only slow to
      // drain. Killing the transport here would also kill any already-queued
      // or future authz frame, permanently disabling tool calls for the rest
      // of the session on nothing more than a sustained event burst. Instead,
      // warn once and drop the oldest queued EVENT frame (FIFO) to bound
      // memory, keeping the socket alive so authz frames keep flowing; a
      // stuck authz frame still fails closed via BOB_AUTHZ_TIMEOUT_MS.
      if (!drainBacklogWarned) {
        drainBacklogWarned = true;
        warn(
          `pendingFrames cap of ${PENDING_FRAMES_CAP} exceeded while waiting for drain — ` +
            "dropping oldest queued events",
          ctx
        );
      }
      const oldestEventIndex = pendingFrames.findIndex((queued) => !queued.isAuthz);
      if (oldestEventIndex !== -1) {
        pendingFrames.splice(oldestEventIndex, 1);
      } else {
        // Every queued frame is an authz frame (no event frame to drop
        // instead) — evict the oldest one as a last resort and fail the same
        // tool call closed so later verdicts still match later sent frames.
        const evicted = pendingFrames.shift();
        if (evicted) resolveEvictedAuthzFrame(evicted);
      }
    }

    pendingFrames.push(
      verdictResolve
        ? { text: frame, isAuthz: true, verdictResolve }
        : { text: frame, isAuthz: false }
    );

    if (socket !== null) {
      // Already connected — flush immediately (a no-op while waiting for
      // 'drain'; the frame just pushed stays queued until then).
      flushPending(ctx);
      return;
    }

    if (connecting) {
      // Connection in progress — frame is already queued.
      return;
    }

    connecting = true;
    const sock = net.createConnection(sockPath!, () => {
      // Connected — set up the inbound reader before flushing outbound frames.
      connecting = false;
      socket = sock;
      attachVerdictReader(sock);
      // Re-flush once the kernel send buffer clears after back-pressure.
      // Reuses the ctx captured from the event that triggered this connect,
      // matching how the 'error' handler below reports failures.
      sock.on("drain", () => {
        backpressured = false;
        flushPending(ctx);
      });
      flushPending(ctx);
    });

    sock.on("error", (err: Error) => {
      // Covers both connect failures (ENOENT, ECONNREFUSED) and mid-session
      // write errors (EPIPE, ECONNRESET) after the connection is established.
      if (!transportDead) {
        connecting = false;
        pendingFrames.length = 0;
        markDead(err.message, ctx);
      }
    });
  }

  function buildFrame(eventName: string, data: unknown): string {
    return (
      JSON.stringify({
        kind: "event",
        session: sessionId,
        payload: {
          event: eventName,
          data,
        },
      }) + "\n"
    );
  }

  function handleEvent(eventName: string): (event: unknown, ctx: ExtensionContext) => void {
    return (event: unknown, ctx: ExtensionContext) => {
      if (transportDead) return;
      const frame = buildFrame(eventName, event);
      ensureConnected(frame, ctx);
    };
  }

  // ---------------------------------------------------------------------------
  // Blocking tool_call authz hook.
  //
  // Sends an Authz frame to the bob service and awaits a matching
  // AuthzVerdict.  Fails closed (block + one warning) on timeout,
  // transport failure, or unparseable verdict.
  // ---------------------------------------------------------------------------
  function resolveAuthzTimeout(): number {
    const raw = process.env.BOB_AUTHZ_TIMEOUT_MS;
    if (raw !== undefined && raw !== "") {
      const parsed = parseInt(raw, 10);
      if (!isNaN(parsed) && parsed > 0) return parsed;
    }
    return DEFAULT_AUTHZ_TIMEOUT_MS;
  }

  function buildAuthzFrame(toolName: string, args: unknown): string {
    return (
      JSON.stringify({
        kind: "authz",
        session: sessionId,
        tool: toolName,
        arguments: args,
      }) + "\n"
    );
  }

  async function handleToolCall(
    event: unknown,
    ctx: ExtensionContext
  ): Promise<ToolCallEventResult> {
    const ev = event as { toolName?: string; input?: unknown };
    const toolName = ev.toolName ?? "unknown";
    const args = ev.input ?? {};

    if (transportDead) {
      warn(`authz: tool call blocked — transport is dead`, ctx);
      return { block: true, reason: "transport is dead" };
    }

    const frame = buildAuthzFrame(toolName, args);

    // Enqueue a verdict promise before sending the frame so the resolver is
    // in place when the reply arrives.
    let verdictResolve!: VerdictResolver;
    const verdictPromise = new Promise<VerdictOutcome>((resolve) => {
      verdictResolve = resolve;
    });
    pendingVerdicts.push(verdictResolve);

    // Send the authz frame (this may trigger a lazy connect). Tag it as an
    // authz frame so a post-connect cap breach prefers evicting an ordinary
    // event frame over this one.
    ensureConnected(frame, ctx, verdictResolve);

    // Await the verdict with a bounded timeout.
    const timeoutMs = resolveAuthzTimeout();
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      setTimeout(() => resolve("timeout"), timeoutMs);
    });

    const outcome = await Promise.race([verdictPromise, timeoutPromise]);

    if (outcome === "timeout") {
      // Remove the resolver from the queue so it doesn't get invoked later.
      const idx = pendingVerdicts.indexOf(verdictResolve);
      if (idx !== -1) pendingVerdicts.splice(idx, 1);
      warn(`authz: verdict timeout after ${timeoutMs}ms — blocking tool call`, ctx);
      return { block: true, reason: "authz verdict timeout" };
    }

    // After the timeout guard above, outcome is narrowed to VerdictOutcome.
    if (outcome.kind === "block") {
      const policyReason = outcome.reason ?? "blocked by policy";
      warn(`authz: tool call blocked by policy: ${policyReason}`, ctx);
      return { block: true, reason: policyReason };
    }

    if (outcome.kind === "error") {
      warn(`authz: unparseable or transport-error verdict — blocking tool call`, ctx);
      return { block: true, reason: "authz verdict error" };
    }

    if (outcome.kind === "transport_error_logged") {
      return { block: true, reason: "transport error" };
    }

    if (outcome.kind === "queue_overflow") {
      return { block: true, reason: "authz queue overflow" };
    }

    // outcome.kind === "allow"
    return { block: false };
  }

  // Register a handler for every documented pi event (excluding tool_call,
  // which uses the blocking authz hook registered separately below).
  // Cast is required because ExtensionAPI.on() uses individual overloads per
  // event name rather than a general string → handler signature.
  const piGeneric = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void | Promise<unknown>): void;
  };
  for (const name of PI_EVENTS) {
    piGeneric.on(name, handleEvent(name));
  }

  // Register the blocking tool_call authz hook.
  // Cast is required: the overloaded on() signature for "tool_call" expects
  // ExtensionHandler<ToolCallEvent, ToolCallEventResult>, but handleToolCall
  // uses a looser event type to avoid importing the full ToolCallEvent union.
  (pi as unknown as {
    on(
      event: "tool_call",
      handler: (event: unknown, ctx: ExtensionContext) => Promise<ToolCallEventResult>
    ): void;
  }).on("tool_call", handleToolCall);
}
