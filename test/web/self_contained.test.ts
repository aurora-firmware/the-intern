import { afterEach, describe, it, type TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { BrowserContext, Page } from "playwright-core";
import { composeMessage } from "../../src/mail/mime.ts";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { TEST_CA_FILE } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";
import { type RecordedRequest, startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = scaled(30_000);
const TEST_TIMEOUT_MS = scaled(120_000);
const FONT_PATH = "/ui/assets/fonts/";

type Job = { id: string; number: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const rigs: MailRig[] = [];
const proxies: WebProxy[] = [];

afterEach(async () => {
    for (const proxy of proxies.splice(0)) await proxy.stop();
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const rig of rigs.splice(0)) await rig.stop();
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
type PageToOpen = { name: string; path: string; ready: string; open?: (page: Page) => Promise<void> };

/** Opens the Skills panel inside `scope`, then the editor of its first instruction file. */
async function openPanelAndEditor(page: Page, scope: string, panel: string): Promise<void> {
    await page.locator(`${scope} ${panel} > summary`).first().click({ timeout: WAIT_MS });
    await page.locator(`${scope} ${panel} .skill-row`).first().waitFor({ timeout: WAIT_MS });
    await page.locator(`${scope} ${panel} .instruction-row .file-open`).first().click({ timeout: WAIT_MS });
    await page.locator(`${scope} ${panel} .file-editor textarea`).waitFor({ timeout: WAIT_MS });
}

/** Opens the Skills panel of the first role and its editor, then the editor of the common prompt. */
async function openRolesEditors(page: Page): Promise<void> {
    await openPanelAndEditor(page, "main .role", ".role-skills");
    await page.locator("main .skills-instructions .common-prompt .file-open").click({ timeout: WAIT_MS });
    await page.locator("main .skills-instructions .file-editor textarea").waitFor({ timeout: WAIT_MS });
}

const openJobEditors = (page: Page) => openPanelAndEditor(page, "main details.activity", ".conversation-skills");

const BOARD_WITH_JOBS: PageToOpen = { name: "Board", path: "/ui/#/", ready: "main .board-column .card" };

const pagesToOpen = (job: Job): PageToOpen[] => [
    BOARD_WITH_JOBS,
    { name: "Job", path: `/ui/#/jobs/${job.number}`, ready: "main .job-field" },
    { name: "Front desk", path: "/ui/#/desk", ready: "main details.activity" },
    { name: "Roles", path: "/ui/#/roles", ready: "main .role" },
    { name: "Workspaces", path: "/ui/#/workspaces", ready: "main .workspace-register" },
    { name: "Status", path: "/ui/#/status", ready: "main .status" },
    { name: "Schedules", path: "/ui/#/schedules", ready: "main .schedule" },
    {
        name: "Roles with the Skills panel and the editors open",
        path: "/ui/#/roles",
        ready: "main .role",
        open: openRolesEditors,
    },
    {
        name: "Job with the Skills panel and the editor open",
        path: `/ui/#/jobs/${job.number}`,
        ready: "main details.activity",
        open: openJobEditors,
    },
];

const MAIL_ACCOUNT = { name: "work", address: "work@example.test", password: "work-secret" };
const MAIL_CLOCK = "2026-03-02T09:00:00.000Z";
const STOP_TIMEOUT_MS = scaled(20_000);
const POLL_MS = 100;

async function until<T>(description: string, attempt: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
        await sleep(POLL_MS);
    }
}

/**
 * A daemon with a network listener, an owned mail account that is ready and one job that came by email with an
 * attachment. The rig's own daemon has no listener, so another takes its directories, as `mail_page` does.
 */
async function startMailJob(): Promise<{ port: number; job: Job }> {
    const rig = await startMailRig({ accounts: [MAIL_ACCOUNT], clockStart: new Date(MAIL_CLOCK) });
    rigs.push(rig);
    const first = rig.process();
    first.signal("SIGTERM");
    await Promise.race([first.exited, sleep(STOP_TIMEOUT_MS, undefined, { ref: false })]);
    const daemon = startDaemon({
        hermetic: { ...rig.env, env: { ...rig.env.env, NODE_EXTRA_CA_CERTS: TEST_CA_FILE } },
        mailClock: MAIL_CLOCK,
        oauthEndpoints: rig.oauth.endpoints,
        networkListener: true,
    });
    daemons.push(daemon);
    await daemon.ready;
    await until("intake to watch the inbox", async () =>
        daemon.stderr().includes("mail intake watching") ? true : undefined,
    );
    const sent = await composeMessage({
        from: "ann@example.test",
        to: [MAIL_ACCOUNT.address],
        subject: "Files for you",
        text: "please look",
        attachments: [{ filename: "report.pdf", contentType: "application/pdf", content: Buffer.alloc(1024, 7) }],
    });
    rig.deliver(MAIL_ACCOUNT.address, sent.raw);
    const job = await until("the job of the email", async () => {
        const { jobs } = (await daemon.invoke("jobs.list", {})) as { jobs: Job[] };
        return jobs[0];
    });
    return { port: await daemon.networkPort(), job };
}

const mailPagesToOpen = (job: Job): PageToOpen[] => [
    { name: "Mail", path: "/ui/#/mail", ready: "main .mail-account" },
    { name: "Job that came by email", path: `/ui/#/jobs/${job.number}`, ready: "main .job-email" },
];

async function openAndSettle(page: Page, port: number, target: PageToOpen): Promise<void> {
    await page.goto(pageUrl(port, target.path));
    await page.waitForSelector(target.ready, { timeout: WAIT_MS });
    await target.open?.(page);
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

type PagesToCheck = { port: number; proxy: WebProxy; targets: PageToOpen[] };

/** Opens each page through the proxy and checks that every request stayed with the service and a font came from it. */
async function assertSelfContained(t: TestContext, { port, proxy, targets }: PagesToCheck): Promise<void> {
    const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
    if (browser === undefined) return;
    const origin = new URL(pageUrl(port, "/")).origin;

    // The proxy sees no CONNECT (https) request, but the page reports every request it makes, whatever the scheme.
    const pageRequests: string[] = [];
    for (const target of targets) {
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
}

describe("the pages' independence of anything but the service in chrome", () => {
    it("sends every request with a Referer to the service's address, on each page", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, proxy } = await startRig();
        const job = (await daemon.invoke("jobs.create", { text: "check the pages" })) as Job;
        await daemon.invoke("schedules.create", {
            name: "weekly",
            cron: "0 3 * * *",
            request: "Run the weekly review.",
        });
        await assertSelfContained(t, { port, proxy, targets: pagesToOpen(job) });
    });

    it("sends every request with a Referer to the service's address, on the Mail page and a job that came by email", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port, job } = await startMailJob();
        const proxy = await startWebProxy();
        proxies.push(proxy);
        await assertSelfContained(t, { port, proxy, targets: mailPagesToOpen(job) });
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
