import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 20_000;
const REFUSAL = "The board could not be read for this test";
const QUIET_MS = 700;
const TEST_TIMEOUT_MS = 180_000;
const FIRST_DONE_COUNT = 50;
const OLDER_DONE_COUNT = 2;
const COLUMN_TITLES = ["To do", "In progress", "Blocked", "Done"];

type Job = { number: string; title: string };

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

async function startNetworkDaemon(script: FakeScript): Promise<{ daemon: DaemonProcess; port: number }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: script !== "echo", networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return { daemon, port: await daemon.networkPort() };
}

const column = (page: Page, title: string) => page.locator(`main .board-column:has(h3:text-is("${title}"))`);
const cardsIn = (page: Page, title: string) => column(page, title).locator(".card");
const waitForCount = (page: Page, title: string, count: number) =>
    page.waitForFunction(
        ([heading, wanted]) =>
            [...document.querySelectorAll("main .board-column")]
                .find((section) => section.querySelector("h3")?.textContent === heading)
                ?.querySelectorAll(".card").length === wanted,
        [title, count] as [string, number],
        { timeout: WAIT_MS },
    );

async function openBoard(page: Page, port: number): Promise<void> {
    await page.goto(pageUrl(port, "/ui/#/"));
    await page.waitForSelector("main .board-column");
}

/** Waits until the page has made no request for a moment, so its first reads, and the snapshot's, are over. */
async function waitUntilQuiet(proxy: WebProxy): Promise<void> {
    let seen = -1;
    while (proxy.requests().length !== seen) {
        seen = proxy.requests().length;
        await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    }
}

async function createFinishedJobs(daemon: DaemonProcess, count: number): Promise<Job[]> {
    const jobs: Job[] = [];
    for (let index = 0; index < count; index++) {
        const job = (await daemon.invoke("jobs.create", { text: `finished job ${index}` })) as Job & { id: string };
        await daemon.invoke("jobs.cancel", { job: job.id, justification: "not needed" });
        jobs.push(job);
    }
    return jobs;
}

describe("the Board in chrome", () => {
    it("moves a job to Blocked with its reason and a Red-bordered card when its lead blocks it, with no reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon("block-with-reason");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openBoard(page, port);
        await page.evaluate(() => Object.assign(globalThis, { notReloaded: true }));

        await daemon.invoke("jobs.create", { text: "which colour" });

        await waitForCount(page, "Blocked", 1);
        const card = cardsIn(page, "Blocked").first();
        t.assert.match((await card.locator(".reason").textContent()) ?? "", /which colour/);
        t.assert.equal(await card.locator(".badge").textContent(), "Blocked");
        t.assert.equal(await card.evaluate((element) => getComputedStyle(element).borderLeftColor), "rgb(230, 59, 38)");
        t.assert.equal(await page.evaluate(() => "notReloaded" in globalThis), true);
    });

    it("shows the four empty columns and a link to the Front desk when there are no jobs", async (t) => {
        const { port } = await startNetworkDaemon("echo");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openBoard(page, port);

        t.assert.deepEqual(await page.locator("main .board-column h3").allInnerTexts(), COLUMN_TITLES);
        t.assert.equal(await page.locator("main .board-column .card").count(), 0);
        t.assert.equal(await page.locator("main a[href='#/desk']").count(), 1);
    });

    it("adds older Done jobs, newest first, and leaves the other columns as they were when asked for more", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon("echo");
        const finished = await createFinishedJobs(daemon, FIRST_DONE_COUNT + OLDER_DONE_COUNT);
        const open = (await daemon.invoke("jobs.create", { text: "still open" })) as Job;
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openBoard(page, port);
        await waitForCount(page, "Done", FIRST_DONE_COUNT);
        const othersBefore = await Promise.all(
            ["To do", "In progress", "Blocked"].map((title) => cardsIn(page, title).allTextContents()),
        );

        await column(page, "Done").getByRole("button", { name: "Load more" }).click();

        await waitForCount(page, "Done", FIRST_DONE_COUNT + OLDER_DONE_COUNT);
        const hrefs = await cardsIn(page, "Done")
            .locator("a")
            .evaluateAll((links) => links.map((link) => link.getAttribute("href")));
        t.assert.deepEqual(hrefs, finished.map((job) => `#/jobs/${job.number}`).reverse());
        const othersAfter = await Promise.all(
            ["To do", "In progress", "Blocked"].map((title) => cardsIn(page, title).allTextContents()),
        );
        t.assert.deepEqual(othersAfter, othersBefore);
        t.assert.equal(await page.locator(`main a[href='#/jobs/${open.number}']`).count(), 1);
        t.assert.equal(await column(page, "Done").getByRole("button", { name: "Load more" }).count(), 0);
    });

    it("reads jobs.list again and shows a job it missed when the feed ends lagging", async (t) => {
        const { daemon, port } = await startNetworkDaemon("echo");
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openBoard(page, port);
        await waitUntilQuiet(proxy);

        proxy.dropFeedEvents();
        const missed = (await daemon.invoke("jobs.create", { text: "created while deaf" })) as Job;
        await new Promise((resolve) => setTimeout(resolve, 500));
        t.assert.equal(await page.locator("main .board-column .card").count(), 0);

        proxy.forceFeedEnd("lagging");

        await page.waitForSelector(`main .card a[href='#/jobs/${missed.number}']`, { timeout: WAIT_MS });
    });

    it("shows the refusal of a failed read and no banner when jobs.list is refused", async (t) => {
        const { port } = await startNetworkDaemon("echo");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.route("**/operations/jobs.list", (route) =>
            route.fulfill({ status: 400, json: { error: { code: "invalid_input", message: REFUSAL } } }),
        );

        await page.goto(pageUrl(port, "/ui/#/"));

        await page.waitForSelector("main .board .error");
        t.assert.equal(await page.locator("main .board .error").textContent(), REFUSAL);
        t.assert.equal(await page.locator(".connection-banner").count(), 0);
    });

    it("shows the connection banner and no refusal message when jobs.list is unavailable", async (t) => {
        const { port } = await startNetworkDaemon("echo");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.route("**/operations/jobs.list", (route) =>
            route.fulfill({ status: 503, json: { error: { code: "unavailable", message: "not now" } } }),
        );

        await page.goto(pageUrl(port, "/ui/#/"));

        await page.waitForSelector(".connection-banner");
        t.assert.equal(await page.locator("main .board .error").count(), 0);
    });

    it("keeps the columns, shows the refusal and keeps Load more when asking for more Done jobs fails", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon("echo");
        await createFinishedJobs(daemon, FIRST_DONE_COUNT + 1);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openBoard(page, port);
        await waitForCount(page, "Done", FIRST_DONE_COUNT);
        await page.route("**/operations/jobs.list", (route) =>
            route.request().postDataJSON()?.cursor === undefined
                ? route.fallback()
                : route.fulfill({ status: 400, json: { error: { code: "invalid_input", message: REFUSAL } } }),
        );

        const more = column(page, "Done").getByRole("button", { name: "Load more" });
        await more.click();

        await page.waitForSelector("main .board .error");
        t.assert.equal(await page.locator("main .board .error").textContent(), REFUSAL);
        t.assert.equal(await cardsIn(page, "Done").count(), FIRST_DONE_COUNT);
        t.assert.equal(await more.count(), 1);
    });
});
