import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const BLOCKED_REASON = "which build is failing?";

type JobView = {
    id: string;
    number: string;
    title: string;
    status: string;
    blockedReason?: string;
    definitionOfDone: string;
    resolution?: { kind: string; justification: string };
    related: string[];
    request: { origin: { kind: string; wayIn?: string } };
};

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(): Promise<{ env: HermeticEnv; daemon: DaemonProcess }> {
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

async function startedJob(daemon: DaemonProcess, text: string, definitionOfDone?: string): Promise<JobView> {
    const created = (await daemon.invoke("jobs.create", { text })) as JobView;
    if (definitionOfDone !== undefined) {
        await daemon.invoke("jobs.update", { job: created.id, definitionOfDone });
    }
    await waitForStatus(daemon, created.id, "in_progress");
    return getJob(daemon, created.id);
}

async function bob(fixture: { env: HermeticEnv }, args: string[]) {
    return runBob(args, { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env });
}

describe("bob jobs usage", () => {
    it("prints the jobs usage for bob jobs --help and exits 0", async () => {
        const result = await runBob(["jobs", "--help"]);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Usage: bob jobs <command>/);
        assert.match(result.stdout, /create/);
        assert.match(result.stdout, /cancel/);
    });

    it("prints the usage of bob jobs list for bob jobs list --help and exits 0", async () => {
        const result = await runBob(["jobs", "list", "--help"]);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /Usage: bob jobs list/);
        assert.match(result.stdout, /--status/);
        assert.match(result.stdout, /--cursor/);
    });

    it("prints the jobs usage on standard error and exits 2 for an unknown flag, with no daemon to call", async () => {
        const env = await createHermeticEnv();
        envs.push(env);

        const result = await runBob(["jobs", "list", "--bogus"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Usage: bob jobs <command>/);
    });

    it("prints the jobs usage on standard error and exits 2 for bob jobs show with no job", async () => {
        const env = await createHermeticEnv();
        envs.push(env);

        const result = await runBob(["jobs", "show"], { runtimeDir: env.runtimeDir, env: env.env });

        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /Usage: bob jobs <command>/);
    });
});

describe("bob jobs create", () => {
    it("prints the new job's number and status and exits 0", async () => {
        const fixture = await readyDaemon();

        const result = await bob(fixture, ["jobs", "create", "Check why the nightly build is slow"]);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, /^C-\d+ created \(To do\)\n$/);
    });

    it("prints exactly the job jobs.create returns with --json, with origin letter C", async () => {
        const fixture = await readyDaemon();

        const result = await bob(fixture, ["jobs", "create", "Check why the nightly build is slow", "--json"]);

        assert.equal(result.status, 0, result.stderr);
        const printed = JSON.parse(result.stdout) as JobView;
        assert.match(printed.number, /^C-\d+$/);
        assert.equal(printed.request.origin.wayIn, "command line");
        const stored = await getJob(fixture.daemon, printed.id);
        assert.equal(stored.number, printed.number);
        assert.equal(stored.id, printed.id);
    });

    it("passes the title to jobs.create", async () => {
        const fixture = await readyDaemon();

        const result = await bob(fixture, ["jobs", "create", "Look into it", "--title", "A named job", "--json"]);

        assert.equal(result.status, 0, result.stderr);
        assert.equal((JSON.parse(result.stdout) as JobView).title, "A named job");
    });
});

describe("bob jobs list and show", () => {
    it("prints one line per Blocked job with its number, status, title and Blocked reason", async () => {
        const fixture = await readyDaemon();
        const blocked = await startedJob(fixture.daemon, "blocked one");
        await fixture.daemon.invoke("jobs.update", { job: blocked.id, title: "Slow nightly build" });
        await fixture.daemon.invoke("test.blockJob", { job: blocked.id, reason: BLOCKED_REASON });
        await startedJob(fixture.daemon, "still running");

        const result = await bob(fixture, ["jobs", "list", "--status", "blocked"]);

        assert.equal(result.status, 0, result.stderr);
        const lines = result.stdout.trim().split("\n");
        assert.equal(lines.length, 1, result.stdout);
        assert.ok(lines[0]?.includes(blocked.number), lines[0]);
        assert.match(lines[0] ?? "", /Blocked/);
        assert.ok(lines[0]?.includes("Slow nightly build"), lines[0]);
        assert.ok(lines[0]?.includes(BLOCKED_REASON), lines[0]);
    });

    it("prints the definition of done, status, worklog and history of a job named in lower case", async () => {
        const fixture = await readyDaemon();
        const job = await startedJob(fixture.daemon, "show me", "The build takes under ten minutes");
        await fixture.daemon.invoke("jobs.worklog.add", { job: job.id, text: "Found the slow step" });

        const result = await bob(fixture, ["jobs", "show", job.number.toLowerCase()]);

        assert.equal(result.status, 0, result.stderr);
        assert.ok(result.stdout.includes("The build takes under ten minutes"), result.stdout);
        assert.match(result.stdout, /In progress/);
        assert.ok(result.stdout.includes("Found the slow step"), result.stdout);
        assert.match(result.stdout, /definitionOfDone/);
    });

    it("prints one object keyed by the three operation names with --json", async () => {
        const fixture = await readyDaemon();
        const job = await startedJob(fixture.daemon, "show json");

        const result = await bob(fixture, ["jobs", "show", job.number, "--json"]);

        assert.equal(result.status, 0, result.stderr);
        const printed = JSON.parse(result.stdout) as Record<string, unknown>;
        assert.deepEqual(Object.keys(printed), ["jobs.get", "jobs.worklog.list", "jobs.history.list"]);
        assert.deepEqual(printed["jobs.get"], await fixture.daemon.invoke("jobs.get", { job: job.number }));
        assert.deepEqual(
            printed["jobs.worklog.list"],
            await fixture.daemon.invoke("jobs.worklog.list", { job: job.number }),
        );
    });
});

describe("bob jobs update, relate, complete and cancel", () => {
    it("prints each changed job and leaves jobs.get showing the same changes", async () => {
        const fixture = await readyDaemon();
        const first = await startedJob(fixture.daemon, "first", "It is done when it is done");
        const second = await startedJob(fixture.daemon, "second");

        const updated = await bob(fixture, ["jobs", "update", first.number, "--title", "Renamed job"]);
        const related = await bob(fixture, ["jobs", "relate", first.number, second.number]);
        const completed = await bob(fixture, ["jobs", "complete", first.number, "Checked and finished"]);
        const cancelled = await bob(fixture, ["jobs", "cancel", second.number, "No longer needed"]);

        for (const result of [updated, related, completed, cancelled]) {
            assert.equal(result.status, 0, result.stderr);
        }
        assert.ok(updated.stdout.includes("Renamed job"), updated.stdout);
        assert.ok(related.stdout.includes(first.number) && related.stdout.includes(second.number), related.stdout);
        assert.match(completed.stdout, /Done/);
        assert.match(cancelled.stdout, /Done/);
        const storedFirst = await getJob(fixture.daemon, first.id);
        const storedSecond = await getJob(fixture.daemon, second.id);
        assert.equal(storedFirst.title, "Renamed job");
        assert.deepEqual(storedFirst.related, [second.number]);
        assert.deepEqual(storedFirst.resolution, { kind: "completed", justification: "Checked and finished" });
        assert.deepEqual(storedSecond.resolution, { kind: "cancelled", justification: "No longer needed" });
    });

    it("removes the relation with unrelate", async () => {
        const fixture = await readyDaemon();
        const first = await startedJob(fixture.daemon, "first");
        const second = await startedJob(fixture.daemon, "second");
        await bob(fixture, ["jobs", "relate", first.number, second.number]);

        const result = await bob(fixture, ["jobs", "unrelate", first.number, second.number]);

        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual((await getJob(fixture.daemon, first.id)).related, []);
    });

    it("prints the service's invalid_input on standard error and exits 1 for an empty justification", async () => {
        const fixture = await readyDaemon();
        const job = await startedJob(fixture.daemon, "to finish", "Finished when checked");

        const result = await bob(fixture, ["jobs", "complete", job.number, ""]);

        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /^invalid_input: .*justification/);
    });
});
