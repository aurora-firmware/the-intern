/** The Job page offers no Stop on the lead of a To do job, and offers it with no reload once the job is In progress (S-006 AC-006.6). */
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const SETTLE_MS = 1500;

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

async function until(describeWait: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${describeWait}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const statusOf = async (daemon: DaemonProcess, conversationId: string) =>
    ((await daemon.invoke("conversations.get", { conversationId })) as { status: string }).status;

async function leadOf(daemon: DaemonProcess, job: Job): Promise<string> {
    const detail = (await daemon.invoke("jobs.get", { job: job.id })) as Detail;
    if (detail.leadConversation === undefined) throw new Error(`job ${job.number} has no lead conversation`);
    return detail.leadConversation;
}

const waitFor = (page: Page, condition: string) =>
    page.waitForFunction(condition, undefined, { timeout: WAIT_MS, polling: POLL_MS });

/** One worker thread, held by the first job's lead, so the second job's lead waits for a thread. */
async function startWaitingLead() {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({
        hermetic: env,
        script: "gated",
        workerThreads: 1,
        turnEndRule: false,
        networkListener: true,
    });
    daemons.push(daemon);
    await daemon.ready;
    const held = (await daemon.invoke("jobs.create", { text: "holds the thread" })) as Job;
    const heldLead = await leadOf(daemon, held);
    await until("the first lead to run", async () => (await statusOf(daemon, heldLead)) === "running");
    const job = (await daemon.invoke("jobs.create", { text: "waits for a thread" })) as Job;
    const lead = await leadOf(daemon, job);
    await until(
        "the second lead to wait",
        async () => (await statusOf(daemon, lead)) === "waiting for a worker thread",
    );
    return { daemon, port: await daemon.networkPort(), heldLead, job, lead };
}

describe("the Stop on the lead of a To do job in chrome", () => {
    it("is not offered while the job is To do, and appears with no reload once the job is In progress", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startWaitingLead();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(rig.port, `/ui/#/jobs/${rig.job.number}`));

        await page.waitForSelector(`main details.activity[data-conversation="${rig.lead}"]`, { timeout: WAIT_MS });
        await waitFor(
            page,
            `document.querySelector('main .job-field[data-field="status"] .job-value')?.textContent === "To do"`,
        );
        await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
        t.assert.equal(await page.locator("main .stop-open").count(), 0);
        t.assert.equal(
            await page.locator(`main details.activity[data-conversation="${rig.lead}"] .redirect-send`).count(),
            1,
        );
        t.assert.equal(await page.locator("main .job-cancel:not([disabled])").count(), 1);

        await rig.daemon.invoke("conversations.abort", { conversationId: rig.heldLead });
        await waitFor(page, `document.querySelectorAll("main .stop-open").length === 1`);
        t.assert.equal(
            await page.locator(`main details.activity[data-conversation="${rig.lead}"] .stop-open`).count(),
            1,
        );
        rig.daemon.releaseRuns();
    });
});
