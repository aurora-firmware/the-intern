import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
const TEXT = "main .create-job textarea";
const CREATE = "main .create-job button";
const ORIGIN = "main .job-field[data-field='origin'] .job-value";
const CREATE_PATH = "/operations/jobs.create";

type Observed = { remoteAddress?: string; remotePort?: number };
type Job = { id: string; number: string; request: { origin: { kind: string; wayIn?: string; observed?: Observed } } };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startServer(): Promise<{ daemon: DaemonProcess; port: number }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
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
