import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createLogger } from "../../src/daemon/logger.ts";
import { type HarnessHost, openHarnessHost } from "../../src/host/harness_host.ts";
import { abortJobConversations, createInvokedConversations } from "../../src/host/invocation.ts";
import {
    ConversationClosedError,
    inJobSection,
    inOpenConversation,
    isConversationClosed,
    JobDoneError,
    refuseIfJobDone,
    setJobDoneCheck,
    setSectionHook,
} from "../../src/host/job_section.ts";
import { createSeatedConversation, readConversationMeta, type SeatActor } from "../../src/host/seating.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

type FakeModel = ReturnType<typeof createFakeModel>;

const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const fakes: FakeModel[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function modelsFor(fake: FakeModel): Models {
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

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const SETTLE_PAUSE_MS = 100;

async function openFixture() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok");
    fakes.push(fake);
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
    const seat: Seat = {
        role: "developer",
        model: `${fake.getModel().provider}/${fake.getModel().id}`,
        workspace: env.root,
        instructions: "Work.",
        tools: [],
        skills: [],
    };
    const actor: SeatActor = { kind: "agent", conversationId: "1", role: "lead" };
    const start = async (jobId: string) =>
        (
            await createSeatedConversation(host, {
                scope: "start-job",
                key: `${jobId}-${Math.random()}`,
                job: { jobId, isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
                seat,
                actor,
            })
        ).conversationId;
    const invoke = (invokingId: string, callId: string) =>
        createInvokedConversations(host, {
            invokingId,
            callId,
            agents: [{ seat, contextMode: "clean", jobPrompt: "job child" }],
            actor,
        });
    return { host, start, invoke };
}

function gate() {
    let open!: () => void;
    const opened = new Promise<void>((resolve) => {
        open = resolve;
    });
    return { opened, open };
}

describe("inJobSection", () => {
    it("starts a later section of the same job only after the earlier one settles", async () => {
        const { host } = await openFixture();
        const first = gate();
        const events: string[] = [];

        const earlier = inJobSection(host, "job-1", async () => {
            events.push("first start");
            await first.opened;
            events.push("first end");
        });
        const later = inJobSection(host, "job-1", async () => {
            events.push("second start");
        });
        await pause(SETTLE_PAUSE_MS);
        assert.deepEqual(events, ["first start"]);
        first.open();
        await Promise.all([earlier, later]);

        assert.deepEqual(events, ["first start", "first end", "second start"]);
    });

    it("starts a section of another job without waiting", async () => {
        const { host } = await openFixture();
        const first = gate();
        const held = inJobSection(host, "job-1", () => first.opened);

        const result = await inJobSection(host, "job-2", async () => "done");

        assert.equal(result, "done");
        first.open();
        await held;
    });

    it("starts the next section after a section whose work failed", async () => {
        const { host } = await openFixture();
        const failing = inJobSection(host, "job-1", async () => {
            throw new Error("work failed");
        });
        await assert.rejects(failing, /work failed/);

        assert.equal(await inJobSection(host, "job-1", async () => "next"), "next");
    });
});

describe("the closed checks", () => {
    it("refuses work in a conversation the registered check reports Done, and runs it again once not Done", async () => {
        const { host, start } = await openFixture();
        const lead = await start("job-1");
        let isDone = true;
        setJobDoneCheck(host, async () => isDone);

        await assert.rejects(
            inOpenConversation(host, lead, async () => "ran"),
            (error) => error instanceof ConversationClosedError && error.conversationId === lead,
        );
        assert.equal(await isConversationClosed(host, lead), true);
        await assert.rejects(refuseIfJobDone(host, "job-1"), (error) => error instanceof JobDoneError);
        isDone = false;

        assert.equal(await inOpenConversation(host, lead, async () => "ran"), "ran");
        assert.equal(await isConversationClosed(host, lead), false);
    });

    it("counts no job as Done when no check is registered", async () => {
        const { host, start } = await openFixture();
        const lead = await start("job-1");

        assert.equal(await isConversationClosed(host, lead), false);
        await refuseIfJobDone(host, "job-1");
    });

    it("refuses work in a conversation whose closed mark is set", async () => {
        const { host, start } = await openFixture();
        const lead = await start("job-1");
        await abortJobConversations(host, "job-1");

        await assert.rejects(
            inOpenConversation(host, lead, async () => "ran"),
            ConversationClosedError,
        );
    });
});

describe("createInvokedConversations in a closed conversation", () => {
    it("throws ConversationClosedError and creates no conversation when the closed mark is set", async () => {
        const { host, start, invoke } = await openFixture();
        const lead = await start("job-1");
        await abortJobConversations(host, "job-1");
        const before = (await host.listConversations()).length;

        await assert.rejects(invoke(lead, "c1"), ConversationClosedError);

        assert.equal((await host.listConversations()).length, before);
    });

    it("throws ConversationClosedError and creates no conversation when the job is Done", async () => {
        const { host, start, invoke } = await openFixture();
        const lead = await start("job-1");
        setJobDoneCheck(host, async (jobId) => jobId === "job-1");
        const before = (await host.listConversations()).length;

        await assert.rejects(invoke(lead, "c1"), ConversationClosedError);

        assert.equal((await host.listConversations()).length, before);
    });
});

describe("abortJobConversations racing an invocation", () => {
    it("closes the conversation an invocation creates after its check passed and refuses its job prompt", async () => {
        const { host, start, invoke } = await openFixture();
        const lead = await start("job-1");
        const held = gate();
        const reached = gate();
        setSectionHook(host, async () => {
            reached.open();
            await held.opened;
        });

        const invoking = invoke(lead, "c1");
        await reached.opened;
        const aborting = abortJobConversations(host, "job-1");
        await pause(SETTLE_PAUSE_MS);
        held.open();
        await assert.rejects(invoking, ConversationClosedError);
        await aborting;

        const created = (await host.listConversations()).map((info) => info.id).find((id) => id !== lead);
        const meta = await readConversationMeta(host, created as string);
        assert.equal(meta?.closed, true);
        assert.deepEqual((await readConversationMeta(host, lead))?.awaiting, []);
    });
});

describe("abortJobConversations ordering", () => {
    it("commits every closed mark before the callback runs, and releases the section before it", async () => {
        const { host, start, invoke } = await openFixture();
        const lead = await start("job-1");
        const [child] = await invoke(lead, "c1");
        const seen: (boolean | undefined)[] = [];
        let isSectionFree = false;

        await abortJobConversations(host, "job-1", undefined, async () => {
            for (const id of [lead, child as string]) seen.push((await readConversationMeta(host, id))?.closed);
            await inJobSection(host, "job-1", async () => {
                isSectionFree = true;
            });
        });

        assert.deepEqual(seen, [true, true]);
        assert.equal(isSectionFree, true);
    });
});
