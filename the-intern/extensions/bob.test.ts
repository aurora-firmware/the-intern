/**
 * Round-trip tests for the bob extension (bob.ts).
 *
 * Strategy: spin up a real Unix domain socket in a temp directory, then invoke
 * the factory with a stub ExtensionAPI.  The stub lets each test fire a fake
 * event and then assert that the correct NDJSON frame arrived on the socket.
 *
 * Each test is independent — it creates its own temp dir and socket server so
 * there is no shared mutable state between test cases.
 */

import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Import the extension factory under test.
// ---------------------------------------------------------------------------
import bobFactory from "./bob.js";

// ---------------------------------------------------------------------------
// Stub ExtensionAPI
// ---------------------------------------------------------------------------

type EventHandler = (event: unknown, ctx: ExtensionContext) => void | Promise<void>;

interface StubPi {
  /** Handlers registered by the extension, keyed by event name. */
  handlers: Map<string, EventHandler[]>;
  /** The on() method the extension calls. */
  on(event: string, handler: EventHandler): void;
  /** Fire a fake event synchronously and await all handlers. */
  emit(event: string, data: unknown): Promise<void>;
}

function makeStubPi(): StubPi {
  const handlers = new Map<string, EventHandler[]>();
  return {
    handlers,
    on(event: string, handler: EventHandler) {
      if (!handlers.has(event)) handlers.set(event, []);
      handlers.get(event)!.push(handler);
    },
    async emit(event: string, data: unknown) {
      const list = handlers.get(event) ?? [];
      for (const h of list) {
        await h(data, {} as ExtensionContext);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Create a UDS server that collects all received bytes as lines.
 * Returns a handle with the socket path and a way to read collected lines.
 * The returned promise resolves once the server is fully listening.
 *
 * The server tracks all active connections so that close() can destroy them
 * immediately — without this, close() would wait for the bob extension's
 * persistent socket to close on its own, causing tests to time out.
 */
async function createTestServer(sockPath: string): Promise<{
  close(): Promise<void>;
  lines(): string[];
}> {
  const received: string[] = [];
  let buffer = "";
  const connections = new Set<net.Socket>();

  const server = net.createServer((conn) => {
    connections.add(conn);
    conn.once("close", () => connections.delete(conn));
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      // All but the last part are complete lines.
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i]!.length > 0) received.push(parts[i]!);
      }
      buffer = parts[parts.length - 1]!;
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, resolve);
  });

  return {
    close(): Promise<void> {
      // Destroy all active connections so the server can stop immediately.
      for (const conn of connections) conn.destroy();
      connections.clear();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    lines() {
      return received;
    },
  };
}

/** Wait until a predicate is true, polling every 5 ms for up to 500 ms. */
async function waitUntil(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("waitUntil timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;
let sockPath: string;
const SESSION_ID = "test-session-uuid-001";

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bob-test-"));
  sockPath = path.join(tmpDir, "extension.sock");
});

afterEach(() => {
  // Clean up temp dir.
  fs.rmSync(tmpDir, { recursive: true, force: true });
  // Restore env vars.
  delete process.env.BOB_SESSION_ID;
  delete process.env.BOB_EXTENSION_SOCK_PATH;
});

// ---------------------------------------------------------------------------
// AC-3: Missing env vars → one warning, no handlers registered.
// ---------------------------------------------------------------------------

describe("AC-3: missing env vars", () => {
  it("logs one warning and registers no handlers when BOB_SESSION_ID is absent", () => {
    delete process.env.BOB_SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pi = makeStubPi();

    bobFactory(pi as any);

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);
    expect(pi.handlers.size).toBe(0);

    stderrSpy.mockRestore();
  });

  it("logs one warning and registers no handlers when BOB_EXTENSION_SOCK_PATH is absent", () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    delete process.env.BOB_EXTENSION_SOCK_PATH;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pi = makeStubPi();

    bobFactory(pi as any);

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);
    expect(pi.handlers.size).toBe(0);

    stderrSpy.mockRestore();
  });

  it("logs one warning and registers no handlers when both env vars are absent", () => {
    delete process.env.BOB_SESSION_ID;
    delete process.env.BOB_EXTENSION_SOCK_PATH;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pi = makeStubPi();

    bobFactory(pi as any);

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);
    expect(pi.handlers.size).toBe(0);

    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// AC-1: All documented events are registered.
// ---------------------------------------------------------------------------

describe("AC-1: registers handlers for all pi events", () => {
  it("registers a handler for every documented pi event when env vars are set", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // The full canonical list from @earendil-works/pi-coding-agent types.
    const expectedEvents = [
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
    ];

    for (const name of expectedEvents) {
      expect(pi.handlers.has(name), `handler registered for "${name}"`).toBe(true);
    }

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// AC-2: Each event produces the correct NDJSON frame.
// ---------------------------------------------------------------------------

describe("AC-2: NDJSON frame shape", () => {
  it("writes one NDJSON line per event with correct kind, session, and payload", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    const eventData = { type: "session_start", reason: "startup" };
    await pi.emit("session_start", eventData);

    // Wait for the frame to arrive.
    await waitUntil(() => server.lines().length >= 1);

    const lines = server.lines();
    expect(lines).toHaveLength(1);

    const frame = JSON.parse(lines[0]!);
    expect(frame.kind).toBe("event");
    expect(frame.session).toBe(SESSION_ID);
    expect(frame.payload.event).toBe("session_start");
    expect(frame.payload.data).toEqual(eventData);

    await server.close();
  });

  it("writes separate NDJSON lines for two successive events", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    await pi.emit("agent_start", { type: "agent_start" });
    await pi.emit("agent_end", { type: "agent_end", messages: [] });

    await waitUntil(() => server.lines().length >= 2);

    const lines = server.lines();
    expect(lines).toHaveLength(2);

    const first = JSON.parse(lines[0]!);
    expect(first.payload.event).toBe("agent_start");

    const second = JSON.parse(lines[1]!);
    expect(second.payload.event).toBe("agent_end");

    await server.close();
  });

  it("frame is a single line terminated by \\n (no embedded newlines in JSON)", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1234 });

    await waitUntil(() => server.lines().length >= 1);
    const raw = server.lines()[0]!;
    // Confirm the raw string is valid JSON (no stray newlines break parsing).
    expect(() => JSON.parse(raw)).not.toThrow();

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// B-003-A: pendingFrames cap — queue > CAP events pre-connect → one warn,
// transportDead, ≤ CAP frames delivered.
// ---------------------------------------------------------------------------

/** The same cap the production code uses — must stay in sync with bob.ts. */
const PENDING_FRAMES_CAP = 64;

describe("B-003-A: pendingFrames cap (pre-connect)", () => {
  it("warns exactly once, kills transport, and delivers at most CAP frames when more than CAP events arrive before connect", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    // Start a real server so the UDS path exists and the OS-level handshake
    // can complete, but we fire all events synchronously before the connect
    // callback fires (it is always async on the event loop).
    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    // Fire CAP + 1 events synchronously — none awaited so the connect
    // callback has not had a chance to fire yet; all frames land in
    // pendingFrames (or get rejected by the cap guard).
    const eventCount = PENDING_FRAMES_CAP + 1;
    for (let i = 0; i < eventCount; i++) {
      // Use the non-awaited internal call path: emit returns a promise but we
      // do not await it so handlers run in the same microtask batch.
      void pi.emit("session_start", { index: i });
    }

    // Wait for the connection and flush to settle.
    await new Promise((r) => setTimeout(r, 200));

    // Exactly one warn for the cap breach.
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    // Transport is dead — subsequent events must be silent no-ops.
    const warnCountBefore = stderrSpy.mock.calls.length;
    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 50));
    expect(stderrSpy).toHaveBeenCalledTimes(warnCountBefore);

    // At most CAP frames were delivered to the server.
    expect(server.lines().length).toBeLessThanOrEqual(PENDING_FRAMES_CAP);

    stderrSpy.mockRestore();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// B-003-B: socket.write() back-pressure — write returns false → one warn,
// transport marked dead, subsequent events become no-ops.
// ---------------------------------------------------------------------------

describe("B-003-B: socket.write() back-pressure", () => {
  it("warns exactly once and marks transport dead when socket.write returns false", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // First event — establishes the connection.
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    // Monkey-patch the underlying Socket.write so the next call returns false.
    // We reach into the net module and intercept the prototype method only for
    // the duration of this assertion.
    const originalWrite = net.Socket.prototype.write;
    net.Socket.prototype.write = function (..._args: unknown[]) {
      // Restore immediately so only one call returns false.
      net.Socket.prototype.write = originalWrite;
      return false as any;
    };

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Second event — write returns false, markDead should fire.
    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 100));

    // Exactly one warn.
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    // Transport is dead — third event must be a silent no-op.
    const warnCountBefore = stderrSpy.mock.calls.length;
    await pi.emit("agent_end", { type: "agent_end", messages: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(stderrSpy).toHaveBeenCalledTimes(warnCountBefore);

    stderrSpy.mockRestore();
    net.Socket.prototype.write = originalWrite; // safety restore
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// AC-4: UDS connect failure → one warning, subsequent events are no-ops.
// ---------------------------------------------------------------------------

describe("AC-4: transport failure handling", () => {
  it("logs one warning when UDS is not listening and treats subsequent events as no-ops", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    // Point at a socket path that has no server listening.
    process.env.BOB_EXTENSION_SOCK_PATH = path.join(tmpDir, "nonexistent.sock");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // Fire an event to trigger the lazy connect.
    await pi.emit("session_start", { type: "session_start", reason: "startup" });

    // Allow the async connect error to propagate.
    await new Promise((r) => setTimeout(r, 100));

    // Exactly one warning should have been logged.
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    // Fire a second event — should be a silent no-op (no additional warnings).
    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 50));
    expect(stderrSpy).toHaveBeenCalledTimes(1);

    stderrSpy.mockRestore();
  });

  it("logs one warning on write failure and treats subsequent events as no-ops", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // First event — should succeed.
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    // Tear down the server to force write failures.
    await server.close();
    // Wait briefly for the OS to process the server closure.
    await new Promise((r) => setTimeout(r, 50));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Second event — the write should fail.
    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 100));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    // Third event — should be a silent no-op.
    await pi.emit("agent_end", { type: "agent_end", messages: [] });
    await new Promise((r) => setTimeout(r, 50));
    expect(stderrSpy).toHaveBeenCalledTimes(1);

    stderrSpy.mockRestore();
  });
});
