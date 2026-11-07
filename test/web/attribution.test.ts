import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
const TEXT = "main .create-job textarea";
const CREATE = "main .create-job button";
const ORIGIN = "main .job-field[data-field='origin'] .job-value";
const DESK_BOX = "main .desk textarea";
const DESK_SEND = "main .desk .desk-send";
const CREATE_PATH = "/operations/jobs.create";

type Observed = { remoteAddress?: string; remotePort?: number };
type Origin = { kind: string; wayIn?: string; observed?: Observed; frontDesk?: string; jobId?: string };
type Job = { id: string; number: string; leadConversation?: string; request: { origin: Origin } };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startServer(script: FakeScript = "echo"): Promise<{ daemon: DaemonProcess; port: number }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return { daemon, port: await daemon.networkPort() };
}

/** The bodies of the `jobs.create` requests the page sends, read as the browser sends them. */
function recordCreateBodies(page: Page): string[] {
    const bodies: string[] = [];
    page.on("request", (request) => {
        if (new URL(request.url()).pathname === CREATE_PATH) bodies.push(request.postData() ?? "");
    });
    return bodies;
}

describe("attribution of a job created from a browser on a loopback address in chrome", () => {
    it("records the web interface and the address, shows them, and sends no name", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        const bodies = recordCreateBodies(page);
        await page.goto(pageUrl(port, "/ui/#/desk"));
        await page.waitForSelector(TEXT, { timeout: WAIT_MS });

        await page.fill(TEXT, "paint the fence");
        await page.click(CREATE);

        await page.waitForSelector(ORIGIN, { timeout: WAIT_MS });
        const [listed] = ((await daemon.invoke("jobs.list", {})) as { jobs: Job[] }).jobs;
        const job = (await daemon.invoke("jobs.get", { job: listed?.id })) as Job;
        const { origin } = job.request;
        t.assert.match(job.number, /^W-\d+$/);
        t.assert.equal(origin.kind, "request");
        t.assert.equal(origin.wayIn, "web interface");
        t.assert.match(origin.observed?.remoteAddress ?? "", /127\.0\.0\.1$/);
        t.assert.equal(typeof origin.observed?.remotePort, "number");
        t.assert.equal(
            await page.locator(ORIGIN).textContent(),
            `Request by web interface from ${origin.observed?.remoteAddress}:${origin.observed?.remotePort}`,
        );

        t.assert.equal(bodies.length, 1);
        t.assert.deepEqual(Object.keys(JSON.parse(bodies[0] ?? "{}")), ["text"]);
    });
});

const POLL_MS = 100;

async function until<T>(describeWait: string, read: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const value = await read();
        if (value !== undefined) return value;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${describeWait}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const jobsOf = async (daemon: DaemonProcess): Promise<Job[]> =>
    ((await daemon.invoke("jobs.list", {})) as { jobs: Job[] }).jobs;
const getJob = async (daemon: DaemonProcess, job: string): Promise<Job> =>
    (await daemon.invoke("jobs.get", { job })) as Job;

/** A job the team member creates directly, and the follow-up job its lead creates on an input `create job <text>`. */
async function createFollowUp(daemon: DaemonProcess): Promise<{ original: Job; followUp: Job }> {
    await daemon.invoke("jobs.create", { text: "paint the fence" });
    const [listed] = await jobsOf(daemon);
    const original = await getJob(daemon, listed?.id ?? "");
    await daemon.invoke("conversations.submit", {
        conversationId: original.leadConversation,
        content: "create job sand the gate",
        requestId: "follow-up-1",
        busyMode: "followUp",
    });
    const followUp = await until("the follow-up job", async () => {
        const other = (await jobsOf(daemon)).find((job) => job.id !== original.id);
        return other === undefined ? undefined : await getJob(daemon, other.id);
    });
    return { original, followUp };
}

describe("the origin of a job the front desk or a lead created, shown in chrome", () => {
    it("shows the front desk's job as a request by the web interface through the front desk, with no address", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer("desk-create-job");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/desk"));
        await page.waitForSelector(DESK_BOX, { timeout: WAIT_MS });
        await page.fill(DESK_BOX, "create job paint the fence");
        await page.click(DESK_SEND);
        const job = await until("the front desk's job", async () => (await jobsOf(daemon))[0]);
        t.assert.equal(typeof (await getJob(daemon, job.id)).request.origin.frontDesk, "string");

        await page.goto(pageUrl(port, `/ui/#/jobs/${job.number}`));

        await page.waitForSelector(ORIGIN, { timeout: WAIT_MS });
        t.assert.equal(await page.locator(ORIGIN).textContent(), "Request by web interface through the front desk");
    });

    it("shows a follow-up job as a follow-up of the job it came from, by that job's short number", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer("desk-create-job");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const { original, followUp } = await createFollowUp(daemon);
        t.assert.equal(followUp.request.origin.jobId, original.id);
        const page = await browser.newPage();

        await page.goto(pageUrl(port, `/ui/#/jobs/${followUp.number}`));

        await page.waitForFunction(
            (wanted) =>
                document.querySelector("main .job-field[data-field='origin'] .job-value")?.textContent === wanted,
            `Follow-up of job ${original.number}`,
            { timeout: WAIT_MS, polling: POLL_MS },
        );
    });

    it("shows Follow-up of another job, and never a job ID, when the short number can't be read", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer("desk-create-job");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const { original, followUp } = await createFollowUp(daemon);
        const page = await browser.newPage();
        await page.route("**/operations/jobs.get", (route) =>
            route.request().postData()?.includes(original.id)
                ? route.fulfill({ status: 500, body: "{}" })
                : route.continue(),
        );

        await page.goto(pageUrl(port, `/ui/#/jobs/${followUp.number}`));

        await page.waitForSelector(ORIGIN, { timeout: WAIT_MS });
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const text = await page.locator(ORIGIN).textContent();
        t.assert.equal(text, "Follow-up of another job");
        t.assert.equal(text?.includes(original.id), false);
    });
});
