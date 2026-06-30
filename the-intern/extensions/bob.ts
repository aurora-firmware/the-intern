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
 *   - Write failure mid-session.
 *
 * Authz failure behaviour (fail-closed):
 *   - Transport failure, unparseable verdict, or timeout → block + one warning.
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
// Maximum number of frames allowed in the pre-connect queue.
// Exceeding this limit means the transport is too slow to drain; we kill it
// immediately (one warn, then silent no-op) rather than buffer unboundedly.
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
  // Frames queued while the connect is in progress.
  const pendingFrames: string[] = [];

  // ---------------------------------------------------------------------------
  // Pending authz verdict resolvers.
  // Each entry corresponds to one outstanding Authz frame awaiting a verdict.
  // Resolved in FIFO order as AuthzVerdict frames arrive.
  // ---------------------------------------------------------------------------
  type VerdictOutcome =
    | { kind: "allow" }
    | { kind: "block"; reason: string | null }
    | { kind: "error" }
    | { kind: "transport_error_logged" };
  type VerdictResolver = (verdict: VerdictOutcome) => void;
  const pendingVerdicts: VerdictResolver[] = [];

  // Buffer for inbound NDJSON lines from the socket (verdict frames).
  let inboundBuffer = "";

  function handleInboundLine(line: string): void {
    // Each line must be a valid JSON AuthzVerdict frame with a structured
    // verdict object: {"allow": boolean, "reason": string | null}.
    // Anything else — malformed JSON, wrong kind, wrong session, non-object
    // verdict, or non-boolean allow — resolves as "error" (fail-closed).
    if (pendingVerdicts.length === 0) return;
    const resolve = pendingVerdicts.shift()!;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
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
    if (!socket || transportDead) return;
    for (const frame of pendingFrames) {
      const ok = socket.write(frame);
      // write() returns false when the kernel send-buffer is full (back-pressure)
      // or when the socket has been destroyed by the peer.  Either way the frame
      // was not accepted; kill the transport immediately rather than buffering.
      if (!ok) {
        pendingFrames.length = 0;
        markDead("socket.write returned false — back-pressure or peer closed", ctx);
        return;
      }
    }
    pendingFrames.length = 0;
  }

  function ensureConnected(frame: string, ctx?: ExtensionContext): void {
    if (transportDead) return;

    if (pendingFrames.length >= PENDING_FRAMES_CAP) {
      // Queue is full — the transport is too slow.  Drop this frame and all
      // future frames by marking the transport dead (one warn, then silent).
      markDead(
        `pendingFrames cap of ${PENDING_FRAMES_CAP} exceeded — dropping frames`,
        ctx
      );
      return;
    }

    pendingFrames.push(frame);

    if (socket !== null) {
      // Already connected — flush immediately.
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

    // Send the authz frame (this may trigger a lazy connect).
    ensureConnected(frame, ctx);

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
