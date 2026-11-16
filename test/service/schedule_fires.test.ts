/** A scheduled job at each due time (S-007 REQ-001, REQ-004, REQ-015: AC-001.2, AC-004.1, AC-004.2, AC-015.1). */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { request } from "node:http";
import { join } from "node:path";
import { afterEach, describe, it, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { blockJob } from "../../src/jobs/job_actions.ts";
import type { NewJob } from "../../src/jobs/job_store.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import { RoleRefusedError } from "../../src/roles/role_catalog.ts";
import { localTimeText } from "../../src/schedules/schedule_time.ts";
import { createSchedulesComponent } from "../../src/schedules/schedules_component.ts";
import { leadStartFor } from "../../src/service/job_operations.ts";
import { ServiceError } from "../../src/service/operations.ts";
import { roleInstructionPath } from "../../src/skills/internal_folder.ts";
import { startDaemon } from "../support/daemon_process.ts";
import { createFakeModel, type FakeModelOptions, type FakeTranscript } from "../support/fake_model.ts";
import { createHermeticEnv } from "../support/hermetic_env.ts";
import { waitForJobStatus } from "../support/job_status.ts";
import { createTestClock, type ScheduleRig, startScheduleRig } from "../support/schedule_rig.ts";
import { scaled } from "../support/time_scale.ts";

type ReplyFn = Parameters<typeof createFakeModel>[0];

const rigs: ScheduleRig[] = [];
const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_TIMEOUT_MS = scaled(20_000);
const POLL_INTERVAL_MS = 10;
const FAKE_MODEL = "faux/faux-1";
const MINUTE_MS = 60_000;
const at = (hour: number, minute = 0): Date => new Date(2026, 10, 8, hour, minute, 0);

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.dispose();
});

/** A real daemon with a held fake model, exposing the store for history and fault injection. */
async function fireRig(t: TestContext, extra = "", model: FakeModelOptions & { reply?: ReplyFn } = {}) {
    const env = await createHermeticEnv();
    const { reply = () => "ok", ...modelOptions } = model;
    const fake = createFakeModel(reply, { gate: new Promise<void>(() => {}), ...modelOptions });
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: fake.getModel().id }),
    );
    await writeFile(join(env.configDir, "config.toml"), entryToml("nightly", "* * * * *", extra));
    let logs = "";
    const logger = createLogger({
        stream: {
            write: (chunk) => {
                logs += chunk;
            },
        },
    });
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
    const clock = createTestClock(at(1));
    const schedules = await createSchedulesComponent({ agents, jobs, logger, clock });
    let captured: ServiceContext | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        workerThreadCount: 1,
        sections: [...agents.sections, ...schedules.sections],
        components: [
            agents.component,
            jobs.component,
            schedules.component,
            {
                name: "probe",
                start: async (ctx) => {
                    captured = ctx;
                },
            },
        ],
        operations: [...agents.operations, ...jobs.operations, ...schedules.operations],
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            assert.ok(implementation);
            runtime.models.registerNativeProvider(
                createProvider({
                    id: provider,
                    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                    models: fake.models,
                    api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
                }),
            );
            return runtime.models;
        },
    });
    t.after(async () => {
        await daemon.stop();
        fake.unregister();
        await env.dispose();
    });
    await waitFor(async () => daemon.phase() === "ready", "the daemon to be ready");
    assert.ok(captured);
    const ctx = captured;
    return {
        ctx,
        clock,
        jobs,
        env,
        logs: () => logs,
        invoke: (name: string, input: unknown = {}) =>
            daemon.catalogue.invoke(name, input, {
                actor: { kind: "team_member", wayIn: "command line" },
            }),
        invokeAs: (name: string, input: unknown, actor: import("../../src/service/operations.ts").Actor) =>
            daemon.catalogue.invoke(name, input, { actor }),
        history: () => ctx.jobStore.listScheduleRuns("nightly", {}),
    };
}

/** A job starts on the admission grant, after its prompt is read, so a test that completes a new job waits for it. */
const untilInProgress = (rig: { ctx: ServiceContext }, job: string): Promise<void> =>
    waitForJobStatus(async () => (await rig.ctx.jobStore.getJob(job)).status, "in_progress");

async function waitFor(check: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

describe("a skipped schedule fire", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const status of ["in_progress", "to_do"] as const) {
        it(`records the due time and open run and publishes the delta while ${status} (AC-006.1)`, async (t) => {
            const rig = await fireRig(t);
            if (status === "to_do") {
                await rig.invoke("jobs.create", { text: "Hold the only worker thread." });
                await waitFor(async () => rig.ctx.admission.state().active.length === 1, "the worker thread");
            }
            rig.clock.set(at(1, 1));
            await waitFor(async () => (await rig.history()).items.length === 1, "the first scheduled run");
            const first = await rig.ctx.jobStore.latestScheduledRun("nightly");
            assert.ok(first);
            await waitFor(async () => (await rig.ctx.jobStore.getJob(first.id)).status === status, status);
            if (status === "to_do") {
                await waitFor(async () => rig.ctx.admission.state().waiting.length === 1, "the waiting lead");
            }
            const sub = (await rig.invoke("feed.subscribe", { scope: "instance" })) as {
                next(): Promise<{
                    delta?: {
                        type: string;
                        entry?: string;
                        dueTime?: string;
                        reason?: string;
                        openRun?: string | null;
                    };
                }>;
            };
            rig.clock.set(at(1, 2));
            await waitFor(async () => (await rig.history()).items.length === 2, "the skipped fire");
            const newest = (await rig.history()).items.find((item) => item.kind === "skip");
            assert.ok(newest?.kind === "skip");
            assert.deepEqual(newest.skip, {
                entry: "nightly",
                dueAt: at(1, 2).toISOString(),
                dueTime: localTimeText(at(1, 2)),
                reason: `A job of this schedule entry is still open: ${first.number}.`,
                openRun: first.number,
            });
            const { delta } = await sub.next();
            assert.equal(delta?.type, "schedule_fire_skipped");
            assert.equal(delta?.entry, "nightly");
            assert.equal(delta?.dueTime, newest.skip.dueTime);
            assert.equal(delta?.reason, newest.skip.reason);
            assert.equal(delta?.openRun, first.number);
            assert.equal((await rig.ctx.jobStore.listJobs({ schedule: "nightly" })).jobs.length, 1);
        });
    }

    it("starts the next run while the earlier run stays Blocked (AC-006.2)", async (t) => {
        const rig = await fireRig(t);
        rig.clock.set(at(1, 1));
        await waitFor(async () => (await rig.history()).items.length === 1, "the first scheduled run");
        const first = await rig.ctx.jobStore.latestScheduledRun("nightly");
        assert.ok(first);
        await waitFor(
            async () => (await rig.ctx.jobStore.getJob(first.id)).status === "in_progress",
            "the lead to start",
        );
        await blockJob({ ctx: rig.ctx, options: rig.jobs.options }, first.id, "Waiting for an answer.", {
            kind: "daemon",
        });
        rig.clock.set(at(1, 2));
        await waitFor(async () => (await rig.history()).items.length === 2, "the second scheduled run");
        const newest = await rig.ctx.jobStore.latestScheduledRun("nightly");
        assert.equal(first.number, "S-1");
        assert.equal(newest?.number, "S-2");
        assert.equal((await rig.ctx.jobStore.getJob(first.id)).status, "blocked");
        assert.ok((await rig.history()).items.every((item) => item.kind === "run"));
    });

    for (const hasOpenRun of [false, true]) {
        it(`records a missing folder before checking for an open run (${hasOpenRun}) (AC-006.3)`, async (t) => {
            const rig = await fireRig(t);
            const workspace = rig.jobs.options.agents.runtime().catalog.seatFor("bob").workspace;
            if (hasOpenRun) {
                rig.clock.set(at(1, 1));
                await waitFor(async () => (await rig.history()).items.length === 1, "the first run");
            }
            await rm(workspace, { recursive: true });
            rig.clock.set(at(1, 2));
            await waitFor(
                async () => (await rig.history()).items.some((item) => item.kind === "skip"),
                "the skipped fire",
            );
            const item = (await rig.history()).items.find((item) => item.kind === "skip");
            assert.ok(item?.kind === "skip");
            assert.equal(item.skip.reason, `The workspace folder ${workspace} does not exist.`);
            assert.equal(item.skip.openRun, null);
            assert.equal((await rig.ctx.jobStore.listJobs({})).jobs.length, Number(hasOpenRun));
            await mkdir(workspace, { recursive: true, mode: 0o700 });
            if (hasOpenRun) await rig.invoke("jobs.cancel", { job: "S-1", justification: "Finished." });
            rig.clock.set(at(1, 3));
            await waitFor(
                async () => (await rig.ctx.jobStore.listJobs({})).jobs.length === Number(hasOpenRun) + 1,
                "the next run",
            );
            assert.equal((await rig.ctx.jobStore.latestScheduledRun("nightly"))?.number, hasOpenRun ? "S-2" : "S-1");
        });
    }

    it("records the gone model without using a job number (AC-006.4)", async (t) => {
        const rig = await fireRig(t, 'model = "nowhere/missing-model"\n');
        rig.clock.set(at(1, 1));
        await waitFor(async () => (await rig.history()).items.length === 1, "the skipped fire");
        const item = (await rig.history()).items[0];
        assert.ok(item?.kind === "skip");
        assert.match(item.skip.reason, /nowhere\/missing-model/);
        assert.equal(item.skip.openRun, null);
        assert.deepEqual((await rig.ctx.jobStore.listJobs({})).jobs, []);
        await rig.invoke("schedules.change", { name: "nightly", model: null });
        rig.clock.set(at(1, 2));
        await waitFor(async () => (await rig.history()).items.length === 2, "the next run");
        assert.equal((await rig.ctx.jobStore.latestScheduledRun("nightly"))?.number, "S-1");
    });

    it("records a team role's missing instruction file without using a job number (S-007 AC-006.5)", async (t) => {
        const rig = await fireRig(t);
        await rig.invoke("roles.create", { name: "reviewer", instructions: "Review.", tools: ["read"], skills: [] });
        await rig.invoke("schedules.change", { name: "nightly", role: "reviewer" });
        const file = roleInstructionPath(rig.env.dataDir, "reviewer");
        await rm(file);
        rig.clock.set(at(1, 1));
        await waitFor(async () => (await rig.history()).items.length === 1, "the skipped fire");
        const item = (await rig.history()).items[0];
        assert.ok(item?.kind === "skip");
        assert.ok(item.skip.reason.includes("instructions/roles/reviewer.md"), item.skip.reason);
        assert.deepEqual((await rig.ctx.jobStore.listJobs({})).jobs, []);
        await writeFile(file, "Review.");
        rig.clock.set(at(1, 2));
        await waitFor(async () => (await rig.history()).items.length === 2, "the next run");
        assert.equal((await rig.ctx.jobStore.latestScheduledRun("nightly"))?.number, "S-1");
    });

    it("keeps a refusal after the job write as a cancelled run, without a skipped fire", async (t) => {
        const rig = await fireRig(t);
        const insertJob = rig.ctx.jobStore.insertJob.bind(rig.ctx.jobStore);
        const catalog = rig.jobs.options.agents.runtime().catalog;
        t.mock.method(rig.ctx.jobStore, "insertJob", async (input: NewJob) => {
            const result = await insertJob(input);
            t.mock.method(catalog, "seatFor", () => {
                throw new RoleRefusedError("invalid", "bob", "the model is no longer available", "model", FAKE_MODEL);
            });
            return result;
        });
        rig.clock.set(at(1, 1));
        await waitFor(
            async () => (await rig.ctx.jobStore.latestScheduledRun("nightly"))?.status === "done",
            "the cancelled run",
        );
        const { items } = await rig.history();
        assert.equal(items.length, 1);
        assert.ok(items[0]?.kind === "run");
        assert.equal(items[0].job.number, "S-1");
        assert.equal(items[0].job.resolution?.kind, "cancelled");
        assert.match(items[0].job.resolution?.justification ?? "", /model is no longer available/);
    });

    for (const code of ["not_found", "conflict", "busy", "unavailable", "internal"] as const) {
        it(`handles a ${code} start failure as ${["unavailable", "internal"].includes(code) ? "a logged failure" : "a skip"}`, async (t) => {
            const rig = await fireRig(t);
            const fault = t.mock.method(rig.ctx.jobStore, "insertJob", async () => {
                throw new ServiceError(code, `Start failed: ${code}`);
            });
            rig.clock.set(at(1, 1));
            await waitFor(async () => fault.mock.callCount() === 1, "the attempted start");
            const isFailure = code === "unavailable" || code === "internal";
            await waitFor(
                async () =>
                    isFailure ? rig.logs().includes(`Start failed: ${code}`) : (await rig.history()).items.length === 1,
                "the handled failure",
            );
            if (isFailure) {
                assert.match(rig.logs(), /A schedule fire failed/);
                assert.deepEqual((await rig.history()).items, []);
            } else {
                const item = (await rig.history()).items[0];
                assert.ok(item?.kind === "skip");
                assert.equal(item.skip.reason, `Start failed: ${code}`);
                assert.equal(item.skip.openRun, null);
            }
            assert.deepEqual((await rig.ctx.jobStore.listJobs({})).jobs, []);
        });
    }
});

type JobSummary = {
    id: string;
    number: string;
    request: { text: string; origin: { kind: string; entry?: string; fireTime?: string } };
};
type Listing = {
    id: string;
    isLead: boolean;
    seat: { role: string; model: string; thinkingLevel?: string; workspace: string };
};

const entryToml = (name: string, cron: string, extra = ""): string =>
    `[[schedule]]\nname = "${name}"\ncron = "${cron}"\nrequest = "Run ${name}."\n${extra}`;

async function rigWith(configToml: string | ((env: ScheduleRig["env"]) => string)): Promise<ScheduleRig> {
    const rig = await startScheduleRig({ configToml });
    rigs.push(rig);
    return rig;
}

const jobsOf = async (rig: ScheduleRig): Promise<JobSummary[]> =>
    ((await rig.invoke("jobs.list")) as { jobs: JobSummary[] }).jobs;

async function waitForJobs(rig: ScheduleRig, count: number): Promise<JobSummary[]> {
    const deadline = Date.now() + WAIT_TIMEOUT_MS;
    for (;;) {
        const jobs = await jobsOf(rig);
        if (jobs.length >= count) return jobs;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${count} jobs, have ${jobs.length}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

type Entry = { kind: string; data: { actor?: unknown } };

async function entriesOf(rig: ScheduleRig, conversationId: string): Promise<Entry[]> {
    return ((await rig.invoke("conversations.entries", { conversationId })) as { entries: Entry[] }).entries;
}

async function leadSeatOf(rig: ScheduleRig, job: JobSummary): Promise<Listing["seat"]> {
    return (await leadOf(rig, job.id)).seat;
}

async function seatActorOf(rig: ScheduleRig, conversationId: string): Promise<unknown> {
    const page = await entriesOf(rig, conversationId);
    return page.find((entry) => entry.kind === "intern.seat")?.data.actor;
}

async function leadOf(rig: ScheduleRig, jobId: string): Promise<Listing> {
    const listed = (await rig.invoke("conversations.list", { jobId })) as Listing[];
    const lead = listed.find((conversation) => conversation.isLead);
    assert.ok(lead, `job ${jobId} has a lead conversation`);
    return lead;
}

describe("a scheduled job at each due time", () => {
    it("creates one job at the due time, naming the entry and time, with a clean lead (AC-1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml("nightly", "0 2 * * *"));
        assert.deepEqual(await jobsOf(rig), []);
        rig.clock.set(at(2));
        const jobs = await waitForJobs(rig, 1);
        assert.equal(jobs.length, 1);
        const [job] = jobs;
        await sleep(100);
        assert.equal((await jobsOf(rig)).length, 1);
        assert.ok(job);
        assert.equal(job.request.text, "Run nightly.");
        assert.deepEqual(job.request.origin, { kind: "schedule", entry: "nightly", fireTime: localTimeText(at(2)) });
        assert.match(job.number, /^S-\d+$/);
        const lead = await leadOf(rig, job.id);
        const inputs = (await entriesOf(rig, lead.id)).filter((entry) => entry.kind === "pi.user");
        assert.equal(inputs.length, 1);
        assert.match(JSON.stringify(inputs[0]), /Run nightly\./);
    });

    it("seats the lead with the four values the entry names, with the job source as actor (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith("");
        const workspace = join(rig.env.root, "project");
        await mkdir(workspace);
        await chmod(workspace, 0o700);
        await rig.invoke("workspaces.register", { path: workspace });
        const extra = `role = "gp"\nmodel = "${FAKE_MODEL}"\nthinking_level = "off"\nworkspace = "${workspace}"\n`;
        const registered = await readFile(join(rig.env.configDir, "config.toml"), "utf8");
        await rig.restart(`${registered}\n${entryToml("audit", "0 2 * * *", extra)}`);
        rig.clock.set(at(2));
        const [job] = await waitForJobs(rig, 1);
        assert.ok(job);
        const lead = await leadOf(rig, job.id);
        assert.deepEqual(lead.seat, { role: "gp", model: FAKE_MODEL, thinkingLevel: "off", workspace });
        assert.deepEqual(await seatActorOf(rig, lead.id), { kind: "job_source", source: "schedule" });
    });

    it("seats the lead as bob with that role's defaults for an entry with only the required keys (AC-3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml("plain", "0 2 * * *"));
        const defaults = await leadSeatOf(rig, (await rig.invoke("jobs.create", { text: "Probe." })) as JobSummary);
        rig.clock.set(at(2));
        const job = (await waitForJobs(rig, 2)).find((candidate) => candidate.number.startsWith("S-"));
        assert.ok(job);
        assert.deepEqual((await leadOf(rig, job.id)).seat, defaults);
        assert.equal(defaults.role, "bob");
    });

    it("creates each job within a minute of its due time when several entries come due together (AC-4)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(
            [entryToml("one", "0 2 * * *"), entryToml("two", "0 2 * * *"), entryToml("three", "*/5 * * * *")].join(
                "\n",
            ),
        );
        rig.clock.set(at(2));
        const jobs = await waitForJobs(rig, 3);
        const named = jobs.map((job) => job.request.origin.entry).sort();
        assert.deepEqual(named, ["one", "three", "two"]);
        for (const job of jobs) {
            const due = new Date(job.request.origin.fireTime as string).getTime();
            assert.ok(rig.clock.now().getTime() - due < MINUTE_MS);
        }
    });

    it("leaves a running job's seat as it was and uses the new values at the next fire (AC-5)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith(entryToml("nightly", "0 2 * * *", 'role = "bob"\n'));
        rig.clock.set(at(2));
        const [first] = await waitForJobs(rig, 1);
        assert.ok(first);
        await rig.invoke("schedules.change", {
            name: "nightly",
            role: "gp",
            request: "Run it again.",
            cron: "5 2 * * *",
        });
        assert.equal((await leadOf(rig, first.id)).seat.role, "bob");
        await rig.invoke("jobs.cancel", { job: first.id, justification: "Done with it." });
        rig.clock.set(at(2, 5));
        const second = (await waitForJobs(rig, 2)).find((job) => job.id !== first.id);
        assert.ok(second);
        assert.equal((await leadOf(rig, second.id)).seat.role, "gp");
        assert.equal(second.request.text, "Run it again.");
        assert.equal((await leadOf(rig, first.id)).seat.role, "bob");
    });

    it("logs an access error when the workspace path contains a symbolic link loop", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith("");
        const workspace = join(rig.env.root, "audit");
        await mkdir(workspace, { mode: 0o700 });
        await rig.invoke("workspaces.register", { path: workspace });
        const registered = await readFile(join(rig.env.configDir, "config.toml"), "utf8");
        await rig.restart(`${registered}\n${entryToml("audit", "0 2 * * *", `workspace = "${workspace}"\n`)}`);
        // A link loop makes stat fail even as root, which bypasses directory permission restrictions in CI.
        await rm(workspace, { recursive: true });
        await symlink(workspace, workspace, "dir");
        await assert.rejects(stat(workspace), { code: "ELOOP" });
        rig.clock.set(at(2));
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        while (!rig.logs().includes("A schedule fire failed")) {
            if (Date.now() > deadline) throw new Error(`the access error was not logged in: ${rig.logs()}`);
            await sleep(POLL_INTERVAL_MS);
        }
        assert.match(rig.logs(), /ELOOP/);
        assert.ok(rig.logs().includes(workspace));
        assert.ok(!rig.logs().includes(`The workspace folder ${workspace} does not exist.`));
        assert.deepEqual(await jobsOf(rig), []);
    });
});

describe("a schedule run on demand", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const firstOperation of ["jobs.create", "schedules.run"] as const) {
        it(`separates colliding keys when ${firstOperation} runs first`, async (t) => {
            const rig = await fireRig(t);
            const create = () =>
                rig.invoke("jobs.create", {
                    text: "ordinary job",
                    idempotencyKey: "schedules.run:x",
                }) as Promise<JobSummary>;
            const run = () =>
                rig.invoke("schedules.run", { name: "nightly", idempotencyKey: "x" }) as Promise<JobSummary>;
            const first = await (firstOperation === "jobs.create" ? create() : run());
            const second = await (firstOperation === "jobs.create" ? run() : create());
            assert.notEqual(first.id, second.id);
            const [createdAgain, runAgain] = await Promise.all([create(), run(), create(), run()]);
            assert.equal(createdAgain?.id, firstOperation === "jobs.create" ? first.id : second.id);
            assert.equal(runAgain?.id, firstOperation === "schedules.run" ? first.id : second.id);
        });
    }

    it("returns the original job for a key even after the entry is removed", async (t) => {
        const rig = await fireRig(t);
        const before = await rig.invoke("schedules.get", { name: "nightly" });
        const key = "k".repeat(200);
        const first = (await rig.invoke("schedules.run", { name: "nightly", idempotencyKey: key })) as JobSummary;
        assert.equal(first.number, "S-1");
        assert.deepEqual(first.request.origin, {
            kind: "schedule",
            entry: "nightly",
            fireTime: localTimeText(at(1)),
            onDemand: { wayIn: "command line" },
        });
        assert.deepEqual(await rig.invoke("schedules.get", { name: "nightly" }), before);
        await rig.invoke("schedules.remove", { name: "nightly" });
        const repeat = (await rig.invoke("schedules.run", { name: "nightly", idempotencyKey: key })) as JobSummary;
        assert.equal(repeat.id, first.id);
        assert.equal((await rig.history()).items.length, 1);
    });

    it("refuses an open run and starts another after it is blocked", async (t) => {
        const rig = await fireRig(t);
        const first = (await rig.invoke("schedules.run", { name: "nightly" })) as JobSummary;
        await waitFor(
            async () => (await rig.ctx.jobStore.getJob(first.id)).status === "in_progress",
            "the lead to start",
        );
        await assert.rejects(rig.invoke("schedules.run", { name: "nightly" }), { code: "busy", message: /S-1/ });
        assert.equal((await rig.history()).items.length, 1);
        await blockJob({ ctx: rig.ctx, options: rig.jobs.options }, first.id, "Waiting.", { kind: "daemon" });
        const second = (await rig.invoke("schedules.run", { name: "nightly" })) as JobSummary;
        assert.equal(second.number, "S-2");
    });

    it("refuses a missing entry, long key, and missing folder without recording a run", async (t) => {
        const rig = await fireRig(t);
        await assert.rejects(rig.invoke("schedules.run", { name: "absent" }), { code: "not_found" });
        await assert.rejects(rig.invoke("schedules.run", { name: "nightly", idempotencyKey: "x".repeat(201) }), {
            code: "invalid_input",
        });
        const workspace = rig.jobs.options.agents.runtime().catalog.seatFor("bob").workspace;
        await rm(workspace, { recursive: true });
        await assert.rejects(rig.invoke("schedules.run", { name: "nightly" }), {
            code: "invalid_input",
            message: new RegExp(workspace),
        });
        assert.deepEqual((await rig.history()).items, []);
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        assert.equal(((await rig.invoke("schedules.run", { name: "nightly" })) as JobSummary).number, "S-1");
    });

    it("refuses an unavailable model without recording a run", async (t) => {
        const rig = await fireRig(t, 'model = "nowhere/missing-model"\n');
        await assert.rejects(rig.invoke("schedules.run", { name: "nightly" }), {
            code: "invalid_input",
            message: /nowhere\/missing-model/,
        });
        assert.deepEqual((await rig.history()).items, []);
        assert.deepEqual((await rig.ctx.jobStore.listJobs({})).jobs, []);
    });
});

describe("a schedule run on demand for a team role with no instruction file", { timeout: TEST_TIMEOUT_MS }, () => {
    it("refuses naming the file, creates no job and records no skipped fire (S-007 AC-008.4)", async (t) => {
        const rig = await fireRig(t);
        await rig.invoke("roles.create", { name: "reviewer", instructions: "Review.", tools: ["read"], skills: [] });
        await rig.invoke("schedules.change", { name: "nightly", role: "reviewer" });
        await rm(roleInstructionPath(rig.env.dataDir, "reviewer"));
        await assert.rejects(rig.invoke("schedules.run", { name: "nightly" }), {
            code: "invalid_input",
            message: /instructions\/roles\/reviewer\.md/,
        });
        assert.deepEqual((await rig.history()).items, []);
        assert.deepEqual((await rig.ctx.jobStore.listJobs({})).jobs, []);
    });
});

describe("on-demand callers", { timeout: TEST_TIMEOUT_MS }, () => {
    it("accepts the front desk and refuses other agents", async (t) => {
        const rig = await fireRig(t);
        await assert.rejects(
            rig.invokeAs("schedules.run", { name: "nightly" }, { kind: "agent", conversationId: "agent" }),
            { code: "invalid_input" },
        );
        const job = (await rig.invokeAs(
            "schedules.run",
            { name: "nightly" },
            { kind: "front_desk", conversationId: "desk", wayIn: "web interface" },
        )) as JobSummary;
        assert.deepEqual(job.request.origin, {
            kind: "schedule",
            entry: "nightly",
            fireTime: localTimeText(at(1)),
            onDemand: { wayIn: "web interface", frontDesk: "desk" },
        });
    });

    it("records the actual way in on each listener", async (t) => {
        const env = await createHermeticEnv();
        await writeFile(
            join(env.configDir, "config.toml"),
            entryToml("local", "0 2 * * *") + entryToml("network", "0 2 * * *"),
        );
        const daemon = startDaemon({
            hermetic: env,
            networkListener: true,
            scheduleClock: at(1).toISOString(),
            script: "gated",
        });
        t.after(async () => {
            daemon.signal("SIGTERM");
            await daemon.exited;
            await env.dispose();
        });
        await daemon.ready;
        const post = (target: { socketPath: string } | { host: string; port: number }, name: string) =>
            new Promise<{ job: JobSummary; port?: number }>((resolve, reject) => {
                const call = request(
                    {
                        ...target,
                        method: "POST",
                        path: "/operations/schedules.run",
                        headers: { "content-type": "application/json" },
                    },
                    (response) => {
                        const port = response.socket.localPort;
                        const chunks: Buffer[] = [];
                        response.on("data", (chunk: Buffer) => chunks.push(chunk));
                        response.on("end", () => {
                            const body = JSON.parse(Buffer.concat(chunks).toString());
                            if (response.statusCode !== 200) reject(new Error(JSON.stringify(body)));
                            else resolve({ job: body.result, port });
                        });
                    },
                );
                call.on("error", reject);
                call.end(JSON.stringify({ name }));
            });
        const local = await post({ socketPath: localSocketPath(env.runtimeDir) }, "local");
        const network = await post({ host: "127.0.0.1", port: await daemon.networkPort() }, "network");
        assert.deepEqual(local.job.request.origin, {
            kind: "schedule",
            entry: "local",
            fireTime: localTimeText(at(1)),
            onDemand: { wayIn: "command line" },
        });
        assert.deepEqual(network.job.request.origin, {
            kind: "schedule",
            entry: "network",
            fireTime: localTimeText(at(1)),
            onDemand: { wayIn: "web interface", observed: { remoteAddress: "127.0.0.1", remotePort: network.port } },
        });
    });
});

describe("missed due times and job endings", { timeout: TEST_TIMEOUT_MS }, () => {
    it("does not catch up after a restart and reports tomorrow's due time (AC-007.1)", async () => {
        const rig = await rigWith(entryToml("nightly", "0 2 * * *"));
        rig.clock.set(at(1, 59));
        await rig.daemon().stop();
        rig.clock.set(at(2, 5));
        await rig.restart();
        assert.deepEqual(await jobsOf(rig), []);
        assert.deepEqual(((await rig.invoke("schedules.runs", { name: "nightly" })) as { items: unknown[] }).items, []);
        const result = (await rig.invoke("schedules.get", { name: "nightly" })) as {
            schedule: { nextDueTime: string };
        };
        assert.equal(result.schedule.nextDueTime, localTimeText(new Date(2026, 10, 9, 2)));
    });

    it("does not catch up after the clock jumps to 02:30 (AC-007.2)", async (t) => {
        const rig = await rigWith(entryToml("nightly", "0 2 * * *"));
        rig.clock.set(at(1, 59));
        await sleep(20);
        const wait = t.mock.method(rig.clock, "wait");
        rig.clock.set(at(2, 30));
        await waitFor(async () => wait.mock.callCount() > 0, "the scheduler's next check");
        await rig.restart();
        assert.deepEqual(await jobsOf(rig), []);
        assert.deepEqual(((await rig.invoke("schedules.runs", { name: "nightly" })) as { items: unknown[] }).items, []);
    });

    it("fires a due time less than a minute old after a clock jump (REQ-007)", async () => {
        const rig = await rigWith(entryToml("nightly", "0 2 * * *"));
        rig.clock.set(new Date(2026, 10, 8, 1, 59, 50));
        rig.clock.set(new Date(2026, 10, 8, 2, 0, 40));
        const jobs = await waitForJobs(rig, 1);
        assert.equal(jobs.length, 1);
        assert.equal(jobs[0]?.request.origin.fireTime, localTimeText(at(2)));
    });

    it("keeps runs through removal and adds fires after the name is restored (AC-003.3)", async (t) => {
        const rig = await fireRig(t);
        rig.clock.set(at(1, 1));
        await waitFor(async () => (await rig.history()).items.length === 1, "the first run");
        await untilInProgress(rig, "S-1");
        await rig.invoke("jobs.update", { job: "S-1", definitionOfDone: "The work is done." });
        await rig.invoke("jobs.complete", { job: "S-1", justification: "Finished." });
        rig.clock.set(at(1, 2));
        await waitFor(async () => (await rig.history()).items.length === 2, "the second run");
        await waitFor(async () => (await rig.ctx.jobStore.getJob("S-2")).status === "in_progress", "the second lead");
        const runs = async () =>
            (
                (await rig.invoke("schedules.runs", { name: "nightly" })) as {
                    items: { kind: string; job?: { number: string; status: string } }[];
                }
            ).items;
        const numbers = async () => (await runs()).map((item) => item.job?.number).sort();
        assert.deepEqual(await numbers(), ["S-1", "S-2"]);
        await rig.invoke("schedules.remove", { name: "nightly" });
        assert.deepEqual(await numbers(), ["S-1", "S-2"]);
        const wait = t.mock.method(rig.clock, "wait");
        rig.clock.set(at(1, 3));
        await waitFor(async () => wait.mock.callCount() > 0, "the check with the entry removed");
        await sleep(100);
        assert.equal((await rig.ctx.jobStore.listJobs({})).jobs.length, 2);
        assert.deepEqual(await numbers(), ["S-1", "S-2"]);
        await rig.invoke("jobs.update", { job: "S-2", definitionOfDone: "The work is done." });
        await rig.invoke("jobs.complete", { job: "S-2", justification: "Finished normally." });
        assert.equal((await rig.ctx.jobStore.getJob("S-2")).status, "done");
        assert.deepEqual(await numbers(), ["S-1", "S-2"]);
        await rig.invoke("schedules.create", { name: "nightly", cron: "* * * * *", request: "Run again." });
        assert.deepEqual(await numbers(), ["S-1", "S-2"]);
        rig.clock.set(at(1, 4));
        await waitFor(async () => (await runs()).length === 3, "the restored entry's fire");
        assert.deepEqual(await numbers(), ["S-1", "S-2", "S-3"]);
        assert.ok((await runs()).every((item) => item.kind === "run"));
    });

    it("starts no extra jobs when scheduled runs complete and are cancelled (AC-014.1)", async (t) => {
        const rig = await fireRig(t);
        rig.clock.set(at(1, 1));
        await waitFor(async () => (await rig.history()).items.length === 1, "the first run");
        await untilInProgress(rig, "S-1");
        await rig.invoke("jobs.update", { job: "S-1", definitionOfDone: "The work is done." });
        await rig.invoke("jobs.complete", { job: "S-1", justification: "Finished." });
        await sleep(100);
        assert.equal((await rig.ctx.jobStore.listJobs({})).jobs.length, 1);
        rig.clock.set(at(1, 2));
        await waitFor(async () => (await rig.history()).items.length === 2, "the second run");
        await rig.invoke("jobs.cancel", { job: "S-2", justification: "No longer needed." });
        await sleep(100);
        assert.equal((await rig.ctx.jobStore.listJobs({})).jobs.length, 2);
        await rig.invoke("jobs.create", { text: "A team member's job." });
        assert.equal((await rig.ctx.jobStore.listJobs({})).jobs.length, 3);
    });
});

const firstInputOf = (transcript: FakeTranscript): string =>
    transcript.find((message) => message.role === "user")?.text ?? "";

describe("what a scheduled run's lead is told", { timeout: TEST_TIMEOUT_MS }, () => {
    it("names the entry and lets the lead read an earlier cancelled run (AC-1, AC-2)", async (t) => {
        const transcripts: FakeTranscript[] = [];
        const rig = await fireRig(t, "", {
            // Only the first run's lead is held; the second follows the script.
            isGated: (transcript) => firstInputOf(transcript).startsWith("S-1\n"),
            reply: (transcript) => {
                if (!firstInputOf(transcript).startsWith("S-2\n")) return "ok";
                transcripts.push(transcript);
                const results = transcript.filter((message) => message.role === "toolResult").length;
                if (results === 0) return { toolCall: { name: "read_schedule_runs", arguments: { name: "nightly" } } };
                if (results === 1) return { toolCall: { name: "read_job", arguments: { job: "S-1" } } };
                return "done";
            },
        });
        rig.clock.set(at(1, 1));
        await waitFor(async () => (await rig.history()).items.length === 1, "the first scheduled run");
        await rig.invoke("jobs.worklog.add", { job: "S-1", text: "Checked the disk." });
        await rig.invoke("jobs.cancel", { job: "S-1", justification: "Nothing to back up." });
        rig.clock.set(at(1, 2));
        await waitFor(async () => (await rig.history()).items.length === 2, "the second scheduled run");
        await waitFor(
            async () => transcripts.some((one) => one.filter((m) => m.role === "toolResult").length === 2),
            "the script's second tool result",
        );

        const last = transcripts.at(-1);
        assert.ok(last);
        const first = firstInputOf(last);
        assert.match(first, /nightly/);
        assert.match(first, /read_schedule_runs/);
        assert.match(first, /earlier scheduled runs/i);
        assert.ok(first.indexOf("Run nightly.") < first.indexOf("scheduled run of the schedule entry"));
        assert.ok(first.indexOf("scheduled run of the schedule entry") < first.indexOf("You are the lead"));
        const results = last.filter((message) => message.role === "toolResult").map((message) => message.text);
        assert.match(results[0] ?? "", /S-1/);
        assert.match(results[1] ?? "", /Nothing to back up\./);
        assert.match(results[1] ?? "", /cancelled/);
        assert.match(results[1] ?? "", /Checked the disk\./);
        const second = await rig.ctx.jobStore.latestScheduledRun("nightly");
        assert.equal(second?.request.text, "Run nightly.");
    });

    it("tells the lead of a job from a conversation nothing about a schedule (AC-3)", async (t) => {
        const inputs: string[] = [];
        const rig = await fireRig(t, "", {
            gate: Promise.resolve(),
            reply: (transcript) => {
                inputs.push(firstInputOf(transcript));
                return "ok";
            },
        });
        await rig.invoke("jobs.create", { text: "Plain request." });
        await waitFor(async () => inputs.length > 0, "the lead's first input");

        assert.match(inputs[0] ?? "", /^C-\d+\n\nPlain request\./);
        assert.doesNotMatch(inputs[0] ?? "", /schedule/i);
    });

    it("builds the same first input when the lead start is built again (AC-4)", async (t) => {
        const rig = await fireRig(t);
        rig.clock.set(at(1, 1));
        await waitFor(async () => (await rig.history()).items.length === 1, "the scheduled run");
        const run = await rig.ctx.jobStore.latestScheduledRun("nightly");
        assert.ok(run);

        const once = await leadStartFor(rig.ctx, run);
        const again = await leadStartFor(rig.ctx, run);

        assert.equal(once.firstInput, again.firstInput);
        assert.match(once.firstInput, /read_schedule_runs/);
    });
});
