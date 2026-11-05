import assert from "node:assert/strict";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxProviderRegistration, fauxAssistantMessage, type Message, type Models } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import type { ConversationId } from "@earendil-works/pi-durable";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { createInvokedConversations, parkConversation } from "../../src/host/invocation.ts";
import { inJobSection, setJobDoneCheck } from "../../src/host/job_section.ts";
import { REPORT_KIND, type ReportRecord, startReportDelivery } from "../../src/host/reports.ts";
import {
    createSeatedConversation,
    type ParkedState,
    readConversationMeta,
    type SeatActor,
} from "../../src/host/seating.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const EARLIER_INPUT = "the earlier input";
const WAIT_MS = 10_000;
const POLL_MS = 20;
const SETTLE_MS = 300;
const logger = createLogger({ stream: { write: () => true } });
const fakes: FauxProviderRegistration[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const deliveries: { stop(): void }[] = [];
const releaseHeldAnswers: (() => void)[] = [];

afterEach(async () => {
    for (const release of releaseHeldAnswers.splice(0)) release();
    for (const delivery of deliveries.splice(0)) delivery.stop();
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

function modelsFor(fake: FauxProviderRegistration): Models {
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

const textOf = (message: Message): string =>
    typeof message.content === "string"
        ? message.content
        : message.content.map((block) => ("text" in block ? block.text : "")).join("");

const reportOf = (prompt: string): string => `report of ${prompt}`;

type Fixture = {
    host: HarnessHost;
    seat: Seat;
    actor: SeatActor;
    startInvoker(): Promise<string>;
    invoke(invokingId: string, prompts: string[], parked?: ParkedState): Promise<string[]>;
    invokerRequests(): Message[][];
    holdAnswerTo(prompt: string): () => void;
    reopenHost(): Promise<HarnessHost>;
    startDelivery(host?: HarnessHost): Promise<void>;
};

async function createFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one" }] });
    fakes.push(fake);
    const requests: Message[][] = [];
    const holds = new Map<string, Promise<void>>();
    const answer = async (context: { messages: Message[] }) => {
        fake.appendResponses([answer]);
        requests.push([...context.messages]);
        const lastUser = context.messages.filter((message) => message.role === "user").at(-1);
        const prompt = lastUser === undefined ? "" : textOf(lastUser);
        await holds.get(prompt);
        return fauxAssistantMessage(prompt.startsWith("job") ? reportOf(prompt) : "invoker answer");
    };
    fake.setResponses([answer]);
    const databaseFile = join(env.root, "state.sqlite");
    const open = async (): Promise<HarnessHost> => {
        const host = await openHarnessHost({
            databaseFile,
            models: modelsFor(fake),
            harnessSettings: {},
            extensions: [],
            defaultCwd: process.cwd(),
            logger,
        });
        hosts.push(host);
        return host;
    };
    let host = await open();
    const seat: Seat = {
        role: "developer",
        model: `${fake.getModel().provider}/model-one`,
        workspace: env.root,
        instructions: "Write code.",
        tools: ["read"],
        skills: [],
    };
    const actor: SeatActor = { kind: "agent", conversationId: "1", role: "lead" };
    let invokeCount = 0;
    return {
        get host() {
            return host;
        },
        seat,
        actor,
        async startInvoker() {
            const { conversationId } = await createSeatedConversation(host, {
                scope: "start-job",
                key: "invoker",
                job: { jobId: "job-1", isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
                seat,
                actor,
            });
            const { submissionId } = await submitInput(host, conversationId, {
                content: EARLIER_INPUT,
                requestId: "earlier",
                busyMode: "followUp",
            });
            await waitForSubmission(host, submissionId, WAIT_MS);
            return conversationId;
        },
        async invoke(invokingId, prompts, parked) {
            invokeCount += 1;
            const ids = await createInvokedConversations(host, {
                invokingId,
                callId: `call-${invokeCount}`,
                agents: prompts.map((jobPrompt) => ({ seat, contextMode: "clean", jobPrompt })),
                actor,
                ...(parked !== undefined && { parked }),
            });
            return ids;
        },
        invokerRequests: () =>
            requests.filter((request) =>
                request.some((message) => message.role === "user" && textOf(message) === EARLIER_INPUT),
            ),
        holdAnswerTo(prompt) {
            let release: () => void = () => {};
            holds.set(prompt, new Promise<void>((resolve) => (release = resolve)));
            releaseHeldAnswers.push(() => release());
            return release;
        },
        async reopenHost() {
            await host.close();
            host = await open();
            return host;
        },
        async startDelivery(target = host) {
            deliveries.push(await startReportDelivery(target, { logger }));
        },
    };
}

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

const awaitingOf = async (host: HarnessHost, id: string) => (await readConversationMeta(host, id))?.awaiting;

const reportsSeenBy = (requests: Message[][], prompt: string): number =>
    requests.filter((request) =>
        request.some((message) => message.role === "user" && textOf(message).includes(reportOf(prompt))),
    ).length;

describe("startReportDelivery", () => {
    it("delivers the final answer to an idle invoker, which runs on it, and removes it from awaiting", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        await fixture.startDelivery();

        await fixture.invoke(invokerId, ["job A"]);

        await until(() => reportsSeenBy(fixture.invokerRequests(), "job A") === 1, "the invoker to run on the report");
        await until(async () => (await awaitingOf(fixture.host, invokerId))?.length === 0, "awaiting to empty");
    });

    it("delivers the final answer as a follow-up to an invoker that is running", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        await fixture.startDelivery();
        const release = fixture.holdAnswerTo("busy work");
        await submitInput(fixture.host, invokerId, { content: "busy work", requestId: "busy", busyMode: "followUp" });
        await until(() => fixture.invokerRequests().length === 2, "the invoker to start the busy run");

        await fixture.invoke(invokerId, ["job A"]);
        await until(async () => (await awaitingOf(fixture.host, invokerId))?.length === 0, "the report to be sent");
        assert.equal(reportsSeenBy(fixture.invokerRequests(), "job A"), 0, "the running turn did not see it yet");
        release();

        await until(() => reportsSeenBy(fixture.invokerRequests(), "job A") === 1, "the invoker to take the report");
    });

    it("starts a run for each report as it arrives when the parked invoker continues on each", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        await fixture.startDelivery();
        const releaseB = fixture.holdAnswerTo("job B");
        const parked: ParkedState = { waitingFor: "reports", continueOn: "each" };
        await fixture.invoke(invokerId, ["job A", "job B"], parked);
        await parkConversation(fixture.host, invokerId, parked);

        await until(() => reportsSeenBy(fixture.invokerRequests(), "job A") === 1, "the run on the first report");
        assert.equal(reportsSeenBy(fixture.invokerRequests(), "job B"), 0);
        assert.equal((await readConversationMeta(fixture.host, invokerId))?.parked, null);
        releaseB();

        await until(() => reportsSeenBy(fixture.invokerRequests(), "job B") >= 1, "the run on the second report");
    });

    it("starts no run until the last report when the parked invoker continues after every report", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        await fixture.startDelivery();
        const releaseB = fixture.holdAnswerTo("job B");
        const parked: ParkedState = { waitingFor: "reports", continueOn: "all" };
        const [idA, idB] = await fixture.invoke(invokerId, ["job A", "job B"], parked);
        await parkConversation(fixture.host, invokerId, parked);
        const requestsBefore = fixture.invokerRequests().length;

        await until(async () => (await awaitingOf(fixture.host, invokerId))?.length === 1, "the first report");
        await settle();
        const meta = await readConversationMeta(fixture.host, invokerId);
        assert.deepEqual(meta?.awaiting, [idB]);
        assert.deepEqual(
            meta?.held.map((message) => message.content),
            [reportOf("job A")],
        );
        assert.equal(fixture.invokerRequests().length, requestsBefore, "no run started");
        assert.deepEqual(meta?.parked, parked);
        releaseB();

        await until(() => reportsSeenBy(fixture.invokerRequests(), "job B") === 1, "the run on the last report");
        const [request] = fixture.invokerRequests().slice(requestsBefore);
        assert.ok(request && reportsSeenBy([request], "job A") === 1, "the run has the first report in context");
        const after = await readConversationMeta(fixture.host, invokerId);
        assert.deepEqual(after?.held, []);
        assert.deepEqual(after?.awaiting, []);
        assert.notEqual(idA, idB);
    });

    it("reports a nested agent that parked on two agents only after its run on the last report ends", async () => {
        const fixture = await createFixture();
        const idA = await fixture.startInvoker();
        const [idB] = (await fixture.invoke(idA, ["job B"])) as [string];
        await until(async () => (await fixture.host.conversationInfo(idB))?.busy === false, "B's first run");
        const releaseD = fixture.holdAnswerTo("job D");
        const parked: ParkedState = { waitingFor: "reports", continueOn: "each" };
        const [idC, idD] = (await fixture.invoke(idB, ["job C", "job D"], parked)) as [string, string];
        await parkConversation(fixture.host, idB, parked);
        const requestsBefore = fixture.invokerRequests().length;

        await fixture.startDelivery();
        await until(async () => (await awaitingOf(fixture.host, idB))?.[0] === idD, "C's report to reach B");
        await until(async () => (await fixture.host.conversationInfo(idB))?.busy === false, "B's run on C's report");
        await settle();
        assert.equal(fixture.invokerRequests().length, requestsBefore, "A got no report while B awaits D");
        assert.deepEqual((await readConversationMeta(fixture.host, idA))?.awaiting, [idB]);
        releaseD();

        await until(() => fixture.invokerRequests().length === requestsBefore + 1, "B's report to reach A");
        await until(async () => (await awaitingOf(fixture.host, idA))?.length === 0, "A's awaiting to empty");
        await settle();
        assert.equal(fixture.invokerRequests().length, requestsBefore + 1, "B's report reached A exactly once");
        assert.notEqual(idC, idD);
    });

    it("reports a steerable nested agent only after its run on the awaited report ends", async () => {
        const fixture = await createFixture();
        const idA = await fixture.startInvoker();
        const [idB] = (await fixture.invoke(idA, ["job B"])) as [string];
        await until(async () => (await fixture.host.conversationInfo(idB))?.busy === false, "B's first run");
        const releaseC = fixture.holdAnswerTo("job C");
        await fixture.invoke(idB, ["job C"]);
        const requestsBefore = fixture.invokerRequests().length;

        await fixture.startDelivery();
        await settle();
        assert.equal(fixture.invokerRequests().length, requestsBefore, "A got no report while B awaits C");
        assert.deepEqual((await readConversationMeta(fixture.host, idA))?.awaiting, [idB]);
        releaseC();

        await until(() => fixture.invokerRequests().length === requestsBefore + 1, "B's report to reach A");
        await settle();
        assert.equal(fixture.invokerRequests().length, requestsBefore + 1, "B's report reached A exactly once");
        assert.deepEqual(await awaitingOf(fixture.host, idA), []);
    });

    it("delivers a report exactly once when the host closed before it was delivered", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        const [invokedId] = await fixture.invoke(invokerId, ["job A"]);
        const submitted = await fixture.host.readEntries(invokedId as string, { limit: 100 });
        assert.ok(submitted.entries.length > 0);
        await until(async () => (await fixture.host.conversationInfo(invokedId as string))?.busy === false, "its run");
        await fixture.reopenHost();

        await fixture.startDelivery();
        await until(() => reportsSeenBy(fixture.invokerRequests(), "job A") === 1, "the report");
        await until(async () => (await awaitingOf(fixture.host, invokerId))?.length === 0, "awaiting to empty");
        await fixture.reopenHost();
        await fixture.startDelivery();
        await settle();

        assert.equal(reportsSeenBy(fixture.invokerRequests(), "job A"), 1);
    });
});

describe("report delivery to the invoker of a Done job whose close failed", () => {
    // A failed close (S-004 AC-005.8) leaves the job Done and the conversation without its closed mark.
    async function parkedInvokerOfDoneJob(continueOn: ParkedState["continueOn"]) {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        const releaseA = fixture.holdAnswerTo("job A");
        const parked: ParkedState = { waitingFor: "reports", continueOn };
        const prompts = continueOn === "all" ? ["job A", "job B"] : ["job A"];
        await fixture.invoke(invokerId, prompts, parked);
        await parkConversation(fixture.host, invokerId, parked);
        const before = await readConversationMeta(fixture.host, invokerId);
        setJobDoneCheck(fixture.host, async () => true);
        const errors: string[] = [];
        const recording = createLogger({ stream: { write: (line: string) => errors.push(line) !== 0 } });
        deliveries.push(await startReportDelivery(fixture.host, { logger: recording }));
        return { fixture, invokerId, before, releaseA, errors };
    }

    for (const continueOn of ["each", "all"] as const) {
        it(`leaves the parked invoker as it was and logs no failure when it continues on ${continueOn}`, async () => {
            const { fixture, invokerId, before, releaseA, errors } = await parkedInvokerOfDoneJob(continueOn);
            const requestsBefore = fixture.invokerRequests().length;
            releaseA();
            await settle();

            const after = await readConversationMeta(fixture.host, invokerId);
            assert.deepEqual(after?.parked, before?.parked);
            assert.deepEqual(after?.awaiting, before?.awaiting);
            assert.deepEqual(after?.held, []);
            assert.equal(errors.filter((line) => line.includes("report delivery failed")).length, 0);
            assert.equal(fixture.invokerRequests().length, requestsBefore, "no model call");
        });
    }

    it("leaves the parked invoker as it was while the job's section is held", async () => {
        const { fixture, invokerId, before, releaseA } = await parkedInvokerOfDoneJob("each");
        let openSection: () => void = () => {};
        const section = new Promise<void>((resolve) => (openSection = resolve));
        const held = inJobSection(fixture.host, "job-1", () => section);
        releaseA();
        await settle();

        const during = await readConversationMeta(fixture.host, invokerId);
        openSection();
        await held;
        assert.deepEqual(during?.parked, before?.parked);
        assert.deepEqual(during?.awaiting, before?.awaiting);
    });
});

async function rawEntriesOf(host: HarnessHost, conversationId: string) {
    const conversation = await internalHarness(host).conversation(
        Number(conversationId) as ConversationId,
        BACKGROUND_CONTEXT,
    );
    const page = await conversation?.entries({ order: "ascending" }, 500, undefined, BACKGROUND_CONTEXT);
    return page?.items ?? [];
}

// A report is placed once, as an intern.report entry that names the invoked agent, and no pi.user entry repeats it.
async function assertPlacedAsReportEntry(host: HarnessHost, invokerId: string, invokedId: string, prompt: string) {
    const entries = await rawEntriesOf(host, invokerId);
    const reports = entries.filter((entry) => entry.kind === REPORT_KIND).map((entry) => entry.data as ReportRecord);
    assert.deepEqual(
        reports.filter((report) => report.content === reportOf(prompt)),
        [{ actor: { kind: "agent", conversationId: invokedId, role: "developer" }, content: reportOf(prompt) }],
    );
    const carriers = entries.filter((entry) => JSON.stringify(entry.model ?? []).includes(reportOf(prompt)));
    assert.deepEqual(
        carriers.map((entry) => entry.kind),
        [REPORT_KIND],
        "the report text is carried once, by the report entry",
    );
}

describe("report entries", () => {
    it("places the report to an idle invoker as an intern.report entry naming the invoked agent", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        await fixture.startDelivery();

        const [invokedId] = (await fixture.invoke(invokerId, ["job A"])) as [string];

        await until(() => reportsSeenBy(fixture.invokerRequests(), "job A") === 1, "the invoker to run on the report");
        await assertPlacedAsReportEntry(fixture.host, invokerId, invokedId, "job A");
    });

    it("places the report to a running invoker as an intern.report entry naming the invoked agent", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        await fixture.startDelivery();
        const release = fixture.holdAnswerTo("busy work");
        await submitInput(fixture.host, invokerId, { content: "busy work", requestId: "busy", busyMode: "followUp" });
        await until(() => fixture.invokerRequests().length === 2, "the invoker to start the busy run");

        const [invokedId] = (await fixture.invoke(invokerId, ["job A"])) as [string];
        await until(async () => (await awaitingOf(fixture.host, invokerId))?.length === 0, "the report to be sent");
        release();

        await until(() => reportsSeenBy(fixture.invokerRequests(), "job A") === 1, "the invoker to take the report");
        await assertPlacedAsReportEntry(fixture.host, invokerId, invokedId, "job A");
    });

    it("places the report that continues a parked invoker as an intern.report entry naming the invoked agent", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        await fixture.startDelivery();
        const parked: ParkedState = { waitingFor: "reports", continueOn: "each" };
        const [invokedId] = (await fixture.invoke(invokerId, ["job A"], parked)) as [string];
        await parkConversation(fixture.host, invokerId, parked);

        await until(() => reportsSeenBy(fixture.invokerRequests(), "job A") === 1, "the run on the report");
        await assertPlacedAsReportEntry(fixture.host, invokerId, invokedId, "job A");
    });

    it("holds the first report as an intern.report naming the invoked agent when the invoker continues after all", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        await fixture.startDelivery();
        fixture.holdAnswerTo("job B");
        const parked: ParkedState = { waitingFor: "reports", continueOn: "all" };
        const [idA] = (await fixture.invoke(invokerId, ["job A", "job B"], parked)) as [string, string];
        await parkConversation(fixture.host, invokerId, parked);

        await until(async () => (await awaitingOf(fixture.host, invokerId))?.length === 1, "the first report");
        const meta = await readConversationMeta(fixture.host, invokerId);
        assert.deepEqual(
            meta?.held.map(({ kind, actor, content }) => ({ kind, actor, content })),
            [
                {
                    kind: REPORT_KIND,
                    actor: { kind: "agent", conversationId: idA, role: "developer" },
                    content: reportOf("job A"),
                },
            ],
        );
    });

    it("places every report as an intern.report naming its own agent, in arrival order, after the last report", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        await fixture.startDelivery();
        const releaseB = fixture.holdAnswerTo("job B");
        const parked: ParkedState = { waitingFor: "reports", continueOn: "all" };
        const [idA, idB] = (await fixture.invoke(invokerId, ["job A", "job B"], parked)) as [string, string];
        await parkConversation(fixture.host, invokerId, parked);
        await until(async () => (await awaitingOf(fixture.host, invokerId))?.length === 1, "the first report");
        releaseB();

        await until(() => reportsSeenBy(fixture.invokerRequests(), "job B") === 1, "the run on the last report");
        const entries = await rawEntriesOf(fixture.host, invokerId);
        const reports = entries.filter((entry) => entry.kind === REPORT_KIND).map((entry) => entry.data);
        assert.deepEqual(reports, [
            { actor: { kind: "agent", conversationId: idA, role: "developer" }, content: reportOf("job A") },
            { actor: { kind: "agent", conversationId: idB, role: "developer" }, content: reportOf("job B") },
        ]);
    });

    it("places one intern.report entry when the report is delivered again after a restart", async () => {
        const fixture = await createFixture();
        const invokerId = await fixture.startInvoker();
        const [invokedId] = (await fixture.invoke(invokerId, ["job A"])) as [string];
        await until(async () => (await fixture.host.conversationInfo(invokedId))?.busy === false, "its run");
        await fixture.reopenHost();
        await fixture.startDelivery();
        await until(() => reportsSeenBy(fixture.invokerRequests(), "job A") === 1, "the report");
        await fixture.reopenHost();
        await fixture.startDelivery();
        await settle();

        await assertPlacedAsReportEntry(fixture.host, invokerId, invokedId, "job A");
    });
});
