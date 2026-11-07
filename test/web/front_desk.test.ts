import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { droppedMessages, type SentMessage, unsettledMessages } from "../../web/ui/model/desk_queue.ts";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const sent = (submissionId: string, text: string): SentMessage => ({ submissionId, text });

describe("the Front desk's sent messages", () => {
    const messages = [sent("s1", "first"), sent("s2", "second"), sent("s3", "third"), sent("s4", "fourth")];
    const before = new Map([
        ["s1", "running"],
        ["s2", "queued"],
        ["s3", "queued"],
        ["s4", "queued"],
    ]);
    const after = new Map([
        ["s1", "unanswered"],
        ["s2", "unanswered"],
        ["s3", "queued"],
        ["s4", "done"],
    ]);

    it("names as dropped only the messages that were queued before the stop and are unanswered after it", () => {
        assert.deepEqual(droppedMessages(messages, before, after), [sent("s2", "second")]);
    });

    it("names no message as dropped when the service has no state for it", () => {
        assert.deepEqual(droppedMessages([sent("s9", "unknown")], before, after), []);
    });

    it("keeps holding the messages that are queued or running, and lets go of done and unanswered ones", () => {
        assert.deepEqual(unsettledMessages(messages, after), [sent("s3", "third")]);
    });

    it("keeps holding a message whose state is not known yet", () => {
        assert.deepEqual(unsettledMessages([sent("s9", "unknown")], after), [sent("s9", "unknown")]);
    });
});

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const BOX = "main .desk textarea";
const SEND = "main .desk .desk-send";
const STOP = "main .desk .desk-stop";
const DROPPED = "main .desk .desk-dropped li";
const BANNER = ".connection-banner";

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

async function startDesk(script: FakeScript): Promise<{ daemon: DaemonProcess; port: number; desk: string }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: true, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    const { conversationId } = (await daemon.invoke("desk.get", {})) as { conversationId: string };
    return { daemon, port: await daemon.networkPort(), desk: conversationId };
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

const answers = (page: Page) => page.locator("main .activity-assistant").allTextContents();

const waitForAnswer = (page: Page, text: string) =>
    waitFor(
        page,
        "(wanted) => [...document.querySelectorAll('main .activity-assistant')].some((node) => node.textContent?.includes(wanted))",
        text,
    );

async function openDesk(page: Page, port: number): Promise<void> {
    await page.goto(pageUrl(port, "/ui/#/desk"));
    await page.waitForSelector(`${BOX}, main .error`);
    await page.waitForSelector("main details.activity");
}

async function sendMessage(page: Page, text: string): Promise<void> {
    await page.fill(BOX, text);
    await page.click(SEND);
    await waitFor(page, "document.querySelector('main .desk textarea')?.value === ''");
}

const entriesOf = async (daemon: DaemonProcess, conversationId: string): Promise<Entry[]> =>
    ((await daemon.invoke("conversations.entries", { conversationId, limit: 500 })) as { entries: Entry[] }).entries;

describe("the Front desk page in chrome", () => {
    it("shows the answer to a request for a job and the job on the Board as W-n", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startDesk("desk-create-job");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openDesk(page, port);

        await sendMessage(page, "create job paint the fence");

        await waitForAnswer(page, "echo: create job paint the fence");
        const jobs = (await daemon.invoke("jobs.list", {})) as { jobs: Job[] };
        const [job] = jobs.jobs;
        t.assert.match(job?.number ?? "", /^W-\d+$/);
        await page.evaluate(() => Object.assign(location, { hash: "#/" }));
        await page.waitForSelector(`main a[href='#/jobs/${job?.number}']`, { timeout: WAIT_MS });
    });

    it("stops an answer with no confirmation, names the queued message it dropped, and answers a new one", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, desk } = await startDesk("gated");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openDesk(page, port);
        await sendMessage(page, "first question");
        await page.waitForSelector(STOP, { timeout: WAIT_MS });
        await sendMessage(page, "second question");

        await page.click(STOP);

        await page.waitForSelector(DROPPED, { timeout: WAIT_MS });
        t.assert.deepEqual(await page.locator(DROPPED).allTextContents(), ["second question"]);
        t.assert.equal(await page.locator("dialog[open]").count(), 0);
        await waitFor(page, "document.querySelector('main .desk .desk-stop') === null");
        daemon.releaseRuns();
        await sendMessage(page, "third question");
        await waitForAnswer(page, "echo: third question");
        t.assert.equal(
            (await answers(page)).some((text) => text.includes("second question")),
            false,
        );
        t.assert.equal(JSON.stringify(await entriesOf(daemon, desk)).includes("second question"), false);
    });

    it("reads the desk and the entries it missed again when the feed ends lagging", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, desk } = await startDesk("echo");
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openDesk(page, port);
        const deskReads = () => proxy.requests().filter((request) => request.url.includes("desk.get")).length;
        const before = deskReads();

        proxy.dropFeedEvents();
        await daemon.invoke("conversations.submit", {
            conversationId: desk,
            content: "missed",
            requestId: "missed-1",
            busyMode: "followUp",
        });
        proxy.forceFeedEnd("lagging");

        await waitForAnswer(page, "echo: missed");
        await until("the desk to be read again", async () => deskReads() > before);
    });

    it("disables sending and Stop while the service can't be reached", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startDesk("gated");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openDesk(page, port);
        await sendMessage(page, "hold on");
        await page.waitForSelector(STOP, { timeout: WAIT_MS });

        daemon.kill9();
        await daemon.exited;

        await waitFor(page, `document.querySelector(${JSON.stringify(BANNER)}) !== null`);
        t.assert.equal(await page.locator(SEND).isDisabled(), true);
        t.assert.equal(await page.locator(STOP).isDisabled(), true);
    });
});
