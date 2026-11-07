import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { type BrowserName, launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const BROWSERS: BrowserName[] = ["chrome", "msedge", "firefox"];
const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const BOX = "main .answer textarea";
const SEND = "main .answer button";
const REASON = 'main .job-field[data-field="blocked-reason"]';

type Job = { id: string; number: string };
type Detail = { leadConversation?: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
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

const waitFor = (page: Page, condition: string) =>
    page.waitForFunction(condition, undefined, { timeout: WAIT_MS, polling: POLL_MS });

for (const name of BROWSERS) {
    describe(`answering a Blocked job from its page in ${name}`, () => {
        it("delivers the answer to the lead, moves the job to In progress and clears the reason", {
            timeout: TEST_TIMEOUT_MS,
        }, async (t) => {
            const { daemon, port, job, lead } = await startBlockedJob();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) return;
            const page = await browser.newPage();
            await page.goto(pageUrl(port, `/ui/#/jobs/${job.number}`));
            await page.waitForSelector(REASON, { timeout: WAIT_MS });
            await page.waitForSelector(BOX);

            await page.fill(BOX, "blue");
            await page.click(SEND);

            await waitFor(
                page,
                `document.querySelector('main .job-field[data-field="status"] .job-value')?.textContent === "In progress"`,
            );
            await waitFor(page, `document.querySelector(${JSON.stringify(REASON)}) === null`);
            const entries = await daemon.invoke("conversations.entries", { conversationId: lead, limit: 500 });
            t.assert.match(JSON.stringify(entries), /blue/);
            t.assert.equal(await page.locator(BOX).count(), 0);
            daemon.releaseRuns();
        });
    });
}
