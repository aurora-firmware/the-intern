import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type BobChild, runBob, spawnBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const BLOCKED_REASON = "which build is failing?";
const JUSTIFICATION = "the build is green";
const EXIT_OK = 0;

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
    return env;
}

async function readyDaemon(env: HermeticEnv): Promise<DaemonProcess> {
    const daemon = startDaemon({ hermetic: env, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return daemon;
}

function follow(env: HermeticEnv, ...flags: string[]): BobChild {
    const child = spawnBob(["follow", ...flags], { runtimeDir: env.runtimeDir, env: env.env });
    children.push(child);
    return child;
}

// The text output has no marker of a subscription, so probe jobs are created until one shows as a line.
async function waitUntilFollowing(daemon: DaemonProcess, child: BobChild): Promise<void> {
    const deadline = Date.now() + 20_000;
    const createdLines = () => child.stdout().split(" created ").length;
    const before = createdLines();
    while (createdLines() === before) {
        assert.ok(Date.now() < deadline, "timed out waiting for the follow to print a probe job");
        await daemon.invoke("jobs.create", { text: "probe" });
        await new Promise((resolve) => setTimeout(resolve, 200));
    }
}

async function waitForStatus(daemon: DaemonProcess, job: string, status: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (((await daemon.invoke("jobs.get", { job })) as JobView).status !== status) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${job} to be ${status}`);
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
}

async function createJob(daemon: DaemonProcess): Promise<JobView> {
    const job = (await daemon.invoke("jobs.create", { text: "do it" })) as JobView;
    await waitForStatus(daemon, job.id, "in_progress");
    await daemon.invoke("jobs.update", { job: job.id, definitionOfDone: "the build is green" });
    return job;
}

describe("bob follow", () => {
    it("prints a line for a job created, blocked, resumed and completed and for the lead's runs", async () => {
        const env = await newEnv();
        const daemon = await readyDaemon(env);
        const child = follow(env);
        await waitUntilFollowing(daemon, child);

        const job = await createJob(daemon);
        await child.waitFor("stdout", `${job.number} created`);
        await child.waitFor("stdout", `Agent run started in conversation ${job.leadConversation}`);
        await child.waitFor("stdout", `Agent run finished in conversation ${job.leadConversation}`);

        await daemon.invoke("test.blockJob", { job: job.id, reason: BLOCKED_REASON });
        await child.waitFor("stdout", `${job.number} blocked: ${BLOCKED_REASON}`);

        await daemon.invoke("jobs.resume", { job: job.id });
        await child.waitFor("stdout", `${job.number} resumed`);

        await daemon.invoke("jobs.complete", { job: job.id, justification: JUSTIFICATION });
        await child.waitFor("stdout", `${job.number} done (completed): ${JUSTIFICATION}`);
    });

    it("prints a notice on standard error and resumes when the daemon starts again", async () => {
        const env = await newEnv();
        const daemon = await readyDaemon(env);
        const child = follow(env);
        await waitUntilFollowing(daemon, child);

        daemon.kill9();
        await daemon.exited;
        await child.waitFor("stderr", "trying again");

        const restarted = await readyDaemon(env);
        await waitUntilFollowing(restarted, child);
        assert.ok(!child.stdout().includes("trying again"), "the notice is not data");
    });

    it("prints each snapshot and delta unchanged as one JSON value per line with --json", async () => {
        const env = await newEnv();
        const daemon = await readyDaemon(env);
        const child = follow(env, "--json");
        await child.waitFor("stdout", '"jobs"');

        const job = await createJob(daemon);
        await child.waitFor("stdout", '"type":"job_created"');
        await daemon.invoke("jobs.cancel", { job: job.id, justification: JUSTIFICATION });
        await child.waitFor("stdout", '"type":"job_done"');

        const values = child
            .stdout()
            .split("\n")
            .filter((line) => line !== "")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.ok("snapshot" in values[0] || "conversations" in values[0], "the first value is the snapshot");
        const deltas = values.filter((value) => typeof value.type === "string");
        assert.ok(deltas.some((delta) => delta.type === "job_created" && delta.seq !== undefined));
        const done = deltas.find((delta) => delta.type === "job_done");
        assert.deepEqual(done?.resolution, { kind: "cancelled", justification: JUSTIFICATION });
    });

    it("stops following and exits 0 when interrupted", async () => {
        const env = await newEnv();
        const daemon = await readyDaemon(env);
        const child = follow(env);
        await waitUntilFollowing(daemon, child);

        child.signal("SIGINT");

        assert.equal(await child.exited, EXIT_OK);
    });
});

describe("bob follow at its start", () => {
    it("says it isn't running and exits 3 when no daemon runs in the runtime directory", async () => {
        const env = await newEnv();

        const result = await runBob(["follow"], { runtimeDir: env.runtimeDir, env: env.env, deadlineMs: 20_000 });

        assert.equal(result.status, 3, result.stderr);
        assert.equal(result.stdout, "");
        assert.equal(
            result.stderr.trim(),
            `The Intern isn't running here (${env.runtimeDir}/bob.sock); start it with \`bob serve\``,
        );
    });

    it("exits 2 with one line on standard error when the runtime directory is relative", async () => {
        const env = await newEnv();

        const result = await runBob(["follow"], { runtimeDir: "relative/run", env: env.env, deadlineMs: 20_000 });

        assert.equal(result.status, 2, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /^[^\n]*relative\/run[^\n]*absolute path[^\n]*\n$/);
    });
});

describe("bob follow when the reader of its output goes away", () => {
    it("exits 0 with no error output when standard output is closed after the first line", async () => {
        const env = await newEnv();
        const daemon = await readyDaemon(env);
        const child = follow(env);
        await waitUntilFollowing(daemon, child);

        child.closeStdout();
        const deadline = Date.now() + 20_000;
        let status: number | null | undefined;
        child.exited.then((exit) => {
            status = exit;
        });
        while (status === undefined && Date.now() < deadline) {
            await daemon.invoke("jobs.create", { text: "after the reader left" });
            await new Promise((resolve) => setTimeout(resolve, 100));
        }

        assert.equal(status, EXIT_OK, child.stderr());
        assert.equal(child.stderr(), "");
    });
});
