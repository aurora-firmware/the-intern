/**
 * Control operations on a closed conversation (S-001 REQ-026, REQ-008, REQ-011; S-002 REQ-012; ADR-001 decision 4):
 * submit in any busy mode, withdraw, abort, reset and compact are refused `conflict` with a message naming the
 * conversation as closed, and the abort of an open conversation leaves the job's section free while it waits.
 */
import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type Models, Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { createLogger } from "../../src/daemon/logger.ts";
import { submissionState, submitInput } from "../../src/host/conversation_control.ts";
import { type HarnessHost, type HostEntry, openHarnessHost } from "../../src/host/harness_host.ts";
import { abortJobConversations } from "../../src/host/invocation.ts";
import { createSeatedConversation, readConversationMeta, type SeatActor } from "../../src/host/seating.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { conversationControlOperations } from "../../src/service/conversation_control_operations.ts";
import { type Caller, createCatalogue, ServiceError } from "../../src/service/operations.ts";
import { createFakeModel, type FakeReply } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const BUSY_DELAY_MS = 400;
const caller: Caller = { actor: { kind: "team_member" } };
const actor: SeatActor = { kind: "agent", conversationId: "1", role: "lead" };
const BUSY_MODES = ["followUp", "steer", "reject"];

const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const fakes: { unregister(): void }[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await pause(POLL_MS);
    }
}

function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

function modelsFor(fake: ReturnType<typeof createFakeModel>): Models {
    const implementation = getApiProvider(fake.api);
    assert.ok(implementation, "the fake model's api is registered");
    const models = createModels();
    models.setProvider(
        createProvider({
            id: fake.getModel().provider,
            auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
            models: fake.models,
            api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
        }),
    );
    return models;
}

// A tool that ignores the abort and ends only when the test opens its gate, so an abort has a run to wait for.
function stubbornExtension(release: Promise<void>, started: () => void) {
    const tool = defineTool({
        name: "stubborn",
        description: "Ends only when released",
        parameters: Type.Object({}),
        execute: async () => {
            started();
            await release;
            return { output: [{ type: "text", text: "released" }] };
        },
    });
    return defineExtension({ name: "stubborn", tools: [tool] });
}

type FixtureOptions = { reply?: FakeReply; delayMs?: number; release?: Promise<void>; onToolStarted?: () => void };

async function openFixture(options: FixtureOptions = {}) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => options.reply ?? "ok", { delayMs: () => options.delayMs ?? 0 });
    fakes.push(fake);
    const logger = createLogger({ stream: { write: () => true } });
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [stubbornExtension(options.release ?? Promise.resolve(), options.onToolStarted ?? (() => {}))],
        defaultCwd: process.cwd(),
        logger,
    });
    hosts.push(host);
    const seat: Seat = {
        role: "developer",
        model: `${fake.getModel().provider}/${fake.getModel().id}`,
        workspace: env.root,
        instructions: "Work.",
        tools: ["stubborn"],
        skills: [],
    };
    const catalogue = createCatalogue(conversationControlOperations, {
        context: { host },
        phase: () => "ready",
        logger,
    });
    const lead = async (jobId: string) =>
        (
            await createSeatedConversation(host, {
                scope: "closed-control",
                key: `${jobId}-lead`,
                job: { jobId, isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
                seat,
                actor,
            })
        ).conversationId;
    const call = (name: string, input: unknown) => catalogue.invoke(name, input, caller);
    return { host, lead, call };
}

async function entriesOf(host: HarnessHost, id: string): Promise<HostEntry[]> {
    const entries: HostEntry[] = [];
    let after: string | undefined;
    do {
        const page = await host.readEntries(id, after === undefined ? { limit: 100 } : { after, limit: 100 });
        entries.push(...page.entries);
        after = page.next;
    } while (after !== undefined);
    return entries;
}

async function conflictMessage(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof ServiceError, `expected a ServiceError, got ${String(error)}`);
        assert.equal(error.code, "conflict");
        return error.message;
    }
    return assert.fail("expected the call to reject");
}

describe("conversations.submit to a closed conversation", () => {
    for (const busyMode of BUSY_MODES) {
        it(`is refused conflict naming the conversation as closed and changes nothing with busy mode ${busyMode}`, async () => {
            const { host, lead, call } = await openFixture();
            const id = await lead("job-1");
            await abortJobConversations(host, "job-1");
            const entriesBefore = (await entriesOf(host, id)).length;
            const seatBefore = (await readConversationMeta(host, id))?.seat;

            const message = await conflictMessage(
                call("conversations.submit", { conversationId: id, content: "hi", requestId: "r1", busyMode }),
            );

            assert.match(message, new RegExp(`"${id}" is closed`));
            assert.equal((await entriesOf(host, id)).length, entriesBefore);
            assert.deepEqual((await readConversationMeta(host, id))?.seat, seatBefore);
            assert.equal((await host.conversationInfo(id))?.busy, false);
        });
    }
});

describe("submissions.withdraw of a submission of a closed conversation", () => {
    it("is refused conflict naming the conversation as closed", async () => {
        const { host, lead, call } = await openFixture({ delayMs: BUSY_DELAY_MS });
        const id = await lead("job-1");
        await submitInput(host, id, { content: "first", requestId: "r1", busyMode: "followUp" });
        const queued = await submitInput(host, id, { content: "second", requestId: "r2", busyMode: "followUp" });
        await abortJobConversations(host, "job-1");

        const message = await conflictMessage(call("submissions.withdraw", { submissionId: queued.submissionId }));

        assert.match(message, new RegExp(`"${id}" is closed`));
    });
});

describe("conversations.abort, reset and compact of a closed conversation", () => {
    for (const [operation, input] of [
        ["conversations.abort", {}],
        ["conversations.reset", { note: "again" }],
        ["conversations.compact", {}],
    ] as const) {
        it(`refuses ${operation} conflict naming the conversation as closed and adds no entry`, async () => {
            const { host, lead, call } = await openFixture();
            const id = await lead("job-1");
            await abortJobConversations(host, "job-1");
            const entriesBefore = (await entriesOf(host, id)).length;

            const message = await conflictMessage(call(operation, { conversationId: id, ...input }));

            assert.match(message, new RegExp(`"${id}" is closed`));
            assert.equal((await entriesOf(host, id)).length, entriesBefore);
        });
    }
});

describe("conversations.abort waiting for the aborted run", () => {
    it("lets a job abort of the same job commit its closed marks", async () => {
        const release = gate();
        const toolStarted = gate();
        const { host, lead, call } = await openFixture({
            reply: { toolCall: { name: "stubborn", arguments: {} } },
            release: release.opened,
            onToolStarted: toolStarted.open,
        });
        const id = await lead("job-1");
        await submitInput(host, id, { content: "go", requestId: "r1", busyMode: "followUp" });
        await toolStarted.opened;
        let isAborted = false;
        const aborting = (call("conversations.abort", { conversationId: id }) as Promise<unknown>).then(() => {
            isAborted = true;
        });
        await pause(BUSY_DELAY_MS);
        assert.equal(isAborted, false, "the abort still waits for the run");
        let isClosedWhileWaiting = false;

        const jobAbort = abortJobConversations(host, "job-1", undefined, async () => {
            isClosedWhileWaiting = (await readConversationMeta(host, id))?.closed === true && !isAborted;
            release.open();
        });
        await Promise.all([aborting, jobAbort]);

        assert.equal(isClosedWhileWaiting, true);
    });
});

describe("control operations on an open conversation", () => {
    it("abort, reset, compact and withdraw act as before", async () => {
        const { host, lead, call } = await openFixture({ delayMs: BUSY_DELAY_MS });
        const id = await lead("job-1");
        const first = await submitInput(host, id, { content: "first", requestId: "r1", busyMode: "followUp" });
        const queued = await submitInput(host, id, { content: "second", requestId: "r2", busyMode: "followUp" });

        await call("submissions.withdraw", { submissionId: queued.submissionId });
        assert.equal((await submissionState(host, queued.submissionId)).state, "unanswered");
        await call("conversations.abort", { conversationId: id });
        await waitFor(async () => (await host.conversationInfo(id))?.busy === false, "the aborted run");
        await call("conversations.reset", { conversationId: id });
        await call("conversations.compact", { conversationId: id });

        assert.ok(first.submissionId);
        assert.notEqual((await readConversationMeta(host, id))?.closed, true);
    });
});
