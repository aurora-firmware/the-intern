import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const BOX = "main .answer textarea";
const SEND = "main .answer button";
const REFUSAL = "main .answer .refusal";
const BANNER = ".connection-banner";

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

async function startBlockedJob(): Promise<{ daemon: DaemonProcess; port: number; job: Job; lead: string }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({
        hermetic: env,
        script: "block-with-reason",
        turnEndRule: true,
        networkListener: true,
    });
    daemons.push(daemon);
    await daemon.ready;
    const job = (await daemon.invoke("jobs.create", { text: "which colour" })) as Job;
    const lead = ((await daemon.invoke("jobs.get", { job: job.id })) as Detail).leadConversation;
    if (lead === undefined) throw new Error(`job ${job.number} has no lead conversation`);
    return { daemon, port: await daemon.networkPort(), job, lead };
}

async function leadEntriesText(daemon: DaemonProcess, lead: string): Promise<string> {
    const page = await daemon.invoke("conversations.entries", { conversationId: lead, limit: 500 });
    return JSON.stringify(page);
}

const waitFor = (page: Page, condition: string, argument?: unknown) =>
    page.waitForFunction(condition, argument, { timeout: WAIT_MS, polling: POLL_MS });

const waitForStatus = (page: Page, label: string) =>
    waitFor(
        page,
        `document.querySelector('main .job-field[data-field="status"] .job-value')?.textContent === ${JSON.stringify(label)}`,
    );

async function openBlockedJob(page: Page, port: number, number: string): Promise<void> {
    await page.goto(pageUrl(port, `/ui/#/jobs/${number}`));
    await page.waitForSelector('main .job-field[data-field="blocked-reason"]', { timeout: WAIT_MS });
    await page.waitForSelector(BOX);
}

describe("answering a Blocked job from its page in chrome", () => {
    it("delivers the answer to the lead, moves the job to In progress and clears the reason, with no reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, job, lead } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openBlockedJob(page, port, job.number);
        await page.evaluate(() => Object.assign(globalThis, { notReloaded: true }));

        await page.fill(BOX, "blue");
        await page.click(SEND);

        await waitForStatus(page, "In progress");
        await waitFor(page, "document.querySelector('main .job-field[data-field=\"blocked-reason\"]') === null");
        t.assert.match(await leadEntriesText(daemon, lead), /blue/);
        t.assert.equal(await page.locator(BOX).count(), 0);
        t.assert.equal(await page.evaluate(() => "notReloaded" in globalThis), true);
        daemon.releaseRuns();
    });

    it("shows the conflict refusal to the second browser, keeps its text and does not deliver it", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, job, lead } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const first = await (await browser.newContext()).newPage();
        const second = await (await browser.newContext()).newPage();
        await openBlockedJob(first, port, job.number);
        await openBlockedJob(second, port, job.number);
        await first.fill(BOX, "blue");
        await second.fill(BOX, "green");

        await first.click(SEND);
        await waitForStatus(first, "In progress");
        await second.click(SEND);

        await second.waitForSelector(REFUSAL, { timeout: WAIT_MS });
        t.assert.match((await second.locator(REFUSAL).textContent()) ?? "", /not Blocked/);
        t.assert.equal(await second.inputValue(BOX), "green");
        const delivered = await leadEntriesText(daemon, lead);
        t.assert.match(delivered, /blue/);
        t.assert.doesNotMatch(delivered, /green/);
        daemon.releaseRuns();
    });

    it("shows Done on both browsers when one cancels, then refuses the other's answer and keeps its text", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, job, lead } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const first = await (await browser.newContext()).newPage();
        const second = await (await browser.newContext()).newPage();
        await openBlockedJob(first, port, job.number);
        await openBlockedJob(second, port, job.number);
        await second.fill(BOX, "green");
        await second.evaluate(() => Object.assign(globalThis, { notReloaded: true }));

        await daemon.invoke("jobs.cancel", { job: job.id, justification: "no longer needed" });

        await waitForStatus(first, "Done");
        await waitForStatus(second, "Done");
        t.assert.equal(await second.evaluate(() => "notReloaded" in globalThis), true);
        t.assert.equal(await second.inputValue(BOX), "green");
        await second.click(SEND);

        await second.waitForSelector(REFUSAL, { timeout: WAIT_MS });
        t.assert.match((await second.locator(REFUSAL).textContent()) ?? "", /not Blocked/);
        t.assert.equal(await second.inputValue(BOX), "green");
        t.assert.doesNotMatch(await leadEntriesText(daemon, lead), /green/);
    });

    it("keeps an answer typed for one job out of another job's page", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port, job } = await startBlockedJob();
        const other = (await daemon.invoke("jobs.create", { text: "which size" })) as Job;
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openBlockedJob(page, port, job.number);
        await page.fill(BOX, "blue");

        await page.goto(pageUrl(port, `/ui/#/jobs/${other.number}`));
        await page.waitForFunction(
            (number) => document.querySelector("main .job-number")?.textContent === number,
            other.number,
            { timeout: WAIT_MS },
        );
        await page.waitForSelector(BOX);

        t.assert.equal(await page.inputValue(BOX), "");
    });

    it("shows no refusal, disables the action and keeps the text when the call fails as unavailable", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, job, lead } = await startBlockedJob();
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openBlockedJob(page, port, job.number);
        await page.fill(BOX, "blue");

        proxy.forceUnavailable("jobs.resume");
        await page.click(SEND);

        await page.waitForSelector(BANNER, { timeout: WAIT_MS });
        await waitFor(page, `document.querySelector(${JSON.stringify(SEND)})?.disabled === true`);
        t.assert.equal(await page.locator(".refusal").count(), 0);
        t.assert.equal(await page.inputValue(BOX), "blue");
        t.assert.doesNotMatch(await leadEntriesText(daemon, lead), /blue/);
    });
});
