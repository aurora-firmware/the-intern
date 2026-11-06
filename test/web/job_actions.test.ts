import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const ACTIONS = "main .job-actions";
const JUSTIFICATION = `${ACTIONS} .job-finish textarea`;
const REFUSAL = `${ACTIONS} .refusal`;
const RELATED_LINKS = "main [data-section='related'] a";
const BANNER = ".connection-banner";

type Job = { id: string; number: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const proxies: WebProxy[] = [];

afterEach(async () => {
    for (const proxy of proxies.splice(0)) await proxy.stop();
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startJobs(count: number): Promise<{ daemon: DaemonProcess; port: number; jobs: Job[] }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "gated", networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    const jobs: Job[] = [];
    for (let index = 0; index < count; index++) {
        jobs.push((await daemon.invoke("jobs.create", { text: `job ${index}` })) as Job);
    }
    return { daemon, port: await daemon.networkPort(), jobs };
}

const waitFor = (page: Page, condition: string, argument?: unknown) =>
    page.waitForFunction(condition, argument, { timeout: WAIT_MS, polling: POLL_MS });

const fieldText = (page: Page, name: string) => page.locator(`main .job-field[data-field="${name}"] .job-value`);

const waitForField = (page: Page, name: string, text: string) =>
    waitFor(
        page,
        `document.querySelector('main .job-field[data-field="${name}"] .job-value')?.textContent === ${JSON.stringify(text)}`,
    );

async function openJob(page: Page, port: number, number: string): Promise<void> {
    await page.goto(pageUrl(port, `/ui/#/jobs/${number}`));
    await page.waitForSelector(`${ACTIONS} .job-edit`, { timeout: WAIT_MS });
}

describe("editing, finishing and relating a job from its page in chrome", () => {
    it("shows the new title on the page and the Board with no reload", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port, jobs } = await startJobs(1);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        const board = await browser.newPage();
        await board.goto(pageUrl(port, "/ui/#/"));
        await board.waitForSelector("main .board-card");
        await openJob(page, port, jobs[0].number);
        await page.evaluate(() => Object.assign(globalThis, { notReloaded: true }));

        await page.fill(`${ACTIONS} .job-edit [name="title"]`, "Paint the shed");
        await page.fill(`${ACTIONS} .job-edit [name="definitionOfDone"]`, "The shed is green");
        await page.click(`${ACTIONS} .job-edit button`);

        await waitForField(page, "title", "Paint the shed");
        await waitForField(page, "definition-of-done", "The shed is green");
        await waitFor(board, "document.querySelector('main .board-card')?.textContent?.includes('Paint the shed')");
        t.assert.equal(await page.evaluate(() => "notReloaded" in globalThis), true);
    });

    it("shows Done with the resolution cancelled when cancelled with a justification", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port, jobs } = await startJobs(1);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, port, jobs[0].number);

        await page.fill(JUSTIFICATION, "no longer needed");
        await page.click(`${ACTIONS} .job-cancel`);

        await waitForField(page, "status", "Done");
        await waitForField(page, "resolution", "cancelled");
        t.assert.equal(await fieldText(page, "justification").textContent(), "no longer needed");
    });

    it("shows the service's refusal and changes nothing when cancelled with an empty justification", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port, jobs } = await startJobs(1);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, port, jobs[0].number);

        await page.click(`${ACTIONS} .job-cancel`);

        await page.waitForSelector(REFUSAL, { timeout: WAIT_MS });
        t.assert.match((await page.locator(REFUSAL).textContent()) ?? "", /justification/i);
        t.assert.notEqual(await fieldText(page, "status").textContent(), "Done");
    });

    it("shows Done with the resolution completed for a job with a definition of done", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, jobs } = await startJobs(1);
        await daemon.invoke("jobs.update", { job: jobs[0].id, definitionOfDone: "The shed is green" });
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, port, jobs[0].number);

        await page.fill(JUSTIFICATION, "both coats dry");
        await page.click(`${ACTIONS} .job-complete`);

        await waitForField(page, "status", "Done");
        await waitForField(page, "resolution", "completed");
    });

    it("shows the service's refusal and leaves the job In progress when it has no definition of done", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port, jobs } = await startJobs(1);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, port, jobs[0].number);
        const before = await fieldText(page, "status").textContent();

        await page.fill(JUSTIFICATION, "done");
        await page.click(`${ACTIONS} .job-complete`);

        await page.waitForSelector(REFUSAL, { timeout: WAIT_MS });
        t.assert.match((await page.locator(REFUSAL).textContent()) ?? "", /definition of done/i);
        t.assert.equal(await fieldText(page, "status").textContent(), before);
    });

    it("shows the related job with its link, on both pages, then takes them away", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port, jobs } = await startJobs(2);
        const [first, second] = jobs;
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        const other = await browser.newPage();
        await openJob(page, port, first.number);
        await openJob(other, port, second.number);

        await page.fill(`${ACTIONS} .job-relate input`, second.number);
        await page.click(`${ACTIONS} .job-relate button`);

        await page.waitForSelector(RELATED_LINKS, { timeout: WAIT_MS });
        t.assert.equal(await page.locator(RELATED_LINKS).getAttribute("href"), `#/jobs/${second.number}`);
        await other.waitForSelector(RELATED_LINKS, { timeout: WAIT_MS });
        t.assert.equal(await other.locator(RELATED_LINKS).getAttribute("href"), `#/jobs/${first.number}`);

        await page.click("main .job-unrelate");

        await waitFor(page, `document.querySelector("main [data-section='related'] a") === null`);
        await waitFor(other, `document.querySelector("main [data-section='related'] a") === null`);
    });

    it("disables editing, finishing and relating while the service can't be reached", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port, jobs } = await startJobs(1);
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, port, jobs[0].number);
        await page.fill(`${ACTIONS} .job-edit [name="title"]`, "Changed");

        proxy.forceUnavailable("jobs.update");
        await page.click(`${ACTIONS} .job-edit button`);

        await page.waitForSelector(BANNER, { timeout: WAIT_MS });
        await waitFor(page, `document.querySelectorAll(${JSON.stringify(`${ACTIONS} button`)}).length > 0`);
        await waitFor(
            page,
            `[...document.querySelectorAll(${JSON.stringify(`${ACTIONS} button`)})].every((button) => button.disabled)`,
        );
        t.assert.equal(await page.locator(".refusal").count(), 0);
    });
});
