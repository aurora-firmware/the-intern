import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const TEXT = "main .create-job textarea";
const TITLE = "main .create-job input";
const CREATE = "main .create-job button";
const REFUSAL = "main .create-job .refusal";
const BANNER = ".connection-banner";

type Job = { id: string; number: string; title?: string; text?: string };

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

const waitFor = (page: Page, condition: string, argument?: unknown) =>
    page.waitForFunction(condition, argument, { timeout: WAIT_MS, polling: POLL_MS });

async function openDesk(page: Page, port: number): Promise<void> {
    await page.goto(pageUrl(port, "/ui/#/desk"));
    await page.waitForSelector(TEXT, { timeout: WAIT_MS });
}

const jobsOf = async (daemon: DaemonProcess): Promise<Job[]> =>
    ((await daemon.invoke("jobs.list", {})) as { jobs: Job[] }).jobs;

describe("creating a job from the Front desk page in chrome", () => {
    it("opens the new job as W-n and shows it on the Board", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openDesk(page, port);

        await page.fill(TITLE, "Fence");
        await page.fill(TEXT, "paint the fence");
        await page.click(CREATE);

        await waitFor(page, "/^#\\/jobs\\/W-\\d+$/.test(location.hash)");
        const [job] = await jobsOf(daemon);
        t.assert.match(job?.number ?? "", /^W-\d+$/);
        t.assert.equal(await page.evaluate(() => location.hash), `#/jobs/${job?.number}`);
        t.assert.equal(job?.title, "Fence");
        await page.evaluate(() => Object.assign(location, { hash: "#/" }));
        await page.waitForSelector(`main a[href='#/jobs/${job?.number}']`, { timeout: WAIT_MS });
    });

    it("shows the service's refusal for empty text and creates nothing", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openDesk(page, port);

        await page.click(CREATE);

        await page.waitForSelector(REFUSAL, { timeout: WAIT_MS });
        t.assert.notEqual((await page.locator(REFUSAL).textContent()) ?? "", "");
        t.assert.deepEqual(await jobsOf(daemon), []);
        t.assert.equal(await page.evaluate(() => location.hash), "#/desk");
    });

    it("disables creating a job while the service can't be reached", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openDesk(page, port);
        await page.fill(TEXT, "paint the fence");

        daemon.kill9();
        await daemon.exited;

        await waitFor(page, `document.querySelector(${JSON.stringify(BANNER)}) !== null`);
        t.assert.equal(await page.locator(CREATE).isDisabled(), true);
    });
});
