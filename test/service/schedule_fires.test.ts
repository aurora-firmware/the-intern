/** A scheduled job at each due time (S-007 REQ-001, REQ-004, REQ-015: AC-001.2, AC-004.1, AC-004.2, AC-015.1). */
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { localTimeText } from "../../src/schedules/schedule_time.ts";
import { type ScheduleRig, startScheduleRig } from "../support/schedule_rig.ts";

const rigs: ScheduleRig[] = [];
const TEST_TIMEOUT_MS = 60_000;
const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 10;
const FAKE_MODEL = "faux/faux-1";
const MINUTE_MS = 60_000;
const at = (hour: number, minute = 0): Date => new Date(2026, 10, 8, hour, minute, 0);

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.dispose();
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

    it("creates no job and logs the refusal when the entry's workspace folder is gone", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith("");
        const workspace = join(rig.env.root, "project");
        await mkdir(workspace);
        await chmod(workspace, 0o700);
        await rig.invoke("workspaces.register", { path: workspace });
        const registered = await readFile(join(rig.env.configDir, "config.toml"), "utf8");
        await rig.restart(`${registered}\n${entryToml("audit", "0 2 * * *", `workspace = "${workspace}"\n`)}`);
        await rm(workspace, { recursive: true });
        rig.clock.set(at(2));
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        while (!rig.logs().includes(`The workspace folder ${workspace} does not exist.`)) {
            if (Date.now() > deadline) throw new Error(`the refusal was not logged in: ${rig.logs()}`);
            await sleep(POLL_INTERVAL_MS);
        }
        assert.deepEqual(await jobsOf(rig), []);
    });

    it("logs an access error when the workspace exists inside an inaccessible folder", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await rigWith("");
        const parent = join(rig.env.root, "projects");
        const workspace = join(parent, "audit");
        await mkdir(workspace, { recursive: true, mode: 0o700 });
        await rig.invoke("workspaces.register", { path: workspace });
        const registered = await readFile(join(rig.env.configDir, "config.toml"), "utf8");
        await rig.restart(`${registered}\n${entryToml("audit", "0 2 * * *", `workspace = "${workspace}"\n`)}`);
        await chmod(parent, 0o600);
        try {
            await assert.rejects(stat(workspace), { code: "EACCES" });
            rig.clock.set(at(2));
            const deadline = Date.now() + WAIT_TIMEOUT_MS;
            while (!rig.logs().includes("A schedule fire failed")) {
                if (Date.now() > deadline) throw new Error(`the access error was not logged in: ${rig.logs()}`);
                await sleep(POLL_INTERVAL_MS);
            }
            assert.match(rig.logs(), /EACCES/);
            assert.ok(rig.logs().includes(workspace));
            assert.ok(!rig.logs().includes(`The workspace folder ${workspace} does not exist.`));
            assert.deepEqual(await jobsOf(rig), []);
        } finally {
            await chmod(parent, 0o700);
        }
    });
});
