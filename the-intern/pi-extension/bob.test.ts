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
import bobFactory, { PI_EVENTS } from "./bob.js";

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
  delete process.env.BOB_SKILL_INSTALL_PATH;
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
// B-019 / B-003-B: socket.write() back-pressure is ordinary Node flow control,
// not a transport failure. write() returning false must NOT warn or mark the
// transport dead; frames queued while waiting for 'drain' must be delivered
// once the buffer clears.
// ---------------------------------------------------------------------------

describe("B-003-B: socket.write() back-pressure is not fatal", () => {
  it("does not warn or mark the transport dead when socket.write returns false, and flushes queued frames once 'drain' fires", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // First event — establishes the connection.
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    // Force the next socket.write() call to report back-pressure (false)
    // without delivering the frame, and capture the live socket instance so
    // the test can fire a synthetic 'drain' event without needing to
    // genuinely fill the kernel send buffer.
    let capturedSocket: net.Socket | undefined;
    const originalWrite = net.Socket.prototype.write;
    net.Socket.prototype.write = function (this: net.Socket, ..._args: unknown[]) {
      capturedSocket = this;
      // Restore immediately so only this one call reports back-pressure.
      net.Socket.prototype.write = originalWrite;
      return false as any;
    };

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // Second event — write() returns false. Must NOT warn or mark dead.
    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 50));

    expect(stderrSpy).not.toHaveBeenCalled();

    // Third event — arrives while still waiting for 'drain'. write() (now
    // restored to the real implementation) must not be invoked for it yet;
    // it stays queued instead of reaching the server.
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: 1 });
    await new Promise((r) => setTimeout(r, 50));

    expect(server.lines().length).toBe(1);
    expect(stderrSpy).not.toHaveBeenCalled();

    // Simulate the kernel send buffer clearing.
    expect(capturedSocket).toBeDefined();
    capturedSocket!.emit("drain");

    // The queued turn_start frame is flushed once 'drain' fires.
    await waitUntil(() => server.lines().length >= 2);
    const frame = JSON.parse(server.lines()[1]!);
    expect(frame.payload.event).toBe("turn_start");

    // Still no warnings — the transport was healthy throughout.
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
    net.Socket.prototype.write = originalWrite; // safety restore
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// B-019: the pendingFrames cap also bounds the post-connect drain-wait queue,
// but — unlike the pre-connect queue (B-003-A) — it must NOT kill the
// transport. pendingFrames is a single FIFO shared by ordinary event frames
// and authz frames (handleToolCall calls ensureConnected exactly like
// handleEvent does), so treating a sustained event burst as a fatal
// transport error would permanently disable tool-call authorization for the
// rest of the session — reintroducing the bug's own symptom at a higher
// threshold. The post-connect policy instead warns once and drops the
// oldest queued EVENT frames (FIFO) to bound memory, leaving the socket
// alive so any already-queued or future authz frame still flushes once
// 'drain' fires; S-004's 5-second BOB_AUTHZ_TIMEOUT_MS remains the
// designed fail-closed backstop for an authz frame whose peer never drains.
// ---------------------------------------------------------------------------

describe("B-019: pendingFrames cap also bounds the post-connect drain-wait queue", () => {
  it("warns once, drops the oldest queued event frames, and keeps the transport alive when more than CAP frames queue up while waiting for drain", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // First event — establishes the connection.
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    // Force the next write to report back-pressure and capture the live
    // socket so the test can fire a synthetic 'drain' event later — the
    // peer is unresponsive for an extended period, not merely transiently
    // slow, but the transport must still survive it.
    let capturedSocket: net.Socket | undefined;
    const originalWrite = net.Socket.prototype.write;
    net.Socket.prototype.write = function (this: net.Socket, ..._args: unknown[]) {
      capturedSocket = this;
      net.Socket.prototype.write = originalWrite;
      return false as any;
    };

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // This event triggers the back-pressure signal (write() returns false);
    // 'drain' will not fire until the test simulates it below.
    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 50));
    expect(stderrSpy).not.toHaveBeenCalled();

    // Queue more than CAP additional event frames while still waiting for
    // drain — a realistic burst of large/rapid pi events (e.g. per-chunk
    // message_update) is the bug's own documented trigger scenario.
    const overflow = 5;
    const eventCount = PENDING_FRAMES_CAP + overflow;
    for (let i = 0; i < eventCount; i++) {
      void pi.emit("turn_start", { turnIndex: i });
    }
    await new Promise((r) => setTimeout(r, 200));

    // Exactly one warning for the cap breach — a distinct, quiet-degradation
    // warning, NOT the fatal "transport error" wording markDead uses.
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);
    expect(stderrSpy.mock.calls[0]![0]).not.toMatch(/transport error/i);

    // Simulate the kernel send buffer finally clearing. If the transport had
    // been marked dead, flushPending would refuse to deliver anything here;
    // the frames arriving below is the proof the socket stayed alive.
    expect(capturedSocket).toBeDefined();
    capturedSocket!.emit("drain");

    // session_start + the CAP frames retained after dropping the oldest
    // `overflow` turn_start frames.
    await waitUntil(() => server.lines().length >= 1 + PENDING_FRAMES_CAP);
    const lines = server.lines();
    expect(lines.length).toBe(1 + PENDING_FRAMES_CAP);

    // The oldest `overflow` turn_start frames (indices 0..overflow-1) were
    // dropped; the surviving frames are the newest CAP ones, still in order.
    const turnStartIndices = lines.slice(1).map((line) => JSON.parse(line).payload.data.turnIndex);
    expect(turnStartIndices[0]).toBe(overflow);
    expect(turnStartIndices[turnStartIndices.length - 1]).toBe(eventCount - 1);

    // No additional warning was needed to drop the remaining overflow.
    expect(stderrSpy).toHaveBeenCalledTimes(1);

    stderrSpy.mockRestore();
    net.Socket.prototype.write = originalWrite; // safety restore
    await server.close();
  });
});

// ---------------------------------------------------------------------------
// B-019: an authz frame queued behind a sustained post-connect event backlog
// must still be delivered and its verdict honored once 'drain' fires — the
// event-only cap eviction above must not touch the authz frame, and hitting
// the cap must not mark the transport dead (which would fail every future
// tool call with "transport is dead" instead of letting a real verdict
// arrive).
// ---------------------------------------------------------------------------

describe("B-019: authz frame survives a post-connect event backlog that exceeds the cap", () => {
  it("delivers and honors the verdict for an authz frame queued behind a CAP-exceeding event backlog once drain fires", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "2000";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    // First event — establishes the connection.
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    // Force the next write to report back-pressure and capture the live
    // socket so the test can fire a synthetic 'drain' event later.
    let capturedSocket: net.Socket | undefined;
    const originalWrite = net.Socket.prototype.write;
    net.Socket.prototype.write = function (this: net.Socket, ..._args: unknown[]) {
      capturedSocket = this;
      net.Socket.prototype.write = originalWrite;
      return false as any;
    };

    // This event triggers the back-pressure signal (write() returns false).
    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 50));
    expect(stderrSpy).not.toHaveBeenCalled();

    // Queue a CAP-exceeding backlog of pure event frames while backpressured.
    const eventCount = PENDING_FRAMES_CAP + 5;
    for (let i = 0; i < eventCount; i++) {
      void pi.emit("turn_start", { turnIndex: i });
    }
    await new Promise((r) => setTimeout(r, 200));

    // The cap-breach warning fired once already, for the event-only backlog.
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).not.toMatch(/transport error/i);

    // Now fire a tool_call — its authz frame is enqueued behind the
    // CAP-deep event backlog. Enqueuing it must evict an oldest EVENT frame
    // (not itself) to make room, since pendingFrames is still at the cap.
    const handlers = pi.handlers.get("tool_call") ?? [];
    const handlerPromise = handlers[0]!(
      { type: "tool_call", toolCallId: "b019-backlog-001", toolName: "read", input: { file_path: "/tmp/x" } },
      {} as ExtensionContext,
    );

    // No second (fatal) warning was triggered by queuing the authz frame.
    expect(stderrSpy).toHaveBeenCalledTimes(1);

    // Simulate the kernel send buffer clearing so the full backlog — ending
    // with the authz frame — flushes to the server.
    expect(capturedSocket).toBeDefined();
    capturedSocket!.emit("drain");

    await waitUntil(() => server.lines().some((line) => JSON.parse(line).kind === "authz"));
    const authzLine = server.lines().find((line) => JSON.parse(line).kind === "authz")!;
    const authzFrame = JSON.parse(authzLine);
    expect(authzFrame.kind).toBe("authz");
    expect(authzFrame.tool).toBe("read");

    server.sendVerdict({ kind: "authz_verdict", session: SESSION_ID, verdict: { allow: true, reason: null } });

    const result = await handlerPromise;

    // The verdict was honored — the transport was never marked dead, so the
    // authz call was not short-circuited with "transport is dead".
    expect((result as any)?.block).toBeFalsy();
    expect((result as any)?.reason).not.toBe("transport is dead");

    // Still exactly one warning for the whole scenario — the quiet
    // event-eviction warning, never a fatal transport-dead warning.
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).not.toMatch(/transport error/i);

    stderrSpy.mockRestore();
    net.Socket.prototype.write = originalWrite; // safety restore
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
    await server.close();
  });

  it("fails closed only the evicted authz call when an all-authz post-connect backlog exceeds the cap", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "2000";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    let capturedSocket: net.Socket | undefined;
    const originalWrite = net.Socket.prototype.write;
    net.Socket.prototype.write = function (this: net.Socket, ..._args: unknown[]) {
      capturedSocket = this;
      net.Socket.prototype.write = originalWrite;
      return false as any;
    };

    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 50));

    const handlers = pi.handlers.get("tool_call") ?? [];
    const calls: Promise<unknown>[] = [];
    for (let i = 0; i < PENDING_FRAMES_CAP + 1; i++) {
      calls.push(
        Promise.resolve(
          handlers[0]!(
            {
              type: "tool_call",
              toolCallId: `b019-authz-overflow-${i}`,
              toolName: `tool-${i}`,
              input: { index: i },
            },
            {} as ExtensionContext,
          )
        )
      );
    }

    const firstResult = await calls[0]!;
    expect((firstResult as any)?.block).toBe(true);
    expect((firstResult as any)?.reason).toBe("authz queue overflow");
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).not.toMatch(/transport error/i);

    expect(capturedSocket).toBeDefined();
    capturedSocket!.emit("drain");

    await waitUntil(() => server.lines().filter((line) => JSON.parse(line).kind === "authz").length >= PENDING_FRAMES_CAP);
    const authzFrames = server.lines()
      .map((line) => JSON.parse(line))
      .filter((frame) => frame.kind === "authz");
    expect(authzFrames).toHaveLength(PENDING_FRAMES_CAP);
    expect(authzFrames[0]!.tool).toBe("tool-1");
    expect(authzFrames.at(-1)!.tool).toBe(`tool-${PENDING_FRAMES_CAP}`);

    for (let i = 1; i <= PENDING_FRAMES_CAP; i++) {
      server.sendVerdict({
        kind: "authz_verdict",
        session: SESSION_ID,
        verdict: { allow: i % 2 === 0, reason: i % 2 === 0 ? null : `deny-${i}` },
      });
    }

    const remainingResults = await Promise.all(calls.slice(1));
    for (let i = 1; i <= PENDING_FRAMES_CAP; i++) {
      const result = remainingResults[i - 1] as any;
      if (i % 2 === 0) {
        expect(result?.block).toBeFalsy();
      } else {
        expect(result?.block).toBe(true);
        expect(result?.reason).toBe(`deny-${i}`);
      }
    }

    stderrSpy.mockRestore();
    net.Socket.prototype.write = originalWrite; // safety restore
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
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

describe("T-044 AC-1: ctx.ui.notify branch — genuine transport failure with ctx.ui present", () => {
  it("calls ctx.ui.notify exactly once and writes nothing to stderr when the socket errors after the server closes", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    // First event — establishes the connection via the empty-ctx path.
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    // Tear down the server to force a genuine write failure (EPIPE/ECONNRESET)
    // — not the ordinary back-pressure signal (write() === false), which no
    // longer warns or kills the transport (see B-003-B).
    await server.close();
    await new Promise((r) => setTimeout(r, 50));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const { ctx, notifySpy } = makeCtxWithUi();

    // Second event — the write fails with a genuine socket error; markDead
    // fires with the provided ctx.
    await pi.emitWithCtx("agent_start", { type: "agent_start" }, ctx);
    await new Promise((r) => setTimeout(r, 100));

    // Exactly one ctx.ui.notify call carrying the warning.
    expect(notifySpy).toHaveBeenCalledTimes(1);
    expect(notifySpy.mock.calls[0]![1]).toBe("warning");

    // Zero writes to process.stderr because ui.notify was used instead.
    expect(stderrSpy).toHaveBeenCalledTimes(0);

    stderrSpy.mockRestore();
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

describe("T-044 AC-2: ctx.ui absent — genuine transport failure falls back to stderr", () => {
  it("writes exactly one line to stderr and calls no ui.notify when the socket errors after the server closes, without ctx.ui", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;

    const server = await createTestServer(sockPath);
    const pi = makeStubPi();

    bobFactory(pi as any);

    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    // Tear down the server to force a genuine write failure (EPIPE/ECONNRESET)
    // — not the ordinary back-pressure signal (write() === false), which no
    // longer warns or kills the transport (see B-003-B).
    await server.close();
    await new Promise((r) => setTimeout(r, 50));

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    // emit() passes {} as ExtensionContext — no ui property present.
    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 100));

    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
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

describe("B-016 regression: top-level non-object verdict frame fails closed without crashing", () => {
  it("resolves to the error path promptly when the frame is the JSON literal null", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    // Generous timeout so a prompt resolution proves the synchronous error path
    // was taken rather than the verdict timeout. Before the top-level guard,
    // reading frame.kind off null threw inside the socket data handler and the
    // tool call was only released by this timeout (if at all).
    process.env.BOB_AUTHZ_TIMEOUT_MS = "2000";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    const handlers = pi.handlers.get("tool_call") ?? [];
    const handlerPromise = handlers[0]!(
      { type: "tool_call", toolCallId: "b016-004", toolName: "bash", input: { command: "ls" } },
      {} as ExtensionContext,
    );

    await waitUntil(() => server.lines().length >= 1);
    // A bare `null` is valid JSON; it must fail closed, not throw.
    const before = Date.now();
    server.sendRaw("null\n");

    const result = await handlerPromise;
    const elapsed = Date.now() - before;

    // Fail closed via the synchronous error path, well before the 2000ms timeout.
    expect((result as any)?.block).toBe(true);
    expect(elapsed).toBeLessThan(1000);
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
// B-019 regression: a tool_call after ordinary write() back-pressure is still
// authorized (verdict honored), not short-circuited with "transport is dead".
// ---------------------------------------------------------------------------

describe("B-019 regression: tool_call stays authorized after write() back-pressure", () => {
  it("honors an allow verdict for a tool_call sent after a write() === false event, once queued frames flush on drain", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_AUTHZ_TIMEOUT_MS = "2000";

    const server = await createAuthzServer(sockPath);
    const pi = makeStubPi();
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    bobFactory(pi as any);

    // First event — establishes the connection.
    await pi.emit("session_start", { type: "session_start", reason: "startup" });
    await waitUntil(() => server.lines().length >= 1);

    // Force the next write to report back-pressure and capture the live
    // socket so the test can fire a synthetic 'drain' event.
    let capturedSocket: net.Socket | undefined;
    const originalWrite = net.Socket.prototype.write;
    net.Socket.prototype.write = function (this: net.Socket, ..._args: unknown[]) {
      capturedSocket = this;
      net.Socket.prototype.write = originalWrite;
      return false as any;
    };

    // Second event — write() returns false. Must not warn or kill transport.
    await pi.emit("agent_start", { type: "agent_start" });
    await new Promise((r) => setTimeout(r, 50));
    expect(stderrSpy).not.toHaveBeenCalled();

    // A tool_call fired now queues its authz frame behind the back-pressure
    // signal rather than being rejected outright.
    const handlers = pi.handlers.get("tool_call") ?? [];
    const handlerPromise = handlers[0]!(
      { type: "tool_call", toolCallId: "b019-001", toolName: "read", input: { file_path: "/tmp/x" } },
      {} as ExtensionContext,
    );

    // Simulate the kernel send buffer clearing so the queued authz frame
    // flushes to the server.
    expect(capturedSocket).toBeDefined();
    capturedSocket!.emit("drain");

    await waitUntil(() => server.lines().length >= 2);
    const authzFrame = JSON.parse(server.lines()[1]!);
    expect(authzFrame.kind).toBe("authz");

    server.sendVerdict({ kind: "authz_verdict", session: SESSION_ID, verdict: { allow: true, reason: null } });

    const result = await handlerPromise;

    // The verdict was honored — not short-circuited by "transport is dead".
    expect((result as any)?.block).toBeFalsy();
    expect((result as any)?.reason).not.toBe("transport is dead");
    expect(stderrSpy).not.toHaveBeenCalled();

    stderrSpy.mockRestore();
    net.Socket.prototype.write = originalWrite; // safety restore
    delete process.env.BOB_AUTHZ_TIMEOUT_MS;
    await server.close();
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

// ---------------------------------------------------------------------------
// T-160 AC-1: resources_discover is no longer forwarded through the generic
// fire-and-forget PI_EVENTS event-loop registration — it gets its own
// dedicated handler instead (see the describe blocks below).
// ---------------------------------------------------------------------------

describe("T-160 AC-1: resources_discover removed from generic PI_EVENTS list", () => {
  it("does not include resources_discover in the exported PI_EVENTS array", () => {
    expect(PI_EVENTS).not.toContain("resources_discover");
  });
});

// ---------------------------------------------------------------------------
// T-160 AC-3: absent or empty BOB_SKILL_INSTALL_PATH contributes no skill
// paths, logs one warning, and does not throw or block session init.
// ---------------------------------------------------------------------------

describe("T-160 AC-3: absent or empty BOB_SKILL_INSTALL_PATH contributes no skill paths", () => {
  it("contributes no skill paths and logs one warning when BOB_SKILL_INSTALL_PATH is unset", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    delete process.env.BOB_SKILL_INSTALL_PATH;

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pi = makeStubPi();

    bobFactory(pi as any);

    const handlers = pi.handlers.get("resources_discover") ?? [];
    expect(handlers.length).toBe(1);

    const result = await handlers[0]!(
      { type: "resources_discover", cwd: tmpDir, reason: "startup" },
      {} as ExtensionContext
    );

    expect((result as any)?.skillPaths).toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
  });

  it("contributes no skill paths and logs one warning when BOB_SKILL_INSTALL_PATH is empty", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_SKILL_INSTALL_PATH = "";

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pi = makeStubPi();

    bobFactory(pi as any);

    const handlers = pi.handlers.get("resources_discover") ?? [];
    const result = await handlers[0]!(
      { type: "resources_discover", cwd: tmpDir, reason: "startup" },
      {} as ExtensionContext
    );

    expect((result as any)?.skillPaths).toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// T-160 AC-4: a BOB_SKILL_INSTALL_PATH naming a path that does not exist on
// disk contributes no skill paths, logs one warning, and does not throw or
// block session init.
// ---------------------------------------------------------------------------

describe("T-160 AC-4: nonexistent BOB_SKILL_INSTALL_PATH contributes no skill paths", () => {
  it("contributes no skill paths and logs one warning when the path does not exist on disk", async () => {
    process.env.BOB_SESSION_ID = SESSION_ID;
    process.env.BOB_EXTENSION_SOCK_PATH = sockPath;
    process.env.BOB_SKILL_INSTALL_PATH = path.join(tmpDir, "does-not-exist");

    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const pi = makeStubPi();

    bobFactory(pi as any);

    const handlers = pi.handlers.get("resources_discover") ?? [];
    const result = await handlers[0]!(
      { type: "resources_discover", cwd: tmpDir, reason: "startup" },
      {} as ExtensionContext
    );

    expect((result as any)?.skillPaths).toBeUndefined();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    expect(stderrSpy.mock.calls[0]![0]).toMatch(/warn/i);

    stderrSpy.mockRestore();
  });
});
