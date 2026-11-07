import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const SETTLE_MS = 1000;
const TEST_TIMEOUT_MS = 120_000;
const REFUSAL = "The activity could not be read for this test";

type Job = { id: string; number: string };
type Detail = { leadConversation?: string };

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

async function startNetworkDaemon(): Promise<{ daemon: DaemonProcess; port: number }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: true, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return { daemon, port: await daemon.networkPort() };
}

const refuse = (page: Page, operation: string) =>
    page.route(`**/operations/${operation}`, (route) =>
        route.fulfill({ status: 400, json: { error: { code: "invalid_input", message: REFUSAL } } }),
    );

async function leadOf(daemon: DaemonProcess, job: Job): Promise<string> {
    const detail = (await daemon.invoke("jobs.get", { job: job.id })) as Detail;
    if (detail.leadConversation === undefined) throw new Error(`job ${job.number} has no lead conversation`);
    return detail.leadConversation;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("the Job page's live activity when a read fails, in chrome", () => {
    it("shows the refusal in the section of a conversation whose entries are refused, and no banner", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon();
        const job = (await daemon.invoke("jobs.create", { text: "look into it" })) as Job;
        const lead = await leadOf(daemon, job);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await refuse(page, "conversations.entries");

        await page.goto(pageUrl(port, `/ui/#/jobs/${job.number}`));

        const alert = page.locator(`main details.activity[data-conversation="${lead}"] [role="alert"]`);
        await alert.waitFor({ timeout: WAIT_MS });
        t.assert.equal(await alert.first().textContent(), REFUSAL);
        t.assert.equal(await page.locator(".connection-banner").count(), 0);
    });

    it("shows the refusal in the activity section when the tree of conversations is refused", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon();
        const job = (await daemon.invoke("jobs.create", { text: "look into it" })) as Job;
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await refuse(page, "conversations.invocations");

        await page.goto(pageUrl(port, `/ui/#/jobs/${job.number}`));

        const alert = page.locator('main [data-section="activity"] > [role="alert"]');
        await alert.waitFor({ timeout: WAIT_MS });
        t.assert.equal(await alert.textContent(), REFUSAL);
        t.assert.equal(await page.locator("main details.activity").count(), 0);
        t.assert.equal(await page.locator(".connection-banner").count(), 0);
    });

    it("shows the banner and no message in the section when the entries are unavailable", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon();
        const job = (await daemon.invoke("jobs.create", { text: "look into it" })) as Job;
        const lead = await leadOf(daemon, job);
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        proxy.forceUnavailable("conversations.entries");

        await page.goto(pageUrl(port, `/ui/#/jobs/${job.number}`));

        await page.waitForSelector(".connection-banner", { timeout: WAIT_MS });
        t.assert.equal(await page.locator(`main details.activity[data-conversation="${lead}"]`).count(), 1);
        t.assert.equal(await page.locator("main details.activity [role='alert']").count(), 0);
    });

    it("leaves out a conversation of another job that is created while the page is open", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon();
        const job = (await daemon.invoke("jobs.create", { text: "first job" })) as Job;
        const lead = await leadOf(daemon, job);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, `/ui/#/jobs/${job.number}`));
        await page.waitForSelector(`main details.activity[data-conversation="${lead}"]`, { timeout: WAIT_MS });

        const other = (await daemon.invoke("jobs.create", { text: "second job" })) as Job;
        const otherLead = await leadOf(daemon, other);
        await wait(SETTLE_MS);

        t.assert.notEqual(otherLead, lead);
        t.assert.equal(await page.locator("main details.activity").count(), 1);
        t.assert.equal(await page.locator(`main details.activity[data-conversation="${otherLead}"]`).count(), 0);
        t.assert.equal(await page.locator("main [role='alert']").count(), 0);
        await wait(POLL_MS);
    });
});
