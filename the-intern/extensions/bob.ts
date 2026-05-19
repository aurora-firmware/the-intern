/**
 * bob.ts — The bob extension for pi-agent.
 *
 * Forwards every documented pi event to the bob service's extension.sock
 * Unix domain socket, tagged with the session id allocated by the bob
 * service supervisor.
 *
 * Wire contract: InboundFrame::Event from extension-ipc/src/framing.rs
 *   {"kind":"event","session":"<BOB_SESSION_ID>","payload":{"event":"<name>","data":<object>}}\n
 *
 * Failure behaviour (one warning, then silent no-op for the session):
 *   - Missing BOB_SESSION_ID or BOB_EXTENSION_SOCK_PATH at load time.
 *   - UDS connect failure on first event.
 *   - Write failure mid-session.
 */

import * as net from "node:net";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Canonical list of events documented by pi at implementation time.
// Source: @earendil-works/pi-coding-agent@0.75.3 types.d.ts ExtensionAPI.on()
// overloads — all events reachable via the ExtensionAPI interface.
// The live docs at https://pi.dev/docs/latest/extensions are accessible
// but return a client-rendered SPA; the type definitions from the installed
// package are the authoritative machine-readable source.
// ---------------------------------------------------------------------------
const PI_EVENTS = [
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
  "tool_call",
  "tool_result",
  "user_bash",
  "input",
] as const;

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

  function markDead(reason: string, ctx?: ExtensionContext): void {
    transportDead = true;
    socket?.destroy();
    socket = null;
    warn(`transport error — event forwarding disabled for this session: ${reason}`, ctx);
  }

  function flushPending(ctx?: ExtensionContext): void {
    if (!socket || transportDead) return;
    for (const frame of pendingFrames) {
      socket.write(frame);
      // After each write, check whether the socket has been destroyed by the
      // peer (e.g. server close).  Node.js does not emit an error event in
      // this case; the socket is silently marked destroyed and write() returns
      // false without buffering.
      if (socket.destroyed) {
        pendingFrames.length = 0;
        markDead("socket closed by peer", ctx);
        return;
      }
    }
    pendingFrames.length = 0;
  }

  function ensureConnected(frame: string, ctx?: ExtensionContext): void {
    if (transportDead) return;

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
      // Connected.
      connecting = false;
      socket = sock;
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

  // Register a handler for every documented pi event.
  // Cast is required because ExtensionAPI.on() uses individual overloads per
  // event name rather than a general string → handler signature.
  const piGeneric = pi as unknown as {
    on(event: string, handler: (event: unknown, ctx: ExtensionContext) => void): void;
  };
  for (const name of PI_EVENTS) {
    piGeneric.on(name, handleEvent(name));
  }
}
