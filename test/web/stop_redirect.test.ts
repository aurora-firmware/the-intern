import { afterEach, describe, it, type TestContext } from "node:test";
import type { Page } from "playwright-core";
import { REMINDER_TEXT } from "../../src/jobs/turn_end_rule.ts";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const PARKED_DELAY_MS = 6000;
const WORDS = "turn left";
const STOP_OPEN = ".stop-open";
const STOP_CONFIRM = ".stop-confirm";
const STOP_CANCEL = ".stop-cancel";
const REDIRECT_BOX = ".redirect textarea";
const REDIRECT_SEND = ".redirect-send";
const BANNER = ".connection-banner";

type Job = { id: string; number: string };
type Entry = { id: string; kind: string; data: { content?: string; actor?: { kind: string; wayIn?: string } } };
type Listing = { status: string };
type Tree = { id: string; status: string; invoked: Tree[] };

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

type Rig = { daemon: DaemonProcess; port: number; job: Job; lead: string };

async function startRig(script: FakeScript, options: { delayMs?: number; turnEndRule?: boolean } = {}): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: true, networkListener: true, ...options });
    daemons.push(daemon);
    await daemon.ready;
    const job = (await daemon.invoke("jobs.create", { text: "job one" })) as Job;
    const detail = (await daemon.invoke("jobs.get", { job: job.id })) as { leadConversation?: string };
    if (detail.leadConversation === undefined) throw new Error(`job ${job.number} has no lead conversation`);
    return { daemon, port: await daemon.networkPort(), job, lead: detail.leadConversation };
}

const waitFor = (page: Page, condition: string, argument?: unknown) =>
    page.waitForFunction(condition, argument, { timeout: WAIT_MS, polling: POLL_MS });

async function until(describeWait: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${describeWait}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const statusOf = async (daemon: DaemonProcess, conversationId: string) =>
    ((await daemon.invoke("conversations.get", { conversationId })) as Listing).status;

const entriesOf = async (daemon: DaemonProcess, conversationId: string) =>
    ((await daemon.invoke("conversations.entries", { conversationId, limit: 500 })) as { entries: Entry[] }).entries;

const waitForStatus = (daemon: DaemonProcess, conversationId: string, status: string) =>
    until(`${conversationId} to be ${status}`, async () => (await statusOf(daemon, conversationId)) === status);

const jobField = (page: Page, name: string) => page.locator(`main .job-field[data-field="${name}"] .job-value`);

const waitForField = (page: Page, name: string, text: string) =>
    waitFor(
        page,
        `document.querySelector('main .job-field[data-field="${name}"] .job-value')?.textContent === ${JSON.stringify(text)}`,
    );

const controlsOf = (page: Page, conversationId: string) =>
    page.locator(`main details.activity[data-conversation="${conversationId}"] .conversation-controls`);

async function openJob(page: Page, port: number, rig: Rig, isRunning: boolean): Promise<void> {
    await page.goto(pageUrl(port, `/ui/#/jobs/${rig.job.number}`));
    const controls = `main details.activity[data-conversation="${rig.lead}"] .conversation-controls`;
    await page.waitForSelector(controls, { timeout: WAIT_MS });
    if (isRunning) await page.waitForSelector(`${controls}[data-busy="true"]`, { timeout: WAIT_MS });
}

async function confirmStop(page: Page, conversationId: string): Promise<void> {
    const controls = controlsOf(page, conversationId);
    await controls.locator(STOP_OPEN).click();
    await controls.locator(STOP_CONFIRM).click();
}

async function expectStoppedBlock(t: TestContext, page: Page): Promise<void> {
    await waitForField(page, "status", "Blocked");
    t.assert.match((await jobField(page, "blocked-reason").textContent()) ?? "", /stopped by a team member/);
}

describe("stopping and redirecting a conversation from the Job page in chrome", () => {
    it("records Redirect words from the web interface and shows them in the live activity", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig("gated");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, rig.port, rig, true);

        await page.fill(`main ${REDIRECT_BOX}`, WORDS);
        await page.click(`main ${REDIRECT_SEND}`);
        rig.daemon.releaseRuns();

        await waitFor(
            page,
            `document.querySelector('main .activity-steer')?.textContent?.includes(${JSON.stringify(WORDS)})`,
        );
        const steer = (await entriesOf(rig.daemon, rig.lead)).find((entry) => entry.kind === "intern.steer");
        t.assert.equal(steer?.data.content, WORDS);
        t.assert.deepEqual(steer?.data.actor, { kind: "team_member", wayIn: "web interface" });
        t.assert.equal(await page.inputValue(`main ${REDIRECT_BOX}`), "");
    });

    it("keeps the lead running after a decline, stops it after a confirmation with no reminder, and an answer resumes it", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig("gated");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, rig.port, rig, true);
        const controls = controlsOf(page, rig.lead);

        await controls.locator(STOP_OPEN).click();
        await controls.locator(STOP_CANCEL).click();
        t.assert.equal(await page.locator("dialog[open]").count(), 0);
        t.assert.equal(await statusOf(rig.daemon, rig.lead), "running");

        await confirmStop(page, rig.lead);
        await expectStoppedBlock(t, page);
        const history = (await rig.daemon.invoke("jobs.history.list", { job: rig.job.id })) as { entries: unknown[] };
        t.assert.match(JSON.stringify(history.entries), /"kind":"daemon"/);
        t.assert.doesNotMatch(
            JSON.stringify(await entriesOf(rig.daemon, rig.lead)),
            new RegExp(REMINDER_TEXT.slice(0, 30)),
        );

        await page.fill("main .answer textarea", "carry on");
        await page.click("main .answer button");
        await waitForField(page, "status", "In progress");
        await until("the answer in the lead's entries", async () =>
            JSON.stringify(await entriesOf(rig.daemon, rig.lead)).includes("carry on"),
        );
        rig.daemon.releaseRuns();
    });

    it("says the agent has already finished and sends no abort when the run ended before the confirmation", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig("gated", { turnEndRule: false });
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, rig.port, rig, true);
        const controls = controlsOf(page, rig.lead);

        await controls.locator(STOP_OPEN).click();
        rig.daemon.releaseRuns();
        await waitFor(page, `document.querySelector('.conversation-controls')?.dataset.busy === "false"`);
        await controls.locator(STOP_CONFIRM).click();

        await controls.locator(".control-message").waitFor({ timeout: WAIT_MS });
        t.assert.match((await controls.locator(".control-message").textContent()) ?? "", /already finished/);
        t.assert.equal(proxy.requests().filter((request) => request.url.includes("conversations.abort")).length, 0);
    });

    it("holds Redirect words for a parked lead, starts no run, and shows the words once when it continues", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig("invoke-parked", { delayMs: PARKED_DELAY_MS });
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        await waitForStatus(rig.daemon, rig.lead, "parked");
        const page = await browser.newPage();
        await openJob(page, rig.port, rig, false);

        await page.fill(`main details.activity[data-conversation="${rig.lead}"] ${REDIRECT_BOX}`, WORDS);
        await page.click(`main details.activity[data-conversation="${rig.lead}"] ${REDIRECT_SEND}`);

        const lead = page.locator(`main details.activity[data-conversation="${rig.lead}"]`);
        await lead.locator(".activity-steer").first().waitFor({ timeout: WAIT_MS });
        t.assert.match((await lead.textContent()) ?? "", /held until it continues/);
        t.assert.equal(await statusOf(rig.daemon, rig.lead), "parked");
        await until("the words delivered", async () =>
            (await entriesOf(rig.daemon, rig.lead)).some((entry) => entry.data.content === WORDS),
        );
        await waitFor(
            page,
            `document.querySelector('main details.activity[data-conversation="${rig.lead}"]')?.textContent?.includes(${JSON.stringify(WORDS)})`,
        );
        const shown = (await lead.locator(".activity-steer").allTextContents()).filter((text) => text.includes(WORDS));
        t.assert.equal(shown.length, 1);
        const steer = (await entriesOf(rig.daemon, rig.lead)).find((entry) => entry.data.content === WORDS);
        t.assert.deepEqual(steer?.data.actor, { kind: "team_member", wayIn: "web interface" });
    });

    it("ends a parked lead and its invoked agent on a confirmed Stop and blocks the job", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig("invoke-parked", { delayMs: PARKED_DELAY_MS * 5 });
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        await waitForStatus(rig.daemon, rig.lead, "parked");
        const page = await browser.newPage();
        await openJob(page, rig.port, rig, false);

        await confirmStop(page, rig.lead);

        await expectStoppedBlock(t, page);
        const tree = (await rig.daemon.invoke("conversations.invocations", { conversationId: rig.lead })) as Tree;
        const statuses = [tree, ...tree.invoked].map((node) => node.status);
        t.assert.equal(statuses.length > 1, true, JSON.stringify(tree));
        t.assert.equal(statuses.includes("running"), false, JSON.stringify(tree));
    });

    it("draws no Stop or Redirect for a conversation that is neither running nor parked", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig("invoke-parked", { delayMs: 500, turnEndRule: false });
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        await until("the lead to finish", async () => {
            const tree = (await rig.daemon.invoke("conversations.invocations", { conversationId: rig.lead })) as Tree;
            return (
                [tree, ...tree.invoked].length === 3 && [tree, ...tree.invoked].every((node) => node.status === "idle")
            );
        });
        const page = await browser.newPage();
        await page.goto(pageUrl(rig.port, `/ui/#/jobs/${rig.job.number}`));

        await waitFor(page, `document.querySelectorAll("main details.activity").length === 3`);
        await new Promise((resolve) => setTimeout(resolve, 1500));
        t.assert.equal(await page.locator("main .conversation-controls").count(), 0);
    });

    it("disables Stop and Redirect while the service can't be reached", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const rig = await startRig("gated");
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, rig.port, rig, true);
        const controls = controlsOf(page, rig.lead);
        await page.fill(`main ${REDIRECT_BOX}`, WORDS);

        proxy.forceUnavailable("conversations.submit");
        await page.click(`main ${REDIRECT_SEND}`);

        await page.waitForSelector(BANNER, { timeout: WAIT_MS });
        t.assert.equal(await controls.locator(STOP_OPEN).isDisabled(), true);
        t.assert.equal(await controls.locator(REDIRECT_SEND).isDisabled(), true);
        t.assert.equal(await controls.locator(REDIRECT_BOX).isDisabled(), true);
        t.assert.equal(await page.inputValue(`main ${REDIRECT_BOX}`), WORDS);
        rig.daemon.releaseRuns();
    });
});
