import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 20_000;
const QUIET_MS = 700;
const TEST_TIMEOUT_MS = 120_000;

type Job = { id: string; number: string; title: string };

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

const fieldText = (page: Page, name: string) => page.locator(`main .job-field[data-field="${name}"] .job-value`);
const worklogTexts = (page: Page) => page.locator("main [data-section='worklog'] .card p").allTextContents();
const historyTexts = (page: Page) => page.locator("main [data-section='history'] .card p").allTextContents();

async function openJob(page: Page, port: number, number: string): Promise<void> {
    await page.goto(pageUrl(port, `/ui/#/jobs/${number}`));
    await page.waitForSelector("main .job-field, main .job-missing");
}

const waitForText = (page: Page, selector: string, text: string) =>
    page.waitForFunction(
        ([css, wanted]) => document.querySelector(css)?.textContent === wanted,
        [selector, text] as [string, string],
        { timeout: WAIT_MS },
    );

async function waitUntilQuiet(proxy: WebProxy): Promise<void> {
    let seen = -1;
    while (proxy.requests().length !== seen) {
        seen = proxy.requests().length;
        await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
    }
}

describe("the Job page's record in chrome", () => {
    it("shows every field, the resolution, the justification, the worklog and the history of a completed job", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon("echo");
        const job = (await daemon.invoke("jobs.create", { text: "paint the shed" })) as Job;
        await daemon.invoke("jobs.update", {
            job: job.id,
            title: "Paint the shed",
            description: "Two coats of green",
            definitionOfDone: "The shed is green",
        });
        await daemon.invoke("jobs.worklog.add", { job: job.id, text: "bought the paint" });
        await daemon.invoke("jobs.worklog.add", { job: job.id, text: "first coat done" });
        await daemon.invoke("jobs.complete", { job: job.id, justification: "both coats dry" });
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        await openJob(page, port, job.number);

        await waitForText(page, "main .job-field[data-field='status'] .job-value", "Done");
        t.assert.equal(await page.locator("main .job-number").textContent(), job.number);
        t.assert.equal(await fieldText(page, "title").textContent(), "Paint the shed");
        t.assert.equal(await fieldText(page, "description").textContent(), "Two coats of green");
        t.assert.equal(await fieldText(page, "definition-of-done").textContent(), "The shed is green");
        t.assert.match((await fieldText(page, "origin").textContent()) ?? "", /^Request by /);
        t.assert.equal(await fieldText(page, "resolution").textContent(), "completed");
        t.assert.equal(await fieldText(page, "justification").textContent(), "both coats dry");
        t.assert.equal(await page.locator("main .job-field[data-field='blocked-reason']").count(), 0);
        t.assert.deepEqual(await worklogTexts(page), ["bought the paint", "first coat done"]);
        t.assert.equal(
            (await historyTexts(page)).some((text) => text.startsWith("title: ")),
            true,
        );
    });

    it("says the job doesn't exist and links back to the Board for an unknown short number", async (t) => {
        const { port } = await startNetworkDaemon("echo");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        await openJob(page, port, "W-999");

        t.assert.match((await page.locator("main .job-missing").textContent()) ?? "", /W-999 doesn't exist/);
        t.assert.equal(await page.locator("main .job-missing a[href='#/']").count(), 1);
        t.assert.equal(await page.locator("main .error").count(), 0);
        t.assert.equal(await page.locator(".connection-banner").count(), 0);
    });

    it("shows a changed title, a new worklog entry and the justification of a finished job with no reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon("echo");
        const job = (await daemon.invoke("jobs.create", { text: "tidy up" })) as Job;
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, port, job.number);
        await page.evaluate(() => Object.assign(globalThis, { notReloaded: true }));

        await daemon.invoke("jobs.update", { job: job.id, title: "Tidy the yard" });
        await waitForText(page, "main .job-field[data-field='title'] .job-value", "Tidy the yard");
        await daemon.invoke("jobs.worklog.add", { job: job.id, text: "raked the leaves" });
        await page.waitForFunction(
            () => document.querySelectorAll("main [data-section='worklog'] .card").length === 1,
            {
                timeout: WAIT_MS,
            },
        );
        await daemon.invoke("jobs.cancel", { job: job.id, justification: "the yard is gone" });
        await waitForText(page, "main .job-field[data-field='justification'] .job-value", "the yard is gone");

        t.assert.equal(await fieldText(page, "status").textContent(), "Done");
        t.assert.equal(await fieldText(page, "resolution").textContent(), "cancelled");
        t.assert.deepEqual(await worklogTexts(page), ["raked the leaves"]);
        t.assert.equal(
            (await historyTexts(page)).some((text) => text.startsWith("title: ")),
            true,
        );
        t.assert.equal(await page.evaluate(() => "notReloaded" in globalThis), true);
    });

    it("shows a worklog entry it missed when the feed ends lagging", async (t) => {
        const { daemon, port } = await startNetworkDaemon("echo");
        const job = (await daemon.invoke("jobs.create", { text: "water the plants" })) as Job;
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, port, job.number);
        await waitUntilQuiet(proxy);

        proxy.dropFeedEvents();
        await daemon.invoke("jobs.worklog.add", { job: job.id, text: "written while deaf" });
        await new Promise((resolve) => setTimeout(resolve, 500));
        t.assert.deepEqual(await worklogTexts(page), []);

        proxy.forceFeedEnd("lagging");

        await page.waitForFunction(
            () => document.querySelectorAll("main [data-section='worklog'] .card").length === 1,
            {
                timeout: WAIT_MS,
            },
        );
        t.assert.deepEqual(await worklogTexts(page), ["written while deaf"]);
    });
});
