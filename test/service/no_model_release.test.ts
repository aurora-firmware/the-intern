/**
 * The release of conversations that wait for a model (ADR-014 decisions 4 and 5; S-001 REQ-005, REQ-007, REQ-027): the
 * daemon takes up pi agent's default model when the folder comes to name one, seats it in every conversation with no
 * model and releases the waiting ones in order, and a team member's seat change releases one too. The tests run a
 * daemon on the fake model with one worker thread and rewrite `settings.json` in its isolated pi agent folder.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NOTICE_KIND } from "../../src/host/model_wait.ts";
import type { JobView } from "../../src/service/job_operations.ts";
import { ServiceError } from "../../src/service/operations.ts";
import { type DaemonProcess, type StartDaemonOptions, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { JOB_STATUS_DEADLINE_MS, waitForJobStatus } from "../support/job_status.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const POLL_MS = 20;
const FAKE_MODEL = "faux/faux-1";
const DESK_TEXT = "desk question";
const JOB_A_TEXT = "alpha job";
const JOB_B_TEXT = "beta job";

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.signal("SIGTERM");
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

type Entry = { kind: string; data: unknown };
type SeatData = {
    previous: { model: string | null } | null;
    next: { role: string; model: string | null };
    actor: { kind: string };
};
type Status = { workerThreads: { inUse: number; waiting: { conversationId: string; position: number }[] } };
type Request = { firstUserText: string };

async function until(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) assert.fail(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

// The folder names no default model: the daemon starts with the front desk and every lead having none.
async function startWithNoDefault(options: Partial<StartDaemonOptions> = {}) {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(join(env.piAgentDir, "settings.json"), "{}");
    const daemon = startDaemon({ hermetic: env, workerThreads: 1, turnEndRule: false, ...options });
    daemons.push(daemon);
    await daemon.ready;
    const entriesOf = async (conversationId: string): Promise<Entry[]> =>
        ((await daemon.invoke("conversations.entries", { conversationId, limit: 100 })) as { entries: Entry[] })
            .entries;
    const seatRecordsOf = async (conversationId: string): Promise<SeatData[]> =>
        (await entriesOf(conversationId))
            .filter((entry) => entry.kind === "intern.seat")
            .map((e) => e.data as SeatData);
    const kindsOf = async (conversationId: string): Promise<string[]> =>
        (await entriesOf(conversationId)).map((entry) => entry.kind);
    const submit = async (conversationId: string, content: string): Promise<void> => {
        const { submissionId } = (await daemon.invoke("conversations.submit", {
            conversationId,
            content,
            requestId: content,
        })) as { submissionId: string };
        assert.deepEqual(await daemon.invoke("submissions.wait", { submissionId, timeoutMs: WAIT_MS }), {
            state: "unanswered",
            reason: "no_model",
        });
    };
    const waitForNotice = (conversationId: string) =>
        until(async () => (await kindsOf(conversationId)).includes(NOTICE_KIND), "the notice");
    // A job whose lead has taken its first input and waits for a model.
    const createWaitingJob = async (text: string): Promise<JobView & { leadConversation: string }> => {
        const job = (await daemon.invoke("jobs.create", { text })) as JobView & { leadConversation: string };
        await waitForNotice(job.leadConversation);
        return job;
    };
    const requests = async (): Promise<string[]> =>
        ((await daemon.invoke("test.modelRequests", {})) as Request[]).map((request) => request.firstUserText);
    const requestsFor = async (text: string): Promise<number> =>
        (await requests()).filter((first) => first.includes(text)).length;
    const statusOf = async (job: string) => ((await daemon.invoke("jobs.get", { job })) as JobView).status;
    const setDefaultModel = (isNamed: boolean) =>
        writeFile(
            join(env.piAgentDir, "settings.json"),
            JSON.stringify(isNamed ? { defaultProvider: "faux", defaultModel: "faux-1" } : {}),
        );
    return {
        env,
        daemon,
        entriesOf,
        seatRecordsOf,
        kindsOf,
        submit,
        waitForNotice,
        createWaitingJob,
        requests,
        requestsFor,
        statusOf,
        setDefaultModel,
    };
}

describe("a daemon whose pi agent folder comes to name a default model", () => {
    it("starts the front desk and two leads in the order they began to wait, answering each input once", async () => {
        const rig = await startWithNoDefault({ script: "gated" });
        const { conversationId: desk } = (await rig.daemon.invoke("desk.get", {})) as { conversationId: string };
        await rig.submit(desk, DESK_TEXT);
        await rig.waitForNotice(desk);
        const jobA = await rig.createWaitingJob(JOB_A_TEXT);
        const jobB = await rig.createWaitingJob(JOB_B_TEXT);
        assert.notEqual(await rig.statusOf(jobA.id), "in_progress");

        await rig.setDefaultModel(true);

        // One worker thread: the desk holds it, and the leads wait for it in the order they waited for a model.
        await until(async () => {
            const { workerThreads } = (await rig.daemon.invoke("daemon.status", {})) as Status;
            return workerThreads.inUse === 1 && workerThreads.waiting.length === 2;
        }, "the desk to hold the worker thread and both leads to wait for one");
        const { workerThreads } = (await rig.daemon.invoke("daemon.status", {})) as Status;
        assert.deepEqual(
            [...workerThreads.waiting].sort((a, b) => a.position - b.position).map((w) => w.conversationId),
            [jobA.leadConversation, jobB.leadConversation],
        );
        assert.notEqual(await rig.statusOf(jobA.id), "in_progress");

        rig.daemon.releaseRuns();
        await until(async () => (await rig.requestsFor(JOB_B_TEXT)) >= 1, "the second lead's request");
        await waitForJobStatus(() => rig.statusOf(jobA.id), "in_progress", JOB_STATUS_DEADLINE_MS);

        const started = (await rig.requests()).filter(
            (first) => first.includes(DESK_TEXT) || first.includes(JOB_A_TEXT) || first.includes(JOB_B_TEXT),
        );
        assert.equal(started.length, 3);
        assert.ok(started[0]?.includes(DESK_TEXT));
        assert.ok(started[1]?.includes(JOB_A_TEXT));
        assert.ok(started[2]?.includes(JOB_B_TEXT));
        for (const id of [desk, jobA.leadConversation, jobB.leadConversation]) {
            await until(async () => (await rig.kindsOf(id)).includes("pi.assistant"), "the answer");
            const kinds = await rig.kindsOf(id);
            assert.equal(kinds.filter((kind) => kind === "pi.assistant").length, 1);
            assert.equal(kinds.filter((kind) => kind === NOTICE_KIND).length, 1);
        }
    });

    it("writes a seat record naming the daemon, no previous model and the fake model for each conversation", async () => {
        const rig = await startWithNoDefault();
        const { conversationId: desk } = (await rig.daemon.invoke("desk.get", {})) as { conversationId: string };
        const job = await rig.createWaitingJob(JOB_A_TEXT);

        await rig.setDefaultModel(true);

        for (const id of [desk, job.leadConversation]) {
            await until(async () => (await rig.seatRecordsOf(id)).length === 2, "the take-up's seat record");
            const [, taken] = await rig.seatRecordsOf(id);
            assert.equal(taken?.actor.kind, "daemon");
            assert.equal(taken?.previous?.model, null);
            assert.equal(taken?.next.model, FAKE_MODEL);
        }
    });
});

describe("a team member who reseats a waiting lead with a role whose model resolves", () => {
    it("runs the lead on its accepted input with nothing sent again and answers it once", async () => {
        const rig = await startWithNoDefault();
        await rig.daemon.invoke("roles.create", { name: "worker", instructions: "Work.", model: FAKE_MODEL });
        const job = await rig.createWaitingJob(JOB_A_TEXT);
        assert.equal(await rig.requestsFor(JOB_A_TEXT), 0);

        await rig.daemon.invoke("conversations.seat", { conversationId: job.leadConversation, role: "worker" });

        await until(async () => (await rig.kindsOf(job.leadConversation)).includes("pi.assistant"), "the answer");
        const kinds = await rig.kindsOf(job.leadConversation);
        assert.equal(kinds.filter((kind) => kind === "pi.user").length, 1);
        assert.equal(kinds.filter((kind) => kind === "pi.assistant").length, 1);
        assert.equal(await rig.requestsFor(JOB_A_TEXT), 1);
    });

    it("also releases it when the seat change names a reset", async () => {
        const rig = await startWithNoDefault();
        await rig.daemon.invoke("roles.create", { name: "worker", instructions: "Work.", model: FAKE_MODEL });
        const job = await rig.createWaitingJob(JOB_A_TEXT);

        await rig.daemon.invoke("conversations.seat", {
            conversationId: job.leadConversation,
            role: "worker",
            reset: { note: "Start again." },
        });

        await until(async () => (await rig.kindsOf(job.leadConversation)).includes("pi.assistant"), "the answer");
        assert.equal(await rig.requestsFor("Start again."), 1);
    });
});

describe("a pi agent folder that stops naming a default model", () => {
    it("seats a new job's lead as bob with no model and leaves the seat that took up the default unchanged", async () => {
        const rig = await startWithNoDefault();
        const { conversationId: desk } = (await rig.daemon.invoke("desk.get", {})) as { conversationId: string };
        // The registry the daemon opens when the folder changes lacks the fake model, so the probe is made before.
        const probe = await rig.createWaitingJob("probe");
        await rig.setDefaultModel(true);
        await until(async () => (await rig.seatRecordsOf(desk)).length === 2, "the desk to take up the default");

        await rig.setDefaultModel(false);
        // A seat change resolves the seat from the folder as the daemon last read it, so it shows when the daemon noticed.
        // Until then the registry of the folder's new reading refuses the fake model the folder still names.
        await until(async () => {
            try {
                const seat = (await rig.daemon.invoke("conversations.seat", {
                    conversationId: probe.leadConversation,
                    role: "bob",
                })) as { model: string | null };
                return seat.model === null;
            } catch (error) {
                if (error instanceof ServiceError && error.code === "invalid_input") return false;
                throw error;
            }
        }, "the daemon to notice that the folder names no default model");
        const job = await rig.createWaitingJob(JOB_B_TEXT);

        const [seatRecord] = await rig.seatRecordsOf(job.leadConversation);
        assert.equal(seatRecord?.next.role, "bob");
        assert.equal(seatRecord?.next.model, null);
        const kinds = (await rig.kindsOf(job.leadConversation)).filter((kind) => kind !== "intern.seat");
        assert.deepEqual(kinds, ["pi.user", NOTICE_KIND]);
        const deskSeats = await rig.seatRecordsOf(desk);
        assert.equal(deskSeats.length, 2);
        assert.equal(deskSeats[1]?.next.model, FAKE_MODEL);
    });
});
