import { afterEach, describe, it, type TestContext } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, type FakeScript, freeLoopbackPort, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 45_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 180_000;
const BOX = "main .answer textarea";
const SEND = "main .answer button";
const BANNER = ".connection-banner";
const STATUS = 'main .job-field[data-field="status"] .job-value';

type Job = { id: string; number: string };
type Entry = { id: string; kind: string };

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

/** A daemon on one fixed address and state: `stop` ends it, `start` launches another on the same instance. */
type Rig = {
    port: number;
    daemon(): DaemonProcess;
    stop(how: "kill" | "terminate"): Promise<void>;
    start(): Promise<void>;
};

async function startRig(script: FakeScript, turnEndRule: boolean): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const port = await freeLoopbackPort();
    let current: DaemonProcess | undefined;
    const rig: Rig = {
        port,
        daemon() {
            if (current === undefined) throw new Error("The daemon has not started");
            return current;
        },
        async stop(how) {
            if (how === "kill") rig.daemon().kill9();
            else rig.daemon().signal("SIGTERM");
            await current?.exited;
        },
        async start() {
            current = startDaemon({ hermetic: env, script, turnEndRule, networkListener: true, fixedPort: port });
            daemons.push(current);
            await current.ready;
        },
    };
    await rig.start();
    return rig;
}

async function leadOf(daemon: DaemonProcess, job: Job): Promise<string> {
    const detail = (await daemon.invoke("jobs.get", { job: job.id })) as { leadConversation?: string };
    if (detail.leadConversation === undefined) throw new Error(`job ${job.number} has no lead conversation`);
    return detail.leadConversation;
}

const entriesOf = async (daemon: DaemonProcess, conversationId: string): Promise<Entry[]> =>
    ((await daemon.invoke("conversations.entries", { conversationId, limit: 500 })) as { entries: Entry[] }).entries;

/** The entries the page draws for an echo conversation: the inputs and the answers. */
const SHOWN_KINDS = ["pi.user", "pi.assistant"];
const shownEntries = async (daemon: DaemonProcess, conversationId: string): Promise<Entry[]> =>
    (await entriesOf(daemon, conversationId)).filter((entry) => SHOWN_KINDS.includes(entry.kind));

async function until(describeWait: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${describeWait}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const waitFor = (page: Page, condition: string) =>
    page.waitForFunction(condition, undefined, { timeout: WAIT_MS, polling: POLL_MS });

const waitForBanner = (page: Page, isShown: boolean) =>
    waitFor(page, `(document.querySelector(${JSON.stringify(BANNER)}) !== null) === ${isShown}`);

const waitForSendEnabled = (page: Page, isEnabled: boolean) =>
    waitFor(page, `document.querySelector(${JSON.stringify(SEND)})?.disabled === ${!isEnabled}`);

const waitForStatus = (page: Page, label: string) =>
    waitFor(page, `document.querySelector(${JSON.stringify(STATUS)})?.textContent === ${JSON.stringify(label)}`);

/** A blocked job whose page has a typed answer that is not yet sent. */
async function openBlockedJobWithAnswer(page: Page, rig: Rig, answer: string): Promise<{ job: Job; lead: string }> {
    const daemon = rig.daemon();
    const job = (await daemon.invoke("jobs.create", { text: "which colour" })) as Job;
    const lead = await leadOf(daemon, job);
    await page.goto(pageUrl(rig.port, `/ui/#/jobs/${job.number}`));
    await page.waitForSelector('main .job-field[data-field="blocked-reason"]', { timeout: WAIT_MS });
    await page.waitForSelector(BOX);
    await page.fill(BOX, answer);
    return { job, lead };
}

/** Reads an instance feed of the daemon from the test, to see how the daemon ends it. */
async function watchInstanceFeed(port: number): Promise<{ text(): string; whenClosed: Promise<void> }> {
    const response = await fetch(`http://127.0.0.1:${port}/feed?scope=instance`);
    if (response.body === null) throw new Error("The feed answered with no body");
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let received = "";
    const whenClosed = (async () => {
        try {
            for (let chunk = await reader.read(); !chunk.done; chunk = await reader.read()) received += chunk.value;
        } catch {
            // A killed daemon resets the connection; what arrived before is all there is.
        }
    })();
    return { text: () => received, whenClosed };
}

async function expectKeptAndOffline(t: TestContext, page: Page, answer: string) {
    await waitForBanner(page, true);
    await waitForSendEnabled(page, false);
    t.assert.equal(await page.locator(".refusal").count(), 0);
    t.assert.equal(await page.inputValue(BOX), answer);
}

async function expectRecoveredAndDelivered(t: TestContext, page: Page, rig: Rig, lead: string, answer: string) {
    await waitForBanner(page, false);
    await waitForSendEnabled(page, true);
    await waitForStatus(page, "Blocked");
    t.assert.equal(await page.inputValue(BOX), answer);
    await page.click(SEND);
    await waitForStatus(page, "In progress");
    t.assert.match(JSON.stringify(await entriesOf(rig.daemon(), lead)), new RegExp(answer));
    rig.daemon().releaseRuns();
}

describe("a Job page that loses its connection, in chrome", () => {
    it("shows the banner and disables sending when the daemon stops, then recovers and sends the kept answer", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig("block-with-reason", true);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        const { lead } = await openBlockedJobWithAnswer(page, rig, "azure-answer");
        await page.evaluate(() => Object.assign(globalThis, { notReloaded: true }));

        await rig.stop("kill");
        await expectKeptAndOffline(t, page, "azure-answer");

        await rig.start();
        await expectRecoveredAndDelivered(t, page, rig, lead, "azure-answer");
        t.assert.equal(await page.evaluate(() => "notReloaded" in globalThis), true);
    });

    it("does the same when the service stops and says so in the feed's end", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig("block-with-reason", true);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        const { lead } = await openBlockedJobWithAnswer(page, rig, "jade-answer");

        const feed = await watchInstanceFeed(rig.port);

        await rig.stop("terminate");
        await feed.whenClosed;
        t.assert.match(feed.text(), /event: end\ndata: \{"reason":"stopped"\}/);
        await expectKeptAndOffline(t, page, "jade-answer");

        await rig.start();
        await expectRecoveredAndDelivered(t, page, rig, lead, "jade-answer");
    });

    it("does the same when the call to send the answer gets unavailable", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const rig = await startRig("block-with-reason", true);
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        const { lead } = await openBlockedJobWithAnswer(page, rig, "crimson-answer");

        proxy.forceUnavailable("jobs.resume");
        await page.click(SEND);

        await expectKeptAndOffline(t, page, "crimson-answer");
        t.assert.doesNotMatch(JSON.stringify(await entriesOf(rig.daemon(), lead)), /crimson-answer/);
        await expectRecoveredAndDelivered(t, page, rig, lead, "crimson-answer");
    });

    it("shows no banner and shows the entries it missed once and in order when the feed ends lagging", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig("echo", false);
        const daemon = rig.daemon();
        const job = (await daemon.invoke("jobs.create", { text: "look into it" })) as Job;
        const lead = await leadOf(daemon, job);
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        const section = `main details.activity[data-conversation="${lead}"]`;
        const shownIds = () =>
            page
                .locator(
                    `${section} .activity-entry[data-kind="pi.user"], ${section} .activity-entry[data-kind="pi.assistant"]`,
                )
                .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-entry-id")));
        const submit = (text: string) =>
            daemon.invoke("conversations.submit", { conversationId: lead, content: text, requestId: text });
        const answered = (text: string) => async () =>
            JSON.stringify(await entriesOf(daemon, lead)).includes(`echo: ${text}`);
        await submit("first");
        await until("the first answer", answered("first"));
        await page.goto(pageUrl(rig.port, `/ui/#/jobs/${job.number}`));
        const known = (await shownEntries(daemon, lead)).length;
        await until("the page to show the first entries", async () => (await shownIds()).length >= known);

        proxy.dropFeedEvents();
        await submit("second");
        await until("the second answer", answered("second"));
        await submit("third");
        await until("the third answer", answered("third"));
        await new Promise((resolve) => setTimeout(resolve, 500));
        t.assert.equal((await shownIds()).length, known);
        proxy.forceFeedEnd("lagging");
        const stored = (await shownEntries(daemon, lead)).length;
        await until("the missed entries", async () => (await shownIds()).length >= stored);
        t.assert.equal(await page.locator(BANNER).count(), 0);

        await submit("fourth");
        await until("the fourth answer", answered("fourth"));
        const finalCount = (await shownEntries(daemon, lead)).length;
        await until("the new activity", async () => (await shownIds()).length >= finalCount);
        const ordered = (await shownEntries(daemon, lead)).map((entry) => entry.id);
        t.assert.deepEqual(await shownIds(), ordered);
        t.assert.equal(await page.locator(BANNER).count(), 0);
    });
});
