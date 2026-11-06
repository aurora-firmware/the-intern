import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { type Clock, throttled } from "../../web/ui/model/throttle.ts";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const STATUS = "main .status";
const TOTAL_TOKENS = `${STATUS} .status-usage-total .usage-row[data-kind="model"]`;

type Totals = { totalTokens: number };
type UsageReport = { models: Record<string, Totals>; tools: Record<string, Totals> };
type Status = {
    phase: string;
    startedAt: string;
    versions: { intern: string; pi: string };
    instance: { configDir: string; stateDir: string; dataDir: string; runtimeDir: string };
    workerThreads: { count: number; inUse: number; waiting: unknown[] };
};
type ModelSummary = { model: string; thinkingLevels: string[] };

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

/** A clock the test moves by hand; a timer runs when the clock reaches its time. */
function manualClock(): Clock & { advance(ms: number): void } {
    let time = 0;
    let timers: { at: number; run: () => void }[] = [];
    return {
        now: () => time,
        setTimer(run, ms) {
            timers.push({ at: time + ms, run });
        },
        advance(ms) {
            time += ms;
            const due = timers.filter((timer) => timer.at <= time);
            timers = timers.filter((timer) => timer.at > time);
            for (const timer of due) timer.run();
        },
    };
}

describe("throttled", () => {
    it("runs the first call at once", (t) => {
        const clock = manualClock();
        let runs = 0;
        throttled(() => runs++, 1000, clock)();
        t.assert.equal(runs, 1);
    });

    it("runs a burst of calls within a second once more, when the second is over", (t) => {
        const clock = manualClock();
        let runs = 0;
        const trigger = throttled(() => runs++, 1000, clock);
        trigger();
        clock.advance(100);
        trigger();
        trigger();
        trigger();
        t.assert.equal(runs, 1);

        clock.advance(899);
        t.assert.equal(runs, 1);
        clock.advance(1);
        t.assert.equal(runs, 2);
        clock.advance(5000);
        t.assert.equal(runs, 2);
    });

    it("runs a call after a quiet second at once", (t) => {
        const clock = manualClock();
        let runs = 0;
        const trigger = throttled(() => runs++, 1000, clock);
        trigger();
        clock.advance(1000);
        trigger();
        t.assert.equal(runs, 2);
    });
});

async function startServer(): Promise<{ daemon: DaemonProcess; port: number; desk: string }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    const { conversationId } = (await daemon.invoke("desk.get", {})) as { conversationId: string };
    return { daemon, port: await daemon.networkPort(), desk: conversationId };
}

let requestCount = 0;
async function say(daemon: DaemonProcess, desk: string, content: string): Promise<void> {
    requestCount += 1;
    await daemon.invoke("conversations.submit", {
        conversationId: desk,
        content,
        requestId: `status-${requestCount}`,
        busyMode: "followUp",
    });
}

const waitFor = (page: Page, condition: string, argument?: unknown) =>
    page.waitForFunction(condition, argument, { timeout: WAIT_MS, polling: POLL_MS });

const totalUsage = async (daemon: DaemonProcess) => (await daemon.invoke("usage.get", {})) as UsageReport;

const tokensOf = (report: UsageReport): number =>
    Object.values(report.models).reduce((sum, each) => sum + each.totalTokens, 0);

/** Waits until the daemon's total usage has tokens, which is when the fake model has answered. */
async function waitForUsage(daemon: DaemonProcess, above: number): Promise<number> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const tokens = tokensOf(await totalUsage(daemon));
        if (tokens > above) return tokens;
        if (Date.now() > deadline) throw new Error(`usage did not rise above ${above}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const waitForShownTotal = (page: Page, tokens: number) =>
    page.waitForFunction(
        ({ selector, expected }) =>
            [...document.querySelectorAll(selector)].reduce(
                (sum, row) => sum + Number(row.getAttribute("data-total-tokens")),
                0,
            ) === expected,
        { selector: TOTAL_TOKENS, expected: tokens },
        { timeout: WAIT_MS, polling: POLL_MS },
    );

const shownTokens = (page: Page): Promise<number[]> =>
    page.locator(TOTAL_TOKENS).evaluateAll((rows) => rows.map((row) => Number(row.getAttribute("data-total-tokens"))));

async function openStatus(page: Page, port: number): Promise<void> {
    await page.goto(pageUrl(port, "/ui/#/status"));
    await page.waitForSelector(STATUS, { timeout: WAIT_MS });
}

describe("the Status page in chrome", () => {
    it("shows the state, usage and models the operations return", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port, desk } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        await say(daemon, desk, "hello");
        const tokens = await waitForUsage(daemon, 0);
        const page = await browser.newPage();

        await openStatus(page, port);
        await waitFor(page, `document.querySelectorAll(${JSON.stringify(TOTAL_TOKENS)}).length > 0`);

        const status = (await daemon.invoke("daemon.status", {})) as Status;
        const field = (name: string) => page.locator(`${STATUS} [data-field="${name}"]`).textContent();
        t.assert.equal(await field("phase"), status.phase);
        t.assert.equal(await field("startedAt"), status.startedAt);
        t.assert.equal(await field("intern"), status.versions.intern);
        t.assert.equal(await field("pi"), status.versions.pi);
        t.assert.equal(await field("configDir"), status.instance.configDir);
        t.assert.equal(await field("workerThreadCount"), String(status.workerThreads.count));
        t.assert.equal(await field("workerThreadsInUse"), String(status.workerThreads.inUse));

        t.assert.equal(
            (await shownTokens(page)).reduce((sum, each) => sum + each, 0),
            tokens,
        );
        const conversations = (await daemon.invoke("conversations.list", {})) as { id: string }[];
        for (const { id } of conversations) {
            const report = (await daemon.invoke("usage.get", { conversationId: id })) as UsageReport;
            const rows = page.locator(
                `${STATUS} .status-usage[data-conversation="${id}"] .usage-row[data-kind="model"]`,
            );
            const shown = await rows.evaluateAll((all) =>
                all.map((row) => Number(row.getAttribute("data-total-tokens"))),
            );
            t.assert.deepEqual(
                shown,
                Object.values(report.models).map((each) => each.totalTokens),
                `conversation ${id}`,
            );
        }

        const models = (await daemon.invoke("models.list", {})) as ModelSummary[];
        const listed = await page.locator(`${STATUS} .status-model`).evaluateAll((all) =>
            all.map((each) => ({
                model: each.getAttribute("data-model") ?? "",
                levels: each.querySelector(".status-model-levels")?.textContent ?? "",
            })),
        );
        t.assert.deepEqual(
            listed,
            models.map((each) => ({ model: each.model, levels: each.thinkingLevels.join(", ") })),
        );
    });

    it("shows more usage after the daemon works again, with no reload", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port, desk } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        await say(daemon, desk, "first");
        const before = await waitForUsage(daemon, 0);
        const page = await browser.newPage();
        await openStatus(page, port);
        await waitFor(page, `document.querySelectorAll(${JSON.stringify(TOTAL_TOKENS)}).length > 0`);

        await say(daemon, desk, "second");
        const after = await waitForUsage(daemon, before);

        await waitForShownTotal(page, after);
    });

    it("reads the status and usage again on a new instance snapshot", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port, desk } = await startServer();
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        await say(daemon, desk, "first");
        const before = await waitForUsage(daemon, 0);
        const page = await browser.newPage();
        await openStatus(page, port);
        await waitFor(page, `document.querySelectorAll(${JSON.stringify(TOTAL_TOKENS)}).length > 0`);

        proxy.dropFeedEvents();
        await say(daemon, desk, "missed");
        const after = await waitForUsage(daemon, before);
        proxy.forceFeedEnd("lagging");

        await waitForShownTotal(page, after);
    });
});
