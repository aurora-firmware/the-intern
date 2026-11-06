import { afterEach, describe, it } from "node:test";
import type { BrowserContext, Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { type RecordedRequest, startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
const FONT_PATH = "/ui/assets/fonts/";

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

async function startRig(): Promise<{ daemon: DaemonProcess; port: number; proxy: WebProxy }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    const proxy = await startWebProxy();
    proxies.push(proxy);
    return { daemon, port: await daemon.networkPort(), proxy };
}

/** A page of the web interface: where it is, and the element that shows it has drawn. */
type PageToOpen = { name: string; path: string; ready: string };

const BOARD_WITH_JOBS: PageToOpen = { name: "Board", path: "/ui/#/", ready: "main .board-column .card" };

const pagesToOpen = (job: Job): PageToOpen[] => [
    BOARD_WITH_JOBS,
    { name: "Job", path: `/ui/#/jobs/${job.number}`, ready: "main .job-field" },
    { name: "Front desk", path: "/ui/#/desk", ready: "main details.activity" },
    { name: "Roles", path: "/ui/#/roles", ready: "main .role" },
    { name: "Workspaces", path: "/ui/#/workspaces", ready: "main .workspace-register" },
    { name: "Status", path: "/ui/#/status", ready: "main .status" },
];

async function openAndSettle(page: Page, port: number, target: PageToOpen): Promise<void> {
    await page.goto(pageUrl(port, target.path));
    await page.waitForSelector(target.ready, { timeout: WAIT_MS });
    await page.evaluate(() => document.fonts.ready);
}

/** The links of the Board's job cards, once exactly `count` are drawn. */
async function boardJobs(page: Page, count: number): Promise<string[]> {
    const links = "main .board-column .card a[href^='#/jobs/']";
    await page.waitForFunction(
        ([css, wanted]) => document.querySelectorAll(css).length === wanted,
        [links, count] as [string, number],
        { timeout: WAIT_MS },
    );
    return page.locator(links).evaluateAll((all) => all.map((link) => link.getAttribute("href") ?? "").sort());
}

/** Clears everything the browser stores for the origin: cookies, local and session storage, caches, databases. */
async function clearStoredData(context: BrowserContext, page: Page, port: number): Promise<void> {
    const session = await context.newCDPSession(page);
    await session.send("Storage.clearDataForOrigin", {
        origin: new URL(pageUrl(port, "/")).origin,
        storageTypes: "all",
    });
    await page.evaluate(() => {
        window.localStorage.clear();
        window.sessionStorage.clear();
    });
    await context.clearCookies();
}

describe("the pages' independence of anything but the service in chrome", () => {
    it("sends every request with a Referer to the service's address, on each page", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, proxy } = await startRig();
        const job = (await daemon.invoke("jobs.create", { text: "check the pages" })) as Job;
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const origin = new URL(pageUrl(port, "/")).origin;

        // The proxy sees no CONNECT (https) request, but the page reports every request it makes, whatever the scheme.
        const pageRequests: string[] = [];
        for (const target of pagesToOpen(job)) {
            const page = await browser.newPage();
            page.on("request", (request) => pageRequests.push(request.url()));
            await openAndSettle(page, port, target);
            await page.close();
        }

        const withReferer = proxy.requests().filter((request) => request.referer !== undefined);
        const stray = withReferer.filter(
            (request) => !request.url.startsWith(`${origin}/`) || !request.referer?.startsWith(`${origin}/`),
        );
        t.assert.deepEqual(stray, [] as RecordedRequest[]);
        const outside = pageRequests.filter((url) => /^(https?|wss?|ftp):/.test(url) && !url.startsWith(`${origin}/`));
        t.assert.deepEqual(outside, [], "no request the page made went outside the service");
        t.assert.equal(pageRequests.length > 0, true, "the pages' requests were seen");
        t.assert.equal(
            withReferer.some((request) => new URL(request.url).pathname.startsWith(FONT_PATH)),
            true,
            "a font came from the service",
        );
    });

    it("shows the same jobs and the section open again after the stored data is cleared and the page reloaded", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startRig();
        const first = (await daemon.invoke("jobs.create", { text: "first job" })) as Job;
        await daemon.invoke("jobs.create", { text: "second job" });
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const context = await browser.newContext();
        const page = await context.newPage();
        await openAndSettle(page, port, BOARD_WITH_JOBS);
        const jobsBefore = await boardJobs(page, 2);
        await openAndSettle(page, port, pagesToOpen(first)[1] as PageToOpen);
        await page.waitForSelector("main details.activity", { timeout: WAIT_MS });
        const section = page.locator("main details.activity").first();
        await section.locator(":scope > summary").click();
        t.assert.equal(await section.evaluate((each) => (each as HTMLDetailsElement).open), false);

        await clearStoredData(context, page, port);
        await page.reload();
        await page.waitForSelector("main details.activity", { timeout: WAIT_MS });

        t.assert.equal(
            await page
                .locator("main details.activity")
                .first()
                .evaluate((each) => (each as HTMLDetailsElement).open),
            true,
        );
        await openAndSettle(page, port, BOARD_WITH_JOBS);
        t.assert.equal(jobsBefore.length, 2);
        t.assert.deepEqual(await boardJobs(page, 2), jobsBefore);
    });
});
