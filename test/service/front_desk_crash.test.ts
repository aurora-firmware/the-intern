/**
 * The front desk across a real `kill -9` (S-001 AC-021.3, AC-021.5, AC-022.7; S-004 AC-022.2): the child daemon kills
 * itself where the front desk is created (`deskCrashAt`) or the test kills it mid-run, and a second child starts on the
 * same instance. `desk.get` names the front desk; steering it is a `conversations.submit` as a team member's.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const POLL_INTERVAL_MS = 10;
const WAIT_BOUND_MS = 30_000;
const TEST_TIMEOUT_MS = 90_000;
const SETTLE_TIMEOUT_MS = 30_000;
const LIMIT = 200;
const SLOW_DELAY_MS = 3_000;
const LEAD_MESSAGE = "from-desk";
const DESK_INPUT = "what is the status";

type Entry = { kind: string; data: unknown };
type Listing = { id: string; isFrontDesk: boolean; status: string };
type JobView = { id: string; leadConversation?: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

function start(
    env: HermeticEnv,
    script: FakeScript,
    options: { deskCrashAt?: "before-commit" | "after-commit"; jobCrashAt?: "job-completed" } = {},
): DaemonProcess {
    const daemon = startDaemon({ hermetic: env, script, delayMs: SLOW_DELAY_MS, turnEndRule: false, ...options });
    daemons.push(daemon);
    return daemon;
}

async function untilTrue(isWanted: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await isWanted()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

async function entriesOf(daemon: DaemonProcess, conversationId: string): Promise<Entry[]> {
    const { entries } = (await daemon.invoke("conversations.entries", { conversationId, limit: LIMIT })) as {
        entries: Entry[];
    };
    return entries;
}

const deskIdOf = async (daemon: DaemonProcess) =>
    ((await daemon.invoke("desk.get", {})) as { conversationId: string }).conversationId;

const mentions = (text: string) => (entry: Entry) => JSON.stringify(entry.data).includes(text);
const ofKind = (kind: string, text: string) => (entry: Entry) => entry.kind === kind && mentions(text)(entry);

async function countOf(daemon: DaemonProcess, conversationId: string, isCounted: (entry: Entry) => boolean) {
    return (await entriesOf(daemon, conversationId)).filter(isCounted).length;
}

async function untilKilled(daemon: DaemonProcess): Promise<void> {
    assert.equal((await daemon.exited).signal, "SIGKILL");
}

async function crash(daemon: DaemonProcess): Promise<void> {
    daemon.kill9();
    await daemon.exited;
}

async function submitToDesk(daemon: DaemonProcess, content: string): Promise<{ deskId: string; submissionId: string }> {
    const deskId = await deskIdOf(daemon);
    const { submissionId } = (await daemon.invoke("conversations.submit", {
        conversationId: deskId,
        content,
        requestId: `request-${content}`,
    })) as { submissionId: string };
    return { deskId, submissionId };
}

/** Waits until the desk's run has taken the input and has not answered, which is the span of its model request. */
async function untilDeskRunning(daemon: DaemonProcess, deskId: string): Promise<void> {
    await untilTrue(
        async () => (await countOf(daemon, deskId, ofKind("intern.steer", DESK_INPUT))) === 1,
        "the desk's input",
    );
    assert.equal(
        await countOf(daemon, deskId, (entry) => entry.kind === "pi.assistant"),
        0,
        "the desk already answered",
    );
}

async function createJob(daemon: DaemonProcess): Promise<string> {
    const job = (await daemon.invoke("jobs.create", { text: "a job for the desk to steer" })) as JobView;
    assert.ok(job.leadConversation, "the created job names its lead conversation");
    return job.leadConversation;
}

describe("kill -9 around the commit that creates the front desk", () => {
    for (const point of ["before-commit", "after-commit"] as const) {
        it(`keeps one front desk with the same id on every later start when killed ${point}`, {
            timeout: TEST_TIMEOUT_MS,
        }, async () => {
            const env = await hermetic();
            const first = start(env, "echo", { deskCrashAt: point });
            await untilKilled(first);

            const second = start(env, "echo");
            await second.ready;
            const deskId = await deskIdOf(second);
            await crash(second);
            const third = start(env, "echo");
            await third.ready;

            assert.equal(await deskIdOf(third), deskId);
            const listed = (await third.invoke("conversations.list", {})) as Listing[];
            assert.deepEqual(
                listed.filter((conversation) => conversation.isFrontDesk).map((conversation) => conversation.id),
                [deskId],
            );
        });
    }
});

describe("kill -9 during a front-desk run", () => {
    it("resumes the run and answers the team member's message once", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env, "gated");
        await first.ready;
        const { deskId, submissionId } = await submitToDesk(first, DESK_INPUT);
        await untilDeskRunning(first, deskId);
        await crash(first);

        const second = start(env, "gated");
        await second.ready;
        second.releaseRuns();

        assert.deepEqual(await second.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS }), {
            state: "done",
        });
        assert.equal(await deskIdOf(second), deskId);
        assert.equal(await countOf(second, deskId, ofKind("intern.steer", DESK_INPUT)), 1);
        assert.equal(await countOf(second, deskId, ofKind("pi.assistant", `echo: ${DESK_INPUT}`)), 1);
    });
});

describe("kill -9 during the front desk's send_to_conversation call", () => {
    it("holds the input in the lead's transcript once, under the call's request id", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "desk-steer");
        await first.ready;
        const leadId = await createJob(first);
        const { deskId, submissionId } = await submitToDesk(first, `steer ${leadId}`);
        await untilTrue(
            async () => (await countOf(first, leadId, ofKind("intern.steer", LEAD_MESSAGE))) > 0,
            "the steer to reach the lead",
        );
        await crash(first);

        const second = start(env, "desk-steer");
        await second.ready;

        assert.deepEqual(await second.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS }), {
            state: "done",
        });
        const deskEntries = await entriesOf(second, deskId);
        const call = deskEntries.find(ofKind("pi.assistant", '"send_to_conversation"'));
        const toolCallId = /"id":"([^"]+)","name":"send_to_conversation"/.exec(JSON.stringify(call?.data))?.[1];
        assert.ok(toolCallId, "the desk's transcript holds the tool call and its id");
        assert.equal(await countOf(second, leadId, ofKind("intern.steer", LEAD_MESSAGE)), 1);
        assert.equal(await countOf(second, leadId, ofKind("pi.assistant", `echo: ${LEAD_MESSAGE}`)), 1);

        // A submission with the call's request id is a repeat of the steer: it places no second input.
        await second.invoke("conversations.submit", {
            conversationId: leadId,
            content: LEAD_MESSAGE,
            requestId: `steer:${deskId}:${toolCallId}`,
            busyMode: "steer",
        });
        assert.equal(await countOf(second, leadId, ofKind("intern.steer", LEAD_MESSAGE)), 1);
        assert.equal(await countOf(second, leadId, ofKind("pi.user", LEAD_MESSAGE)), 0);
    });
});

describe("kill -9 while the front desk runs and a Done job has a running conversation", () => {
    it("aborts the job's conversation by repair rule 4 and answers the desk's input once", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await hermetic();
        const first = start(env, "gated", { jobCrashAt: "job-completed" });
        await first.ready;
        const leadId = await createJob(first);
        const { deskId, submissionId } = await submitToDesk(first, DESK_INPUT);
        await untilDeskRunning(first, deskId);
        await untilTrue(
            async () =>
                ((await first.invoke("conversations.get", { conversationId: leadId })) as Listing).status === "running",
            "the lead to run",
        );
        const [jobId] = ((await first.invoke("jobs.list", {})) as { jobs: JobView[] }).jobs.map((job) => job.id);
        await first.invoke("jobs.update", { job: jobId, definitionOfDone: "the work is stopped" });
        const completing = first.invoke("jobs.complete", { job: jobId, justification: "done" }).catch(() => undefined);
        await untilKilled(first);
        await completing;

        const second = start(env, "gated");
        await second.ready;

        const history = (await second.invoke("jobs.history.list", { job: jobId, limit: LIMIT })) as {
            entries: { field: string; new: { rule: number } }[];
        };
        assert.deepEqual(
            history.entries.filter((entry) => entry.field === "repair").map((entry) => entry.new.rule),
            [4],
        );
        assert.equal(
            ((await second.invoke("conversations.get", { conversationId: leadId })) as Listing).status,
            "idle",
        );
        second.releaseRuns();
        assert.deepEqual(await second.invoke("submissions.wait", { submissionId, timeoutMs: SETTLE_TIMEOUT_MS }), {
            state: "done",
        });
        assert.equal(await countOf(second, deskId, ofKind("intern.steer", DESK_INPUT)), 1);
        assert.equal(await countOf(second, deskId, ofKind("pi.assistant", `echo: ${DESK_INPUT}`)), 1);
    });
});
