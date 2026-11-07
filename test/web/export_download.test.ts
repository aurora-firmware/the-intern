import { stat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { runBob } from "../support/bob_process.ts";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const EXPORT = "main .export-download";
const OPEN = `${EXPORT} .export-open`;
const DIALOG = `${EXPORT} .export-dialog`;
const CONFIRM = `${DIALOG} .export-confirm`;
const CANCEL = `${DIALOG} .export-cancel`;
const NOTICE = `${EXPORT} .export-notice`;
const REFUSAL = `${EXPORT} .refusal`;
const BANNER = ".connection-banner";
const BUSY_MESSAGE = "Another export download is running; try again when it ends";

type Job = { id: string; number: string; status: string };

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

async function newEnv(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    return env;
}

async function startServer(env: HermeticEnv): Promise<{ daemon: DaemonProcess; port: number }> {
    const daemon = startDaemon({ hermetic: env, script: "gated", networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return { daemon, port: await daemon.networkPort() };
}

const getJob = async (daemon: DaemonProcess, id: string) => (await daemon.invoke("jobs.get", { job: id })) as Job;

async function runningJob(daemon: DaemonProcess): Promise<Job> {
    const created = (await daemon.invoke("jobs.create", { text: "keep going" })) as Job;
    const deadline = Date.now() + WAIT_MS;
    while ((await getJob(daemon, created.id)).status !== "in_progress") {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${created.id} to be in progress`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return getJob(daemon, created.id);
}

const waitFor = (page: Page, condition: string) =>
    page.waitForFunction(condition, undefined, { timeout: WAIT_MS, polling: POLL_MS });

async function openStatus(page: Page, port: number): Promise<void> {
    await page.goto(pageUrl(port, "/ui/#/status"));
    await page.waitForSelector(OPEN, { timeout: WAIT_MS });
}

/** Answers `GET /export` with the refusal the route sends, as the service would. */
async function refuseExport(page: Page, code: string, message: string, status: number): Promise<void> {
    await page.route("**/export", (route) =>
        route.fulfill({
            status,
            contentType: "application/json; charset=utf-8",
            body: JSON.stringify({ error: { code, message } }),
        }),
    );
}

describe("the export download in chrome", () => {
    it("saves the file while jobs run, and bob import starts a new instance from it", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const source = await newEnv();
        const { daemon, port } = await startServer(source);
        const job = await runningJob(daemon);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openStatus(page, port);
        const saved = join(source.root, "saved.sqlite");

        await page.click(OPEN);
        const download = page.waitForEvent("download", { timeout: WAIT_MS });
        await page.click(CONFIRM);
        await (await download).saveAs(saved);

        t.assert.notEqual((await stat(saved)).size, 0);
        t.assert.equal((await getJob(daemon, job.id)).status, "in_progress");
        t.assert.equal(await page.locator(REFUSAL).count(), 0);
        daemon.kill9();
        await daemon.exited;
        const target = await newEnv();
        const imported = await runBob(
            [
                "import",
                saved,
                "--config-dir",
                target.configDir,
                "--state-dir",
                target.stateDir,
                "--data-dir",
                target.dataDir,
                "--runtime-dir",
                target.runtimeDir,
            ],
            { env: target.env },
        );
        t.assert.equal(imported.status, 0, imported.stderr);
        const restarted = await startServer(target);
        t.assert.equal((await getJob(restarted.daemon, job.id)).number, job.number);
    });

    it("says the copy is being made without saying it succeeded", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port } = await startServer(await newEnv());
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openStatus(page, port);

        await page.click(OPEN);
        await page.click(CONFIRM);

        await page.waitForSelector(NOTICE, { timeout: WAIT_MS });
        const notice = (await page.locator(NOTICE).textContent()) ?? "";
        t.assert.match(notice, /being made/);
        t.assert.match(notice, /only a finished download is a good backup/i);
        t.assert.doesNotMatch(notice, /succeeded|complete/i);
    });

    it("states what the file holds in the confirmation, and requests nothing when declined", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port } = await startServer(await newEnv());
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openStatus(page, port);

        await page.click(OPEN);

        const text = (await page.locator(DIALOG).textContent()) ?? "";
        t.assert.match(text, /every conversation/);
        t.assert.match(text, /whole job record/);
        t.assert.match(text, /settings .*aren't in it/i);
        t.assert.match(text, /anyone who can reach this page can take it/i);

        await page.click(CANCEL);

        t.assert.equal(await page.locator(DIALOG).isVisible(), false);
        t.assert.equal(proxy.requests().filter((request) => new URL(request.url).pathname === "/export").length, 0);
    });

    it("shows the service's refusal in place, with no success message, and downloads on a retry", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port } = await startServer(await newEnv());
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openStatus(page, port);
        await refuseExport(page, "busy", BUSY_MESSAGE, 409);

        await page.click(OPEN);
        await page.click(CONFIRM);

        await page.waitForSelector(REFUSAL, { timeout: WAIT_MS });
        t.assert.equal(await page.locator(REFUSAL).textContent(), BUSY_MESSAGE);
        t.assert.equal(await page.locator(NOTICE).count(), 0);

        await page.unroute("**/export");
        await page.click(OPEN);
        const download = page.waitForEvent("download", { timeout: WAIT_MS });
        await page.click(CONFIRM);
        await download;

        t.assert.equal(await page.locator(REFUSAL).count(), 0);
    });

    it("shows a general error when the answer is no refusal text", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port } = await startServer(await newEnv());
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openStatus(page, port);
        await page.route("**/export", (route) =>
            route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" }),
        );

        await page.click(OPEN);
        await page.click(CONFIRM);

        await page.waitForSelector(REFUSAL, { timeout: WAIT_MS });
        t.assert.match((await page.locator(REFUSAL).textContent()) ?? "", /could not be/i);
        t.assert.equal(await page.locator(NOTICE).count(), 0);
    });

    it("disables the download while the service can't be reached", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer(await newEnv());
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openStatus(page, port);
        t.assert.equal(await page.locator(OPEN).isDisabled(), false);

        daemon.kill9();
        await daemon.exited;

        await page.waitForSelector(BANNER, { timeout: WAIT_MS });
        await waitFor(page, `document.querySelector(${JSON.stringify(OPEN)})?.disabled === true`);
    });
});
