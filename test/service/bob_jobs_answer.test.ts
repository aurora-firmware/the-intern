import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const ANSWER_TEXT = "use the staging database";
const BLOCKED_REASON = "which database should I use?";

type JobView = { id: string; number: string; status: string; leadConversation?: string };
type Fixture = { env: HermeticEnv; daemon: DaemonProcess };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

const getJob = async (daemon: DaemonProcess, job: string) => (await daemon.invoke("jobs.get", { job })) as JobView;

async function waitForStatus(daemon: DaemonProcess, job: string, status: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while ((await getJob(daemon, job)).status !== status) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${job} to be ${status}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function startedJob(daemon: DaemonProcess): Promise<JobView> {
    const created = (await daemon.invoke("jobs.create", { text: "Pick the database" })) as JobView;
    await waitForStatus(daemon, created.id, "in_progress");
    return getJob(daemon, created.id);
}

async function blockedJob(daemon: DaemonProcess): Promise<JobView> {
    const job = await startedJob(daemon);
    await daemon.invoke("test.blockJob", { job: job.id, reason: BLOCKED_REASON });
    await waitForStatus(daemon, job.id, "blocked");
    return job;
}

const bob = (fixture: Fixture, args: string[]) =>
    runBob(args, { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env });

async function transcriptOf(daemon: DaemonProcess, conversationId: string): Promise<string> {
    return JSON.stringify(await daemon.invoke("conversations.entries", { conversationId, limit: 500 }));
}

describe("bob jobs answer", () => {
    it("sends the text to the lead of a Blocked job, records the command line way in and resumes the job", async () => {
        const fixture = await readyDaemon();
        const job = await blockedJob(fixture.daemon);

        const result = await bob(fixture, ["jobs", "answer", job.number, ANSWER_TEXT]);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `sent to ${job.number}'s lead\n`);
        const transcript = await transcriptOf(fixture.daemon, job.leadConversation as string);
        assert.ok(transcript.includes(ANSWER_TEXT), transcript);
        assert.ok(transcript.includes("command line"), transcript);
        await waitForStatus(fixture.daemon, job.id, "in_progress");
    });

    it("prints the service's code and message on standard error and exits 1 for an unknown job", async () => {
        const fixture = await readyDaemon();

        const result = await bob(fixture, ["jobs", "answer", "C-999", ANSWER_TEXT]);

        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /^not_found: /);
    });

    it("prints exactly the answer of conversations.submit with --json", async () => {
        const fixture = await readyDaemon();
        const job = await blockedJob(fixture.daemon);

        const result = await bob(fixture, ["jobs", "answer", job.number, ANSWER_TEXT, "--json"]);

        assert.equal(result.status, 0, result.stderr);
        const printed = JSON.parse(result.stdout) as Record<string, unknown>;
        assert.deepEqual(Object.keys(printed).sort(), ["submissionId"]);
        assert.equal(typeof printed.submissionId, "string");
    });
});
