import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type BobChild, runBob, spawnBob } from "../support/bob_process.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const EXIT_OK = 0;
const EXIT_REFUSED = 1;
const WAIT_BOUND_MS = 30_000;
const POLL_INTERVAL_MS = 20;
const TEST_TIMEOUT_MS = 90_000;
const FAKE_PROVIDER = "faux";
const FAKE_MODEL = "faux-1";
const JUSTIFICATION = "stopped by the team";

type JobView = { id: string; number: string; status: string; leadConversation: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const children: BobChild[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) {
        child.signal("SIGKILL");
        await child.exited;
    }
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function newEnv(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }),
    );
    return env;
}

async function readyDaemon(env: HermeticEnv, script: FakeScript): Promise<DaemonProcess> {
    const daemon = startDaemon({ hermetic: env, script });
    daemons.push(daemon);
    await daemon.ready;
    return daemon;
}

function jobsFollow(env: HermeticEnv, ...args: string[]): BobChild {
    const child = spawnBob(["jobs", "follow", ...args], { runtimeDir: env.runtimeDir, env: env.env });
    children.push(child);
    return child;
}

async function untilTrue(isWanted: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await isWanted()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

const jobOf = async (daemon: DaemonProcess, job: string): Promise<JobView> =>
    (await daemon.invoke("jobs.get", { job })) as JobView;

async function createJob(daemon: DaemonProcess): Promise<JobView> {
    const created = (await daemon.invoke("jobs.create", { text: "invoke and complete" })) as JobView;
    await untilTrue(async () => (await jobOf(daemon, created.id)).status !== "to_do", "the job to start");
    return created;
}

function positionsOf(text: string, markers: readonly string[]): number[] {
    return markers.map((marker) => {
        const position = text.indexOf(marker);
        assert.ok(position >= 0, `the output holds ${JSON.stringify(marker)}; got ${text}`);
        return position;
    });
}

describe("bob jobs follow", () => {
    it("prints the activity of the lead and the invoked agent in order and exits 0 when the job is Done", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const env = await newEnv();
        // The first daemon holds the lead's answer, so the follow starts while the job is In progress; the second one
        // resumes the lead and the job runs to its end while the follow catches up after the restart.
        const held = await readyDaemon(env, "gated");
        const job = await createJob(held);
        const child = jobsFollow(env, job.number);
        await child.waitFor("stdout", job.number);
        await child.waitFor("stdout", "user:");

        held.kill9();
        await held.exited;
        await readyDaemon(env, "invoke-and-complete");

        assert.equal(await child.exited, EXIT_OK);
        const output = child.stdout();
        const markers = [
            "calls update_job",
            "calls invoke",
            "report from conversation",
            "calls complete_job",
            `${job.number} done (completed)`,
        ];
        const positions = positionsOf(output, markers);
        assert.deepEqual(
            positions,
            [...positions].sort((a, b) => a - b),
            `in order; got ${output}`,
        );
        assert.ok(output.includes("assistant: echo: job A"), "the invoked agent's activity");
    });

    it("prints the status changes of the job as they happen and ignores those of other jobs", async () => {
        const env = await newEnv();
        const daemon = await readyDaemon(env, "gated");
        const job = await createJob(daemon);
        const other = await createJob(daemon);
        const child = jobsFollow(env, job.number);
        await child.waitFor("stdout", "user:");

        await daemon.invoke("test.blockJob", { job: other.id, reason: "other reason" });
        await daemon.invoke("test.blockJob", { job: job.id, reason: "which build?" });
        await child.waitFor("stdout", `${job.number} blocked: which build?`);
        await daemon.invoke("jobs.resume", { job: job.id });
        await child.waitFor("stdout", `${job.number} resumed`);
        await daemon.invoke("jobs.cancel", { job: job.id, justification: JUSTIFICATION });

        assert.equal(await child.exited, EXIT_OK);
        assert.ok(child.stdout().includes(`${job.number} done (cancelled): ${JUSTIFICATION}`), child.stdout());
        assert.ok(!child.stdout().includes("other reason"), "the other job's change is not printed");
    });

    it("prints the resolution and exits 0 for a job that is already Done", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await newEnv();
        const daemon = await readyDaemon(env, "invoke-and-complete");
        const job = await createJob(daemon);
        await untilTrue(async () => (await jobOf(daemon, job.id)).status === "done", "the job to be Done");

        const result = await runBob(["jobs", "follow", job.number], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, EXIT_OK);
        assert.ok(result.stdout.includes(`${job.number} done (completed)`), result.stdout);
    });

    it("prints the service's refusal and exits 1 for a job that doesn't exist", async () => {
        const env = await newEnv();
        await readyDaemon(env, "echo");

        const result = await runBob(["jobs", "follow", "C-99"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, EXIT_REFUSED);
        assert.ok(result.stderr.includes("not_found"), result.stderr);
    });

    it("prints the jobs.get answer and each feed snapshot and delta unchanged with --json", async () => {
        const env = await newEnv();
        const daemon = await readyDaemon(env, "echo");
        const job = await createJob(daemon);
        const child = jobsFollow(env, job.number, "--json");
        await child.waitFor("stdout", '"entries"');

        await daemon.invoke("jobs.cancel", { job: job.id, justification: JUSTIFICATION });

        assert.equal(await child.exited, EXIT_OK);
        const values = child
            .stdout()
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(values[0].number, job.number, "the first value is the jobs.get answer");
        assert.ok(
            values.some((value) => Array.isArray(value.jobs)),
            "the instance snapshot",
        );
        assert.ok(
            values.some((value) => Array.isArray(value.entries)),
            "the conversation snapshot",
        );
        const done = values.find((value) => value.type === "job_done");
        assert.deepEqual(done?.resolution, { kind: "cancelled", justification: JUSTIFICATION });
    });
});
