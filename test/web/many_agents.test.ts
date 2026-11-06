import { afterEach, describe, it, type TestContext } from "node:test";
import type { BrowserContext, Page } from "playwright-core";
import { type BrowserName, launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 180_000;
const INVOKED_COUNT = 8;
const TAB_COUNT = 3;
const SETTLE_MS = 1500;
const WORKER_THREADS = INVOKED_COUNT + 2;

type Job = { id: string; number: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startManyAgentsJob(): Promise<{ daemon: DaemonProcess; port: number; job: Job; lead: string }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({
        hermetic: env,
        script: "invoke-many",
        networkListener: true,
        workerThreads: WORKER_THREADS,
    });
    daemons.push(daemon);
    await daemon.ready;
    const job = (await daemon.invoke("jobs.create", { text: "fan out" })) as Job;
    const detail = (await daemon.invoke("jobs.get", { job: job.id })) as { leadConversation?: string };
    if (detail.leadConversation === undefined) throw new Error(`job ${job.number} has no lead conversation`);
    return { daemon, port: await daemon.networkPort(), job, lead: detail.leadConversation };
}

const waitFor = (page: Page, condition: string) =>
    page.waitForFunction(condition, undefined, { timeout: WAIT_MS, polling: POLL_MS });

const SECTIONS = "main details.activity";
const ALL_SHOWN = `document.querySelectorAll("${SECTIONS}").length === ${INVOKED_COUNT + 1}`;

async function openTabs(context: BrowserContext, port: number, job: Job): Promise<Page[]> {
    const pages: Page[] = [];
    for (let index = 0; index < TAB_COUNT; index++) {
        const page = await context.newPage();
        await page.goto(pageUrl(port, `/ui/#/jobs/${job.number}`));
        pages.push(page);
    }
    for (const page of pages) await waitFor(page, ALL_SHOWN);
    return pages;
}

async function expectAllAgentsShown(t: TestContext, pages: Page[]): Promise<void> {
    for (const page of pages) {
        t.assert.equal(await page.locator(SECTIONS).count(), INVOKED_COUNT + 1);
        t.assert.equal(await page.locator(".connection-banner").count(), 0);
    }
}

async function runInThreeTabs(t: TestContext, name: BrowserName): Promise<void> {
    const rig = await startManyAgentsJob();
    const browser = await launchBrowser(t, name);
    if (browser === undefined) return;
    const context = await browser.newContext();
    const pages = await openTabs(context, rig.port, rig.job);
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    await expectAllAgentsShown(t, pages);

    const controls = pages[0]?.locator(`${SECTIONS}[data-conversation="${rig.lead}"] .conversation-controls`);
    if (controls === undefined) throw new Error("no page was opened");
    await controls.locator(".stop-open").click();
    await controls.locator(".stop-confirm").click();

    for (const page of pages) {
        await waitFor(
            page,
            `document.querySelector('main .job-field[data-field="status"] .job-value')?.textContent === "Blocked"`,
        );
    }
    await expectAllAgentsShown(t, pages);
}

describe("many invoked agents in three tabs over plain HTTP", () => {
    for (const name of ["chrome", "msedge", "firefox"] as const) {
        it(`keeps all eight agents shown in each tab and answers Stop in ${name}`, {
            timeout: TEST_TIMEOUT_MS,
        }, async (t) => {
            await runInThreeTabs(t, name);
        });
    }
});
