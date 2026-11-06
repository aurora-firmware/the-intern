import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Models } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { type Admission, createAdmission } from "../../src/admission/admission.ts";
import { createAdmissionGate } from "../../src/admission/admission_extension.ts";
import { defineConfigSection, loadConfig } from "../../src/config/config_file.ts";
import { type ConfigStore, createConfigStore } from "../../src/config/config_writer.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import {
    createInstanceFeed,
    type InstanceDelta,
    type InstanceFeed,
    type InstanceSnapshot,
} from "../../src/feed/instance_feed.ts";
import { createObservationFeed, type ObservationFeed, type Subscription } from "../../src/feed/observation_feed.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, hostDatabase, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { continueParked, parkConversation } from "../../src/host/invocation.ts";
import { changeSeat, createSeatedConversation, SEAT_RECORD_KIND, type SeatActor } from "../../src/host/seating.ts";
import type { JobAuthor } from "../../src/jobs/job_model.ts";
import { createJobStore, type Job, type JobStore, migrateJobStore, type NewJob } from "../../src/jobs/job_store.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { feedOperations } from "../../src/service/feed_operations.ts";
import { type Caller, ServiceError } from "../../src/service/operations.ts";
import { createFakeModel } from "../support/fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const TEAM_MEMBER: Caller = { actor: { kind: "team_member" } };
const NEXT_TIMEOUT_MS = 5000;
const SUBMISSION_TIMEOUT_MS = 10_000;
const RUN_DELAY_MS = 100;
const MAX_OPENING_MICROTASKS = 1000;
const ACTOR: SeatActor = { kind: "team_member", wayIn: "cli" };

type FakeModel = ReturnType<typeof createFakeModel>;
type Sub = Subscription<InstanceSnapshot, InstanceDelta>;
type Fixture = {
    host: HarnessHost;
    admission: Admission;
    config: ConfigStore;
    modelId: string;
    jobStore: JobStore;
    open(maxPending?: number, store?: JobStore): Promise<InstanceFeed>;
};

const labelSection = defineConfigSection<{ label: string }>({
    name: "label",
    defaults: () => ({ label: "none" }),
    parse: (table) => ({ label: (table as { label?: string }).label ?? "none" }),
    serialize: (value) => ({ label: value.label }),
});

const fakes: FakeModel[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const admissions: Admission[] = [];
const feeds: { close(): void }[] = [];
const directories: string[] = [];

afterEach(async () => {
    for (const feed of feeds.splice(0)) feed.close();
    for (const admission of admissions.splice(0)) admission.stop();
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
    for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
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

async function openFixture(capacity = 2): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = createFakeModel(() => "ok", { delayMs: () => RUN_DELAY_MS });
    fakes.push(fake);
    const logger = createLogger({ stream: { write: () => true } });
    const gate = createAdmissionGate();
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: modelsFor(fake),
        harnessSettings: {},
        extensions: [gate.extension],
        defaultCwd: process.cwd(),
        logger,
    });
    hosts.push(host);
    const admission = createAdmission({ host, capacity, logger, gate });
    admissions.push(admission);
    const directory = await mkdtemp(join(tmpdir(), "instance-feed-"));
    directories.push(directory);
    const file = join(directory, "config.toml");
    const config = await createConfigStore(file, [labelSection], await loadConfig(file, [labelSection]));
    await migrateJobStore(hostDatabase(host));
    const jobStore = createJobStore(hostDatabase(host));
    const modelId = `${fake.getModel().provider}/${fake.getModel().id}`;
    return {
        host,
        admission,
        config,
        modelId,
        jobStore,
        async open(maxPending, store = jobStore) {
            const feed = await createInstanceFeed({
                host,
                admission,
                config,
                jobStore: store,
                ...(maxPending && { maxPending }),
            });
            feeds.push(feed);
            return feed;
        },
    };
}

async function nextDelta(subscription: Sub): Promise<InstanceDelta> {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timed out waiting for the next delta")), NEXT_TIMEOUT_MS);
    });
    try {
        const result = await Promise.race([subscription.next(), timeout]);
        assert.ok("delta" in result, "the subscription stays open");
        return result.delta;
    } finally {
        clearTimeout(timer);
    }
}

async function collectUntil(subscription: Sub, isDone: (deltas: InstanceDelta[]) => boolean): Promise<InstanceDelta[]> {
    const deltas: InstanceDelta[] = [];
    while (!isDone(deltas)) deltas.push(await nextDelta(subscription));
    return deltas;
}

function seatFor(fixture: Fixture, role: string): Seat {
    return {
        role,
        model: fixture.modelId,
        workspace: process.cwd(),
        instructions: "Work.",
        tools: [],
        skills: [],
    };
}

async function createSeated(fixture: Fixture, key: string, role = "developer"): Promise<string> {
    const { conversationId } = await createSeatedConversation(fixture.host, {
        scope: "instance-feed-test",
        key,
        job: { jobId: "job-1", isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 },
        seat: seatFor(fixture, role),
        actor: ACTOR,
    });
    return conversationId;
}

async function send(fixture: Fixture, conversationId: string): Promise<void> {
    const { submissionId } = await submitInput(fixture.host, conversationId, {
        content: "hello",
        requestId: `req-${conversationId}`,
        busyMode: "followUp",
    });
    await waitForSubmission(fixture.host, submissionId, SUBMISSION_TIMEOUT_MS);
}

// Counts the entries every Set iteration yields while `action` runs, which is how many subscribers a publish visits.
async function countSetEntriesVisitedDuring(action: () => Promise<void>): Promise<number> {
    const original = Set.prototype[Symbol.iterator];
    let visited = 0;
    Set.prototype[Symbol.iterator] = function* (this: Set<unknown>) {
        for (const entry of original.call(this)) {
            visited++;
            yield entry;
        }
    } as typeof original;
    try {
        await action();
    } finally {
        Set.prototype[Symbol.iterator] = original;
    }
    return visited;
}

type CommitListener = (publication: unknown, context: unknown) => void;
type PatchableHarness = {
    subscribeCommits(listener: CommitListener): () => void;
    inspect(context: unknown): Promise<unknown>;
};

// Delivers a commit that starts a run in `conversationId` to the instance watch `depth` microtasks after the watch's
// initial read, so it can reach the feed while `createInstanceFeed` is still waiting for the watch to return.
function startRunWhileWatchReturns(
    host: HarnessHost,
    conversationId: string,
    depth: number,
): { restore(): void; hasStarted(): boolean } {
    const harness = internalHarness(host) as unknown as PatchableHarness;
    const { subscribeCommits, inspect } = harness;
    let listener: CommitListener | undefined;
    let hasStarted = false;
    harness.subscribeCommits = (watchListener) => {
        listener = watchListener;
        return subscribeCommits.call(harness, watchListener);
    };
    harness.inspect = async (context) => {
        const result = await inspect.call(harness, context);
        let step = Promise.resolve();
        for (let tick = 0; tick < depth; tick++) step = step.then(() => {});
        const task = { id: -1, conversationId: Number(conversationId), state: { status: "running" } };
        void step.then(() => {
            hasStarted = true;
            listener?.({ changes: [{ type: "task", value: task }] }, context);
        });
        return result;
    };
    return {
        restore() {
            harness.subscribeCommits = subscribeCommits;
            harness.inspect = inspect;
        },
        hasStarted: () => hasStarted,
    };
}

describe("the instance feed", () => {
    it("snapshots every conversation with its status and the worker threads", async () => {
        const fixture = await openFixture(3);
        const first = await fixture.host.createConversation({ agent: { model: fixture.modelId } });
        const second = await fixture.host.createConversation({ agent: { model: fixture.modelId } });
        const feed = await fixture.open();

        const { snapshot } = feed.subscribe();

        assert.deepEqual(snapshot.conversations.map((conversation) => conversation.id).sort(), [first, second].sort());
        assert.ok(snapshot.conversations.every((conversation) => conversation.status === "idle"));
        assert.deepEqual(snapshot.workerThreads, { count: 3, inUse: 0 });
        assert.deepEqual(snapshot.admission, fixture.admission.state());
    });

    it("reports the status of a running conversation in a later snapshot", async () => {
        const fixture = await openFixture();
        const id = await fixture.host.createConversation({ agent: { model: fixture.modelId } });
        const feed = await fixture.open();
        const watcher = feed.subscribe();
        const sending = send(fixture, id);
        await collectUntil(watcher, (deltas) => deltas.some((delta) => delta.type === "run_started"));

        const { snapshot } = feed.subscribe();
        await sending;

        assert.equal(snapshot.conversations.find((conversation) => conversation.id === id)?.status, "running");
    });

    it("keeps a run that starts while the feed is opening in its snapshot", async () => {
        const fixture = await openFixture();
        const id = await fixture.host.createConversation({ agent: { model: fixture.modelId } });

        // Each pass starts the run one microtask later, until it starts only after the feed has opened: every moment
        // of the opening is then covered, however many steps the watch takes to return.
        let hasStartedBeforeOpen = true;
        for (let depth = 0; hasStartedBeforeOpen; depth++) {
            assert.ok(depth < MAX_OPENING_MICROTASKS, "the feed opens within the microtask budget");
            const run = startRunWhileWatchReturns(fixture.host, id, depth);
            const feed = await fixture.open().finally(run.restore);
            hasStartedBeforeOpen = run.hasStarted();
            await new Promise((resolve) => setImmediate(resolve));

            const { snapshot } = feed.subscribe();

            const status = snapshot.conversations.find((conversation) => conversation.id === id)?.status;
            assert.equal(status, "running", `run started ${depth} microtasks after the watch's read`);
        }
    });

    it("delivers created, run, admission and settings deltas in order with increasing seq", async () => {
        const fixture = await openFixture();
        const feed = await fixture.open();
        const subscription = feed.subscribe();

        const id = await fixture.host.createConversation({ agent: { model: fixture.modelId } });
        await send(fixture, id);
        await fixture.config.change(labelSection, { label: "changed" });

        const deltas = await collectUntil(subscription, (all) =>
            all.some((delta) => delta.type === "settings_changed"),
        );
        const types = deltas.map((delta) => delta.type);
        assert.equal(types[0], "conversation_created");
        assert.ok(types.indexOf("run_started") < types.indexOf("run_finished"));
        assert.ok(types.includes("admission_changed"));
        assert.deepEqual(deltas.at(-1), { type: "settings_changed", section: "label", seq: deltas.length });
        assert.deepEqual(
            deltas.map((delta) => delta.seq),
            deltas.map((_, index) => index + 1),
        );
        const created = deltas[0];
        assert.ok(created?.type === "conversation_created" && created.conversationId === id);
    });

    it("delivers every delta to every instance subscriber", async () => {
        const fixture = await openFixture();
        const feed = await fixture.open();
        const first = feed.subscribe();
        const second = feed.subscribe();

        await fixture.config.change(labelSection, { label: "x" });

        assert.deepEqual(await nextDelta(first), { seq: 1, type: "settings_changed", section: "label" });
        assert.deepEqual(await nextDelta(second), { seq: 1, type: "settings_changed", section: "label" });
    });

    it("closes a subscriber with reason lagging without delaying a run", async () => {
        const fixture = await openFixture();
        const feed = await fixture.open(2);
        const lagging = feed.subscribe();
        const id = await fixture.host.createConversation({ agent: { model: fixture.modelId } });

        await send(fixture, id);

        assert.deepEqual(await lagging.next(), { closed: "lagging" });
    });

    it("stops visiting a lagged subscriber that never reads again on later deltas", async () => {
        const fixture = await openFixture();
        const feed = await fixture.open(1);
        const live = feed.subscribe();
        const baseline = await countSetEntriesVisitedDuring(() => fixture.config.change(labelSection, { label: "a" }));
        await nextDelta(live);
        const dead = feed.subscribe();
        await fixture.config.change(labelSection, { label: "b" });
        await nextDelta(live);
        await fixture.config.change(labelSection, { label: "c" });
        await nextDelta(live);

        const visited = await countSetEntriesVisitedDuring(() => fixture.config.change(labelSection, { label: "d" }));

        assert.equal(visited, baseline);
        assert.deepEqual(await dead.next(), { closed: "lagging" });
    });

    it("closes subscribers with reason stopped when the feed closes and refuses new ones", async () => {
        const fixture = await openFixture();
        const feed = await fixture.open();
        const subscription = feed.subscribe();

        feed.close();

        assert.deepEqual(await subscription.next(), { closed: "stopped" });
        assert.throws(() => feed.subscribe(), /closed/);
    });
});

describe("the instance feed seats and parked status", () => {
    it("snapshots the job, lead flag, seat and status of a seated conversation and null seat data for others", async () => {
        const fixture = await openFixture();
        const seated = await createSeated(fixture, "k1");
        const plain = await fixture.host.createConversation({ agent: { model: fixture.modelId } });
        const feed = await fixture.open();

        const { snapshot } = feed.subscribe();

        const find = (id: string) => snapshot.conversations.find((conversation) => conversation.id === id);
        assert.deepEqual(find(seated), {
            id: seated,
            jobId: "job-1",
            isLead: true,
            seat: { role: "developer", model: fixture.modelId, workspace: process.cwd() },
            status: "idle",
        });
        assert.deepEqual(find(plain), { id: plain, jobId: null, isLead: false, seat: null, status: "idle" });
    });

    it("snapshots a parked conversation with status parked", async () => {
        const fixture = await openFixture();
        const id = await createSeated(fixture, "k1");
        await parkConversation(fixture.host, id, { waitingFor: "reports", continueOn: "all" });
        const feed = await fixture.open();

        const { snapshot } = feed.subscribe();

        assert.equal(snapshot.conversations.find((conversation) => conversation.id === id)?.status, "parked");
    });

    it("publishes seat_changed with the new seat when a conversation's seat changes", async () => {
        const fixture = await openFixture();
        const id = await createSeated(fixture, "k1");
        const feed = await fixture.open();
        const subscription = feed.subscribe();

        await changeSeat(fixture.host, id, { seat: seatFor(fixture, "reviewer"), actor: ACTOR });

        const deltas = await collectUntil(subscription, (all) => all.some((delta) => delta.type === "seat_changed"));
        assert.deepEqual(deltas.at(-1), {
            seq: deltas.length,
            type: "seat_changed",
            conversationId: id,
            seat: { role: "reviewer", model: fixture.modelId, workspace: process.cwd() },
        });
    });

    it("publishes no seat_changed for a document change that keeps the seat", async () => {
        const fixture = await openFixture();
        const id = await createSeated(fixture, "k1");
        const feed = await fixture.open();
        const subscription = feed.subscribe();

        await parkConversation(fixture.host, id, { waitingFor: "answer", continueOn: "each" });
        await fixture.config.change(labelSection, { label: "marker" });

        const deltas = await collectUntil(subscription, (all) =>
            all.some((delta) => delta.type === "settings_changed"),
        );
        assert.equal(
            deltas.some((delta) => delta.type === "seat_changed"),
            false,
        );
    });

    it("publishes status_changed when a conversation is parked and when it continues", async () => {
        const fixture = await openFixture();
        const id = await createSeated(fixture, "k1");
        const feed = await fixture.open();
        const subscription = feed.subscribe();

        await parkConversation(fixture.host, id, { waitingFor: "reports", continueOn: "all" });
        await continueParked(fixture.host, id, { content: "go on", requestId: "continue-1" });

        const deltas = await collectUntil(
            subscription,
            (all) => all.filter((delta) => delta.type === "status_changed").length === 2,
        );
        const changes = deltas.filter((delta) => delta.type === "status_changed");
        assert.deepEqual(
            changes.map((delta) => ({ type: delta.type, conversationId: delta.conversationId, status: delta.status })),
            [
                { type: "status_changed", conversationId: id, status: "parked" },
                { type: "status_changed", conversationId: id, status: "idle" },
            ],
        );
    });

    it("delivers the seat record of a seat change through the conversation scope", async () => {
        const fixture = await openFixture();
        const id = await createSeated(fixture, "k1");
        const observation = createObservationFeed({ host: fixture.host });
        feeds.push(observation);
        const subscription = await observation.subscribeConversation(id);

        await changeSeat(fixture.host, id, { seat: seatFor(fixture, "reviewer"), actor: ACTOR });

        const result = await subscription.next();
        assert.ok("delta" in result);
        const { entries } = await fixture.host.readEntries(id, { limit: 100 });
        const record = entries.findLast((entry) => entry.kind === SEAT_RECORD_KIND);
        assert.ok(record, "the seat record is in the conversation's history");
        assert.equal((record.data as { next: { role: string } }).next.role, "reviewer");
    });
});

describe("feed.subscribe", () => {
    async function context(fixture: Fixture): Promise<{
        feed: ObservationFeed;
        instanceFeed: InstanceFeed;
        host: HarnessHost;
    }> {
        const feed = createObservationFeed({ host: fixture.host });
        feeds.push(feed);
        return { feed, instanceFeed: await fixture.open(), host: fixture.host };
    }
    const subscribe = feedOperations.find((operation) => operation.name === "feed.subscribe");

    it("is a read operation", () => {
        assert.equal(subscribe?.kind, "read");
    });

    it("returns the conversation subscription for a known conversation", async () => {
        const fixture = await openFixture();
        const id = await fixture.host.createConversation({ agent: { model: fixture.modelId } });

        const subscription = await subscribe?.run(
            await context(fixture),
            {
                scope: "conversation",
                conversationId: id,
            },
            TEAM_MEMBER,
        );

        assert.deepEqual((await fixture.host.readEntries(id, { limit: 100 })).entries, []);
        assert.equal(typeof subscription.next, "function");
    });

    it("returns the instance subscription for scope instance", async () => {
        const fixture = await openFixture();
        const subscription = await subscribe?.run(await context(fixture), { scope: "instance" }, TEAM_MEMBER);
        assert.deepEqual(subscription.snapshot.workerThreads, { count: 2, inUse: 0 });
    });

    it("rejects an unknown conversation with not_found", async () => {
        const fixture = await openFixture();
        const ctx = await context(fixture);
        for (const conversationId of ["999", "nope"]) {
            await assert.rejects(
                async () => subscribe?.run(ctx, { scope: "conversation", conversationId }, TEAM_MEMBER),
                (error) => error instanceof ServiceError && error.code === "not_found",
            );
        }
    });

    it("rejects an input with an unknown scope", () => {
        assert.throws(() => subscribe?.parse({ scope: "galaxy" }), /scope/);
    });
});

describe("the instance snapshot's jobs that exist when the feed opens", () => {
    const daemon: JobAuthor = { kind: "daemon" };
    const newJob = (title: string): NewJob => ({
        letter: "C",
        requestText: "do it",
        origin: { kind: "request", wayIn: "command line" },
        title,
        leadStart: {},
    });

    it("lists the To do, In progress and Blocked jobs, past one page, and leaves out a Done job", async () => {
        const fixture = await openFixture();
        const { jobStore } = fixture;
        const todo = (await jobStore.insertJob(newJob("Waiting"))).job;
        const running = (await jobStore.insertJob(newJob("Running"))).job;
        await jobStore.applyAction(running.number, "start", {}, daemon);
        const blocked = (await jobStore.insertJob(newJob("Stuck"))).job;
        await jobStore.applyAction(blocked.number, "start", {}, daemon);
        await jobStore.applyAction(blocked.number, "block", { blockedReason: "need a key" }, daemon);
        const finished = (await jobStore.insertJob(newJob("Finished"))).job;
        await jobStore.applyAction(finished.number, "cancel", { justification: "not needed" }, daemon);
        const extra: string[] = [];
        for (let i = 0; i < 52; i++) extra.push((await jobStore.insertJob(newJob(`Extra ${i}`))).job.number);

        const subscription = (await fixture.open()).subscribe();

        const byNumber = new Map(subscription.snapshot.jobs.map((job) => [job.number, job]));
        assert.equal(byNumber.size, 55);
        assert.deepEqual(byNumber.get(todo.number), { number: todo.number, title: "Waiting", status: "to_do" });
        assert.deepEqual(byNumber.get(running.number), {
            number: running.number,
            title: "Running",
            status: "in_progress",
        });
        assert.deepEqual(byNumber.get(blocked.number), { number: blocked.number, title: "Stuck", status: "blocked" });
        assert.equal(byNumber.has(finished.number), false);
        for (const number of extra) assert.equal(byNumber.get(number)?.status, "to_do");
        subscription.close();
    });

    it("keeps a job committed while the feed reads the store", async () => {
        const fixture = await openFixture();
        await fixture.jobStore.insertJob(newJob("Before"));
        let late: Job | undefined;
        const store: JobStore = {
            ...fixture.jobStore,
            async listJobs(filter) {
                const page = await fixture.jobStore.listJobs(filter);
                if (filter.status === "to_do" && late === undefined) {
                    late = (await fixture.jobStore.insertJob(newJob("During"))).job;
                }
                return page;
            },
        };

        const subscription = (await fixture.open(undefined, store)).subscribe();

        assert.ok(late, "a job was committed during the read");
        assert.deepEqual(subscription.snapshot.jobs.map((job) => job.title).sort(), ["Before", "During"]);
        subscription.close();
    });
});
