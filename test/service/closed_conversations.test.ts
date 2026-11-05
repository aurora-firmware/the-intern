/**
 * A closed conversation (S-001 REQ-026, REQ-016; S-002 REQ-012): it keeps its id, seat, job and invocation links and
 * every stored entry, every read operation works on it, it lists with status `closed` from the commit that sets its
 * mark, a run its abort hasn't ended yet included, and the instance feed publishes its change to `closed`.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type FauxProviderRegistration, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { type ConversationId, InboxDoc } from "@earendil-works/pi-durable";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { InstanceDelta } from "../../src/feed/instance_feed.ts";
import { submissionIdFor, submissionState } from "../../src/host/conversation_control.ts";
import { internalHarness } from "../../src/host/harness_host.ts";
import { abortJobConversations, createInvokedConversations } from "../../src/host/invocation.ts";
import { REPORT_KIND } from "../../src/host/reports.ts";
import { conversationMetaDoc, readConversationMeta, type SeatActor } from "../../src/host/seating.ts";
import { type JobActionDeps, startJob } from "../../src/jobs/job_actions.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import type { ConversationListing, InvocationTree } from "../../src/service/conversation_read_operations.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const quietLogger = createLogger({ stream: { write: () => true } });
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };
const teamMember: SeatActor = { kind: "team_member", wayIn: "web interface" };
const author: JobAuthor = { kind: "team_member", wayIn: "web interface" };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

type CreatedJob = { id: string; number: string; leadConversation: string };
type Entries = { entries: { id: string; kind: string }[]; next?: string };
type Started = Awaited<ReturnType<typeof start>>;

async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

function fakeModelComponents(fake: FauxProviderRegistration) {
    const answer = () => {
        fake.appendResponses([answer]);
        return fauxAssistantMessage("done");
    };
    fake.setResponses([answer]);
    const provider = fake.getModel().provider;
    return (runtime: Parameters<NonNullable<Parameters<typeof runDaemon>[0]["prepareModels"]>>[0]) => {
        const implementation = getApiProvider(fake.api);
        if (!implementation) throw new Error("the fake model's api is not registered");
        runtime.models.registerNativeProvider(
            createProvider({
                id: provider,
                auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                models: fake.models,
                api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
            }),
        );
        return runtime.models;
    };
}

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const prepareModels = fakeModelComponents(fake);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: fake.getModel().provider, defaultModel: "model-one" }),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        start: async (ctx) => {
            captured = ctx;
        },
    };
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        sections: agents.sections,
        components: [agents.component, jobs.component, probe],
        operations: [...agents.operations, ...jobs.operations],
        prepareModels,
    });
    daemons.push(daemon);
    await waitFor(() => daemon.phase() === "ready", "the daemon to become ready");
    const ctx = captured as ServiceContext;
    const deps: JobActionDeps = { ctx, options: jobs.options };
    const seat: Seat = jobs.options.agents.runtime().catalog.seatFor(DEFAULT_LEAD_ROLE);
    const invoke = <T = unknown>(name: string, input: unknown) => daemon.catalogue.invoke(name, input, webCaller) as T;
    return { ctx, fake, deps, seat, invoke };
}

async function isBusy(ctx: ServiceContext, id: string): Promise<boolean> {
    return (await ctx.host.conversationInfo(id))?.busy === true;
}

// A job with a definition of done, started, whose lead's runs have ended.
async function startedJob(started: Started): Promise<CreatedJob> {
    const job = await started.invoke<Promise<CreatedJob>>("jobs.create", { text: "do it" });
    await waitFor(async () => !(await isBusy(started.ctx, job.leadConversation)), "the lead's first run to end");
    await started.ctx.jobStore.updateFields(job.id, { definitionOfDone: "it is done" }, author);
    await startJob(started.deps, job.id);
    await waitFor(async () => !(await isBusy(started.ctx, job.leadConversation)), "the lead's runs to end");
    return job;
}

// Starts one agent the invoking conversation invokes; its model reply stays open until its run is aborted.
async function invokeRunning(started: Started, invokingId: string, isParking: boolean): Promise<string> {
    const holdUntilAborted = (_context: unknown, options?: { signal?: AbortSignal }) =>
        new Promise<ReturnType<typeof fauxAssistantMessage>>((resolve) => {
            const finish = () => resolve(fauxAssistantMessage("stopped"));
            if (options?.signal?.aborted) finish();
            options?.signal?.addEventListener("abort", finish);
        });
    started.fake.setResponses([holdUntilAborted]);
    const [id] = await createInvokedConversations(started.ctx.host, {
        invokingId,
        callId: `call-${invokingId}`,
        agents: [{ seat: started.seat, contextMode: "clean", jobPrompt: "work" }],
        actor: teamMember,
        ...(isParking && { parked: { waitingFor: "reports", continueOn: "each" } }),
    });
    assert.ok(id !== undefined, "an agent was invoked");
    await waitFor(() => isBusy(started.ctx, id), "the invoked run");
    return id;
}

async function entriesOf(started: Started, conversationId: string): Promise<Entries["entries"]> {
    return (await started.invoke<Promise<Entries>>("conversations.entries", { conversationId, limit: 500 })).entries;
}

const listingsById = async (started: Started) =>
    new Map((await started.invoke<Promise<ConversationListing[]>>("conversations.list", {})).map((l) => [l.id, l]));

async function nextDelta(
    subscription: { next(): Promise<{ delta: InstanceDelta } | { closed: string }> },
    deadline: number,
): Promise<InstanceDelta> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error("timed out waiting for an instance feed delta")),
            deadline - Date.now(),
        );
    });
    try {
        const result = await Promise.race([subscription.next(), timeout]);
        if ("closed" in result) throw new Error(`the instance feed closed: ${result.closed}`);
        return result.delta;
    } finally {
        clearTimeout(timer);
    }
}

describe("a closed conversation", () => {
    it("lists every conversation of a cancelled and a completed job as closed, keeping its entries and seat", async () => {
        const started = await start();
        const completed = await startedJob(started);
        const cancelled = await startedJob(started);
        const invoked = await invokeRunning(started, cancelled.leadConversation, true);
        const nested = await invokeRunning(started, invoked, false);
        const ids = [cancelled.leadConversation, invoked, nested, completed.leadConversation];
        const before = await listingsById(started);
        const entriesBefore = new Map<string, string[]>();
        for (const id of ids)
            entriesBefore.set(
                id,
                (await entriesOf(started, id)).map((entry) => entry.id),
            );

        await started.invoke("jobs.cancel", { job: cancelled.number, justification: "not needed" });
        await started.invoke("jobs.complete", { job: completed.number, justification: "checked by hand" });

        for (const id of ids) await waitFor(async () => !(await isBusy(started.ctx, id)), "the abort");
        const after = await listingsById(started);
        for (const id of ids) {
            const listing = after.get(id);
            assert.equal(listing?.status, "closed", `${id} lists as closed`);
            assert.deepEqual(listing?.seat, before.get(id)?.seat);
            assert.equal(listing?.jobId, before.get(id)?.jobId);
            const got = await started.invoke<Promise<ConversationListing>>("conversations.get", { conversationId: id });
            assert.equal(got.status, "closed");
            const entries = await entriesOf(started, id);
            const kept = entriesBefore.get(id) ?? [];
            assert.deepEqual(
                entries.slice(0, kept.length).map((entry) => entry.id),
                kept,
            );
            assert.equal(entries.filter((entry) => entry.kind === REPORT_KIND).length, 0, `${id} got no report`);
        }
        const tree = await started.invoke<Promise<InvocationTree>>("conversations.invocations", {
            conversationId: cancelled.leadConversation,
        });
        assert.deepEqual(
            tree.invoked.map((child) => [child.id, child.status, child.invoked.map((n) => [n.id, n.status])]),
            [[invoked, "closed", [[nested, "closed"]]]],
        );
    });

    it("publishes one status_changed delta with status closed for each conversation closed", async () => {
        const started = await start();
        const completed = await startedJob(started);
        const cancelled = await startedJob(started);
        const invoked = await invokeRunning(started, cancelled.leadConversation, true);
        const nested = await invokeRunning(started, invoked, false);
        const ids = [cancelled.leadConversation, invoked, nested, completed.leadConversation];
        const subscription = started.ctx.instanceFeed.subscribe();

        await started.invoke("jobs.cancel", { job: cancelled.number, justification: "not needed" });
        await started.invoke("jobs.complete", { job: completed.number, justification: "checked by hand" });

        const deltas: InstanceDelta[] = [];
        const deadline = Date.now() + WAIT_MS;
        const isClosedSeen = (id: string) =>
            deltas.some((d) => d.type === "status_changed" && d.conversationId === id && d.status === "closed");
        const isFinished = (id: string) => deltas.some((d) => d.type === "run_finished" && d.conversationId === id);
        while (!ids.every(isClosedSeen) || !isFinished(invoked) || !isFinished(nested)) {
            deltas.push(await nextDelta(subscription, deadline));
        }
        subscription.close();
        for (const id of ids) {
            const changes = deltas.filter((d) => d.type === "status_changed" && d.conversationId === id);
            assert.deepEqual(
                changes.map((d) => (d.type === "status_changed" ? d.status : undefined)),
                ["closed"],
                `${id} has one status change`,
            );
        }
    });

    it("gives a closed conversation whose run hasn't ended status closed in every read and the feed snapshot", async () => {
        const started = await start();
        const job = await startedJob(started);
        const invoked = await invokeRunning(started, job.leadConversation, true);
        const seen: { listed?: string; got?: string; tree?: string; snapshot?: string; isRunning?: boolean } = {};

        await abortJobConversations(started.ctx.host, job.id, undefined, async () => {
            seen.isRunning = await isBusy(started.ctx, invoked);
            seen.listed = (await listingsById(started)).get(invoked)?.status;
            seen.got = (
                await started.invoke<Promise<ConversationListing>>("conversations.get", { conversationId: invoked })
            ).status;
            const tree = await started.invoke<Promise<InvocationTree>>("conversations.invocations", {
                conversationId: job.leadConversation,
            });
            seen.tree = tree.invoked[0]?.status;
            await waitFor(() => {
                const subscription = started.ctx.instanceFeed.subscribe();
                seen.snapshot = subscription.snapshot.conversations.find((c) => c.id === invoked)?.status;
                subscription.close();
                return seen.snapshot === "closed";
            }, "the feed snapshot to show the conversation closed");
        });

        assert.deepEqual(seen, {
            isRunning: true,
            listed: "closed",
            got: "closed",
            tree: "closed",
            snapshot: "closed",
        });
    });
});

type QueuedItem = { id: number; mode: string };

async function queuedItemsOf(started: Started, conversationId: string): Promise<QueuedItem[]> {
    return internalHarness(started.ctx.host).commit(async (tx) => {
        const { items } = await tx.doc(InboxDoc, Number(conversationId) as ConversationId);
        return JSON.parse(JSON.stringify(items)) as QueuedItem[];
    }, BACKGROUND_CONTEXT);
}

describe("the closed mark of a conversation that holds queued items", () => {
    it("empties the inbox, input and write alike, and settles each item unanswered with reason closed", async () => {
        const started = await start();
        const job = await startedJob(started);
        const invoked = await invokeRunning(started, job.leadConversation, false);
        await started.invoke("conversations.submit", {
            conversationId: invoked,
            content: "a queued note",
            requestId: "queued-note",
        });
        await started.invoke("conversations.reset", { conversationId: invoked });
        const queued = await queuedItemsOf(started, invoked);
        assert.deepEqual(queued.map((item) => item.mode).sort(), ["followUp", "write"]);

        await abortJobConversations(started.ctx.host, job.id);

        await waitFor(async () => !(await isBusy(started.ctx, invoked)), "the abort");
        assert.deepEqual(await queuedItemsOf(started, invoked), []);
        for (const item of queued) {
            assert.deepEqual(await submissionState(started.ctx.host, String(item.id)), {
                state: "unanswered",
                reason: "closed",
            });
        }
    });

    it("drops the held messages of a closed conversation and settles no submission for them", async () => {
        const started = await start();
        const job = await startedJob(started);
        const invoked = await invokeRunning(started, job.leadConversation, true);
        await internalHarness(started.ctx.host).commit(async (tx) => {
            const meta = await tx.doc(conversationMetaDoc, Number(invoked) as ConversationId);
            meta.held.push({ content: "held note", mode: "followUp", actor: teamMember, requestId: "held-note" });
        }, BACKGROUND_CONTEXT);

        await abortJobConversations(started.ctx.host, job.id);

        await waitFor(async () => !(await isBusy(started.ctx, invoked)), "the abort");
        assert.deepEqual((await readConversationMeta(started.ctx.host, invoked))?.held, []);
        assert.equal(await submissionIdFor(started.ctx.host, invoked, "held-note"), undefined);
        assert.deepEqual(await queuedItemsOf(started, invoked), []);
    });
});
