import { afterEach, describe, it, type TestContext } from "node:test";
import type { Page } from "playwright-core";
import { type BrowserName, launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const BROWSERS: BrowserName[] = ["chrome", "msedge", "firefox"];
const WAIT_MS = 20_000;
const TEST_TIMEOUT_MS = 120_000;
const PAGES = [
    { name: "Front desk", hash: "#/desk" },
    { name: "Roles", hash: "#/roles" },
    { name: "Workspaces", hash: "#/workspaces" },
    { name: "Status", hash: "#/status" },
    { name: "Board", hash: "#/" },
];

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

async function startRig(): Promise<{ port: number; job: Job }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    const job = (await daemon.invoke("jobs.create", { text: "paint the shed" })) as Job;
    await daemon.invoke("jobs.update", { job: job.id, title: "Paint the shed" });
    return { port: await daemon.networkPort(), job };
}

const hashOf = (page: Page) => new URL(page.url()).hash;
const heading = (page: Page) => page.locator("main h2.page-heading").textContent();
const jobTitle = (page: Page) => page.locator("main .job-field[data-field='title'] .job-value");

const waitForHeading = (page: Page, text: string) =>
    page.waitForFunction((wanted) => document.querySelector("main h2.page-heading")?.textContent === wanted, text, {
        timeout: WAIT_MS,
    });

const waitForCard = (page: Page, number: string) =>
    page.waitForSelector(`main .board-card a[href='#/jobs/${number}']`, { timeout: WAIT_MS });

const waitForJobTitle = (page: Page, title: string) =>
    page.waitForFunction(
        (wanted) => document.querySelector("main .job-field[data-field='title'] .job-value")?.textContent === wanted,
        title,
        { timeout: WAIT_MS },
    );

async function followEachSidebarLink(t: TestContext, page: Page): Promise<void> {
    for (const link of PAGES) {
        await page.locator(".sidebar a", { hasText: link.name }).click();
        await waitForHeading(page, link.name);
        t.assert.equal(hashOf(page), link.hash);
    }
}

async function reloadEachPage(t: TestContext, page: Page, port: number): Promise<void> {
    for (const link of PAGES) {
        await page.goto(pageUrl(port, `/ui/${link.hash}`));
        await page.reload();
        await waitForHeading(page, link.name);
        t.assert.equal(hashOf(page), link.hash);
    }
}

for (const name of BROWSERS) {
    describe(`moving between pages in ${name}`, () => {
        it("opens each page at its own address, returns to the Board on back and keeps the page on reload", {
            timeout: TEST_TIMEOUT_MS,
        }, async (t) => {
            const { port, job } = await startRig();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) return;
            const page = await browser.newPage();
            await page.goto(pageUrl(port, "/ui/#/"));
            await waitForHeading(page, "Board");

            await followEachSidebarLink(t, page);
            await reloadEachPage(t, page, port);

            await waitForCard(page, job.number);
            await page.locator(`main .board-card a[href='#/jobs/${job.number}']`).click();
            await waitForJobTitle(page, "Paint the shed");
            t.assert.equal(hashOf(page), `#/jobs/${job.number}`);

            await page.goBack();
            await waitForHeading(page, "Board");
            t.assert.equal(hashOf(page), "#/");

            await page.goForward();
            await waitForJobTitle(page, "Paint the shed");
            await page.reload();
            await waitForJobTitle(page, "Paint the shed");
            t.assert.equal(hashOf(page), `#/jobs/${job.number}`);
            t.assert.equal(await page.locator("main .job-number").textContent(), job.number);
        });

        it("shows the same job in a second browser context with no stored data", {
            timeout: TEST_TIMEOUT_MS,
        }, async (t) => {
            const { port, job } = await startRig();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) return;
            const first = await (await browser.newContext()).newPage();
            await first.goto(pageUrl(port, "/ui/#/"));
            await waitForCard(first, job.number);
            await first.locator(`main .board-card a[href='#/jobs/${job.number}']`).click();
            await waitForJobTitle(first, "Paint the shed");
            const address = first.url();

            const second = await (await browser.newContext()).newPage();
            await second.goto(address);
            await waitForJobTitle(second, "Paint the shed");

            t.assert.equal(await second.locator("main .job-number").textContent(), job.number);
            t.assert.equal(await jobTitle(second).textContent(), await jobTitle(first).textContent());
            t.assert.equal(await second.locator("main .job-missing").count(), 0);
        });
    });
}
