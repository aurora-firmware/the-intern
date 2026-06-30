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
  /** Fire a fake event synchronously and await all handlers using an empty ctx. */
  emit(event: string, data: unknown): Promise<void>;
  /** Fire a fake event synchronously and await all handlers using the provided ctx. */
  emitWithCtx(event: string, data: unknown, ctx: ExtensionContext): Promise<void>;
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
    async emitWithCtx(event: string, data: unknown, ctx: ExtensionContext) {
      const list = handlers.get(event) ?? [];
      for (const h of list) {
        await h(data, ctx);
      }
    },
  };
}

/**
 * Build a minimal ExtensionContext stub with a spy on ui.notify.
 * The returned object satisfies the shape bob.ts needs: ctx?.ui is truthy and
 * ctx.ui.notify is a callable function.
 */
function makeCtxWithUi(): { ctx: ExtensionContext; notifySpy: ReturnType<typeof vi.fn> } {
  const notifySpy = vi.fn();
  const ctx = {
    ui: {
      notify: notifySpy,
    },
  } as unknown as ExtensionContext;
  return { ctx, notifySpy };
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

// ---------------------------------------------------------------------------
// T-044 AC-1: ctx.ui.notify branch — ctx.ui present → exactly one notify call
// and zero stderr writes per warning path.
// ---------------------------------------------------------------------------

describe("T-044 AC-1: ctx.ui.notify branch — connect failure with ctx.ui present", () => {
  it("calls ctx.ui.notify exactly once and writes nothing to stderr when UDS connect fails", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    // Point at a socket path that has no server listening so the connect fails.
    process.env.BOB_EXTENSION_SOCK_PATH = path.join(tmpDir, "nonexistent.sock");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { ctx, notifySpy } = makeCtxWithUi();
    const pi = makeStubPi();

    bobFactory(pi as any);

    // Fire an event with a ctx that has ctx.ui; this ctx propagates through
    // handleEvent → ensureConnected → markDead → warn.
    await pi.emitWithCtx("session_start", { type: "session_start", reason: "startup" }, ctx);

    // Allow the async connect error to propagate.
    await new Promise((r) => setTimeout(r, 100));

    // Exactly one ctx.ui.notify call carrying the warning.
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]![1]).toBe("warning");

    // Zero writes to process.stderr because ui.notify was used instead.
    expect(stderrSpy).toHaveBeenCalledTimes(0);

    stderrSpy.mockRestore();
  });
});

describe("T-044 AC-1: ctx.ui.notify branch — socket.write false with ctx.ui present", () => {
  it("calls ctx.ui.notify exactly once and writes nothing to stderr when socket.write returns false", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // First event — establishes the connection via the empty-ctx path so that
    // socket.write patching applies to the second event only.
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    // Patch socket.write to return false for the next call only.
    const originalWrite = net.Socket.prototype.write;
    net.Socket.prototype.write = function (..._args: unknown[]) {
      net.Socket.prototype.write = originalWrite;
      return false as any;
    };

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { ctx, notifySpy } = makeCtxWithUi();

    // Second event — write returns false; markDead fires with the provided ctx.
    await pi.emitWithCtx("agent_start", { type: "agent_start" }, ctx);
    await new Promise((r) => setTimeout(r, 100));

    // Exactly one ctx.ui.notify call carrying the warning.
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]![1]).toBe("warning");

    // Zero writes to process.stderr because ui.notify was used instead.
    expect(stderrSpy).toHaveBeenCalledTimes(0);

    stderrSpy.mockRestore();
    net.Socket.prototype.write = originalWrite; // safety restore
    await server.close();
  });
});

describe("T-044 AC-1: ctx.ui.notify branch — pendingFrames cap breach with ctx.ui present", () => {
  it("calls ctx.ui.notify exactly once and writes nothing to stderr when pendingFrames cap is exceeded", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { ctx, notifySpy } = makeCtxWithUi();

    bobFactory(pi as any);

    // Fire CAP + 1 events synchronously with ctx.ui; the cap guard fires with
    // the last ctx that arrived — the same ctx object in every call here.
    const eventCount = PENDING_FRAMES_CAP + 1;
    for (let i = 0; i < eventCount; i++) {
      void pi.emitWithCtx("session_start", { index: i }, ctx);
    }

    // Allow async connect and flush to settle.
    await new Promise((r) => setTimeout(r, 200));

    // Exactly one ctx.ui.notify call for the cap breach.
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]![1]).toBe("warning");

    // Zero writes to process.stderr because ui.notify was used instead.
    expect(stderrSpy).toHaveBeenCalledTimes(0);

    stderrSpy.mockRestore();
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// T-044 AC-2: ctx.ui absent — existing behaviour still passes (stderr write).
// These describe blocks explicitly label the coverage already present via the
// earlier describe blocks above; they add one additional assertion per path
// that makes the AC-2 contract unambiguous.
// ---------------------------------------------------------------------------

describe("T-044 AC-2: ctx.ui absent — connect failure falls back to stderr", () => {
  it("writes exactly one line to stderr and calls no ui.notify when UDS connect fails without ctx.ui", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = path.join(tmpDir, "nonexistent.sock");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // emit() passes {} as ExtensionContext — no ui property present.
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await new Promise((r) => setTimeout(r, 100));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
  });
});

describe("T-044 AC-2: ctx.ui absent — socket.write false falls back to stderr", () => {
  it("writes exactly one line to stderr and calls no ui.notify when socket.write returns false without ctx.ui", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    const originalWrite = net.Socket.prototype.write;
    net.Socket.prototype.write = function (..._args: unknown[]) {
      net.Socket.prototype.write = originalWrite;
      return false as any;
    };

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // emit() passes {} as ExtensionContext — no ui property present.
    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 100));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
    net.Socket.prototype.write = originalWrite;
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// T-057: Blocking tool_call authorization hook.
//
// Helper: createAuthzServer — a bidirectional UDS server that:
//   - Collects inbound NDJSON lines (same as createTestServer)
//   - Allows the test to push AuthzVerdict frames back to the connected client
// ---------------------------------------------------------------------------

async function createAuthzServer(serverSockPath: string): Promise<{
  close(): Promise<void>;
  lines(): string[];
  /** Send a structured AuthzVerdict frame matching the Rust wire format. */
  sendVerdict(verdict: {
    kind: "authz_verdict";
    session: string;
    verdict: { allow: boolean; reason?: string | null };
  }): void;
  sendRaw(data: string): void;
}> {
  const received: string[] = [];
  let buffer = "";
  const connections = new Set<net.Socket>();
  let activeConn: net.Socket | null = null;

  const server = net.createServer((conn) => {
    connections.add(conn);
    activeConn = conn;
    conn.once("close", () => {
      connections.delete(conn);
      if (activeConn === conn) activeConn = null;
    });
    conn.setEncoding("utf8");
    conn.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      for (let i = 0; i < parts.length - 1; i++) {
        if (parts[i]!.length > 0) received.push(parts[i]!);
      }
      buffer = parts[parts.length - 1]!;
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(serverSockPath, resolve);
  });

  return {
    close(): Promise<void> {
      for (const conn of connections) conn.destroy();
      connections.clear();
      return new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    },
    lines() {
      return received;
    },
    sendVerdict(verdict) {
      if (activeConn && !activeConn.destroyed) {
        activeConn.write(JSON.stringify(verdict) + "\n");
      }
    },
    sendRaw(data: string) {
      if (activeConn && !activeConn.destroyed) {
        activeConn.write(data);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// AC-1: tool_call hook sends Authz frame with correct shape.
// ---------------------------------------------------------------------------

describe("T-057 AC-1: tool_call hook sends Authz frame", () => {
  it("sends an authz frame carrying session, tool, and arguments when tool_call fires", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // Fire the tool_call event without awaiting the handler fully (the handler
    // blocks on a verdict).  We set a fast timeout so it resolves quickly.
    process.env.BOB_AUTHZ_TIMEOUT_MS = "200";

    const handlerPromise = pi.emit("tool_call", {
      type: "tool_call",
      toolCallId: "call-001",
      toolName: "bash",
      input: { command: "echo hello" },
    });

    // Wait for the authz frame to arrive on the server side.
    await waitUntil(() => server.lines().length >= 1);

    const frame = JSON.parse(server.lines()[0]!);
    expect(frame.kind).toBe("authz");
    expect(frame.session).toBe(SESSION_ID);
    expect(frame.tool).toBe("bash");
    expect(frame.arguments).toEqual({ command: "echo hello" });

    // Let the handler resolve via timeout (fail-closed is fine for this test).
    await handlerPromise;
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;

    await server.close();
  });
});

// ---------------------------------------------------------------------------
// AC-2: allow verdict lets the call proceed.
// ---------------------------------------------------------------------------

describe("T-057 AC-2: allow verdict permits tool call", () => {
  it("returns block:false when AuthzVerdict with allow:true arrives within timeout", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "500";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // Capture handler return value via a custom emit that returns the result.
    let handlerResult: unknown = undefined;
    const handlers = pi.handlers.get("tool_call") ?? [];
    expect(handlers.length).toBe(1);

    const toolCallEvent = {
      type: "tool_call",
      toolCallId: "call-002",
      toolName: "read",
      input: { file_path: "/etc/hosts" },
    };

    // Start the handler but don't await it yet.
    const handlerPromise = handlers[0]!(toolCallEvent, {} as ExtensionContext);

    // Wait for the authz frame, then send back an allow verdict.
    await waitUntil(() => server.lines().length >= 1);
    server.sendVerdict({ kind: "authz_verdict", session: SESSION_ID, verdict: { allow: true, reason: null } });

    handlerResult = await handlerPromise;

    // allow verdict → block should be false (or absent / falsy).
    expect((handlerResult as any)?.block).toBeFalsy();

    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// AC-3a: block verdict denies the call.
// ---------------------------------------------------------------------------

describe("T-057 AC-3a: block verdict denies tool call", () => {
  it("returns block:true and logs one warning when AuthzVerdict has allow:false", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "500";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    const handlers = pi.handlers.get("tool_call") ?? [];
    const toolCallEvent = {
      type: "tool_call",
      toolCallId: "call-003",
      toolName: "write",
      input: { file_path: "/etc/passwd", content: "evil" },
    };

    const handlerPromise = handlers[0]!(toolCallEvent, {} as ExtensionContext);

    await waitUntil(() => server.lines().length >= 1);
    server.sendVerdict({ kind: "authz_verdict", session: SESSION_ID, verdict: { allow: false, reason: null } });

    const result = await handlerPromise;

    expect((result as any)?.block).toBe(true);
    // One warning logged for the block verdict.
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// AC-3b: timeout fails closed (block + one warning).
// ---------------------------------------------------------------------------

describe("T-057 AC-3b: timeout fails closed", () => {
  it("returns block:true and logs one warning when no verdict arrives within the timeout", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "100";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    const handlers = pi.handlers.get("tool_call") ?? [];
    const toolCallEvent = {
      type: "tool_call",
      toolCallId: "call-004",
      toolName: "bash",
      input: { command: "rm -rf /" },
    };

    // Do NOT send a verdict — let the timeout fire.
    const result = await handlers[0]!(toolCallEvent, {} as ExtensionContext);

    expect((result as any)?.block).toBe(true);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// AC-3c: unparseable verdict fails closed.
// ---------------------------------------------------------------------------

describe("T-057 AC-3c: unparseable verdict fails closed", () => {
  it("returns block:true and logs one warning when the verdict frame is not valid JSON", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "500";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    const handlers = pi.handlers.get("tool_call") ?? [];
    const toolCallEvent = {
      type: "tool_call",
      toolCallId: "call-005",
      toolName: "grep",
      input: { pattern: "secret", path: "." },
    };

    const handlerPromise = handlers[0]!(toolCallEvent, {} as ExtensionContext);

    // Wait for the authz frame, then send back garbage (not valid JSON).
    await waitUntil(() => server.lines().length >= 1);
    server.sendRaw("this is not json\n");

    const result = await handlerPromise;

    expect((result as any)?.block).toBe(true);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// AC-3d: transport failure fails closed (block + one warning).
// ---------------------------------------------------------------------------

describe("T-057 AC-3d: transport failure fails closed", () => {
  it("returns block:true and logs one warning when the server closes the connection without a verdict", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "500";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    const handlers = pi.handlers.get("tool_call") ?? [];
    const toolCallEvent = {
      type: "tool_call",
      toolCallId: "call-006",
      toolName: "bash",
      input: { command: "cat /etc/shadow" },
    };

    const handlerPromise = handlers[0]!(toolCallEvent, {} as ExtensionContext);

    // Wait for the authz frame, then close the server (transport failure).
    await waitUntil(() => server.lines().length >= 1);
    await server.close();

    const result = await handlerPromise;

    expect((result as any)?.block).toBe(true);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
  });
});

// ---------------------------------------------------------------------------
// B-016 regression: extension must accept structured authz_verdict frames.
//
// The Rust service sends verdict as a structured JSON object:
//   {"allow": bool, "reason": string|null}
// NOT as a plain string "allow" or "block".
// These tests assert the correct behaviour for all three cases:
// structured allow, structured block with reason, and malformed verdict.
// ---------------------------------------------------------------------------

describe("B-016 regression: structured verdict {allow:true} permits tool call", () => {
  it("returns block:false when the service sends verdict:{allow:true,reason:null}", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "500";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    const handlers = pi.handlers.get("tool_call") ?? [];
    const handlerPromise = handlers[0]!(
      { type: "tool_call", toolCallId: "b016-001", toolName: "read", input: { file_path: "/tmp/x" } },
      {} as ExtensionContext,
    );

    await waitUntil(() => server.lines().length >= 1);
    // Send the exact Rust wire format: verdict is a structured object.
    server.sendRaw(
      JSON.stringify({ kind: "authz_verdict", session: SESSION_ID, verdict: { allow: true, reason: null } }) + "\n",
    );

    const result = await handlerPromise;
    expect((result as any)?.block).toBeFalsy();

    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
    await server.close();
  });
});

describe("B-016 regression: structured verdict {allow:false} surfaces policy reason", () => {
  it("returns block:true and surfaces the policy reason from verdict.reason when allow:false", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "500";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    const handlers = pi.handlers.get("tool_call") ?? [];
    const handlerPromise = handlers[0]!(
      { type: "tool_call", toolCallId: "b016-002", toolName: "bash", input: { command: "rm -rf /" } },
      {} as ExtensionContext,
    );

    await waitUntil(() => server.lines().length >= 1);
    const policyReason = "no action rule permits tool 'bash' with the supplied arguments";
    server.sendRaw(
      JSON.stringify({
        kind: "authz_verdict",
        session: SESSION_ID,
        verdict: { allow: false, reason: policyReason },
      }) + "\n",
    );

    const result = await handlerPromise;
    expect((result as any)?.block).toBe(true);
    // The actual policy reason must be surfaced, not a hardcoded fallback.
    expect((result as any)?.reason).toBe(policyReason);

    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
    await server.close();
  });
});

describe("B-016 regression: malformed structured verdict (non-boolean allow) fails closed", () => {
  it("returns block:true on the error path when verdict.allow is not a boolean", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "500";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    const handlers = pi.handlers.get("tool_call") ?? [];
    const handlerPromise = handlers[0]!(
      { type: "tool_call", toolCallId: "b016-003", toolName: "bash", input: { command: "ls" } },
      {} as ExtensionContext,
    );

    await waitUntil(() => server.lines().length >= 1);
    // Send a verdict object with a non-boolean allow — malformed per the Rust contract.
    server.sendRaw(
      JSON.stringify({ kind: "authz_verdict", session: SESSION_ID, verdict: { allow: "yes", reason: null } }) + "\n",
    );

    const result = await handlerPromise;
    // Must fail closed (block: true, error path warning).
    expect((result as any)?.block).toBe(true);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// AC-3e: connect-time transport failure (no verdict) emits one warning.
// ---------------------------------------------------------------------------

describe("T-057 AC-3e: connect-time failure without verdict", () => {
  it("returns block:true and logs exactly one warning when the UDS connect fails before any verdict arrives", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = path.join(tmpDir, "not-listening.sock");
    process.env.BOB_AUTHZ_TIMEOUT_MS = "120";

    const pi = makeStubPi();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    const handlers = pi.handlers.get("tool_call") ?? [];
    const result = await handlers[0]!(
      {
        type: "tool_call",
        toolCallId: "call-006b",
        toolName: "bash",
        input: { command: "whoami" },
      },
      {} as ExtensionContext,
    );

    expect((result as any)?.block).toBe(true);
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
  });
});

// ---------------------------------------------------------------------------
// AC-4: BOB_AUTHZ_TIMEOUT_MS is respected; built-in default is used when absent.
// ---------------------------------------------------------------------------

describe("T-057 AC-4: BOB_AUTHZ_TIMEOUT_MS controls verdict timeout", () => {
  it("uses BOB_AUTHZ_TIMEOUT_MS when set, making the hook resolve after that many ms", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "150";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    const handlers = pi.handlers.get("tool_call") ?? [];

    const before = Date.now();
    const result = await handlers[0]!(
      { type: "tool_call", toolCallId: "call-007", toolName: "bash", input: { command: "ls" } },
      {} as ExtensionContext,
    );
    const elapsed = Date.now() - before;

    // Should have timed out around 150 ms (give ±100 ms margin).
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(500);
    expect((result as any)?.block).toBe(true);

    stderrSpy.mockRestore();
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
    await server.close();
  });

  it("applies the built-in default timeout when BOB_AUTHZ_TIMEOUT_MS is not set", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // Send an allow verdict immediately — if the default timeout is applied
    // (not zero), the handler should still resolve to allow within a reasonable
    // time once the verdict arrives.
    const handlers = pi.handlers.get("tool_call") ?? [];
    const toolCallEvent = {
      type: "tool_call",
      toolCallId: "call-008",
      toolName: "read",
      input: { file_path: "/tmp/test" },
    };

    const handlerPromise = handlers[0]!(toolCallEvent, {} as ExtensionContext);

    await waitUntil(() => server.lines().length >= 1);
    server.sendVerdict({ kind: "authz_verdict", session: SESSION_ID, verdict: { allow: true, reason: null } });

    const result = await handlerPromise;
    // Allow verdict with default timeout → should NOT block.
    expect((result as any)?.block).toBeFalsy();

    await server.close();
  });
});
