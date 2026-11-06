import { afterEach, describe, it, type TestContext } from "node:test";
import type { Page } from "playwright-core";
import { type BrowserName, launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const BROWSERS: BrowserName[] = ["chrome", "msedge", "firefox"];
const WAIT_MS = 60_000;
const POLL_MS = 100;
const SETTLE_MS = 1000;
const TEST_TIMEOUT_MS = 600_000;
const PAGE_OPEN_LIMIT_MS = 3000;
const EXPAND_LIMIT_MS = 500;
const LONG_ENTRIES = 2000;
const SHORT_ENTRIES = 20;
const ENTRIES_PER_PAGE = 500;
const LONG_RESULT_BYTES = 1024 * 1024;
const ENTRIES_PER_INPUT = 2;
// A long result adds the input, the call, the result, a compaction with its system entry, and the answer.
const ENTRIES_PER_LONG_RESULT = 6;
// The `long-output` lead answers an input starting with this with text; any other input gets a long tool result.
const TEXT_ONLY = "text only: ";
const SHORT_ENTRY_TEXT = `${TEXT_ONLY}one more`;
const SECTION = "main details.activity";
const ENTRY = `${SECTION} .activity-entry`;
const LONG_ENTRY = `${SECTION} .activity-tool-result:has(button.output-more)`;

type Job = { id: string; number: string };
type Entry = { id: string; kind: string };
type Page_ = { entries: Entry[]; next?: string };

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

async function startRig(): Promise<{ daemon: DaemonProcess; port: number }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "long-output", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return { daemon, port: await daemon.networkPort() };
}

async function entryKinds(daemon: DaemonProcess, conversationId: string): Promise<string[]> {
    const kinds: string[] = [];
    let after: string | undefined;
    do {
        const page = (await daemon.invoke("conversations.entries", {
            conversationId,
            limit: ENTRIES_PER_PAGE,
            ...(after !== undefined && { after }),
        })) as Page_;
        kinds.push(...page.entries.map((entry) => entry.kind));
        after = page.next;
    } while (after !== undefined);
    return kinds;
}

const entryCount = async (daemon: DaemonProcess, conversationId: string) =>
    (await entryKinds(daemon, conversationId)).length;

/** Waits until the conversation holds `entries` entries and `results` tool results and its newest entry is an answer. */
async function waitSettled(daemon: DaemonProcess, conversationId: string, entries: number, results = 0): Promise<void> {
    const deadline = Date.now() + WAIT_MS * 4;
    for (;;) {
        const kinds = await entryKinds(daemon, conversationId);
        const toolResults = kinds.filter((kind) => kind === "pi.tool-result").length;
        if (kinds.at(-1) === "pi.assistant" && kinds.length >= entries && toolResults >= results) return;
        if (Date.now() > deadline) throw new Error(`${conversationId} did not settle at ${entries} entries`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/**
 * A job whose lead of `long-output` holds the 1 MiB tool result of its first answer, short entries from inputs
 * submitted through the service, and a second long tool result from an input without the text-only marker, so a long
 * result is among the newest entries, on the first page the Job page reads. It holds `entries` entries in all.
 */
async function buildJob(daemon: DaemonProcess, label: string, entries: number): Promise<Job & { lead: string }> {
    const job = (await daemon.invoke("jobs.create", { text: `start ${label}` })) as Job;
    const detail = (await daemon.invoke("jobs.get", { job: job.id })) as { leadConversation: string };
    const lead = detail.leadConversation;
    await waitSettled(daemon, lead, 0, 1);
    // The first input after a long result also compacts, which adds entries the later ones don't.
    const beforeFirst = await entryCount(daemon, lead);
    await submit(daemon, lead, `${label}-first`, `${TEXT_ONLY}${label} first`);
    await waitSettled(daemon, lead, beforeFirst + ENTRIES_PER_INPUT);
    const shortEntries = entries - ENTRIES_PER_LONG_RESULT;
    while ((await entryCount(daemon, lead)) < shortEntries) {
        const before = await entryCount(daemon, lead);
        const inputs = Math.ceil((shortEntries - before) / ENTRIES_PER_INPUT);
        for (let index = 0; index < inputs; index++) {
            await submit(daemon, lead, `${label}-${before}-${index}`, `${TEXT_ONLY}${label} input ${before}-${index}`);
        }
        await waitSettled(daemon, lead, before + inputs * ENTRIES_PER_INPUT);
    }
    await submit(daemon, lead, `${label}-long`, `${label} wants a long result`);
    await waitSettled(daemon, lead, entries, 2);
    return { ...job, lead };
}

async function submit(daemon: DaemonProcess, conversationId: string, requestId: string, content: string) {
    await daemon.invoke("conversations.submit", { conversationId, content, requestId });
}

function expectAtMost(t: TestContext, what: string, value: number, limit: number, unit: string): void {
    t.assert.equal(value <= limit, true, `${what} took ${value} ${unit}, over the ${limit} ${unit} limit`);
}

const jobUrl = (port: number, job: Job) => pageUrl(port, `/ui/#/jobs/${job.number}`);

async function msUntil(page: Page, startedAt: number, condition: string): Promise<number> {
    await page.waitForFunction(condition, undefined, { timeout: WAIT_MS, polling: "raf" });
    return Date.now() - startedAt;
}

/** The bytes the feed connection carries from the submit of one short input until its answer shows in the page. */
async function bytesForOneShortEntry(
    daemon: DaemonProcess,
    proxy: WebProxy,
    page: Page,
    lead: string,
): Promise<number> {
    const shown = await page.locator(`${ENTRY}[data-kind='pi.assistant']`).count();
    const before = proxy.feedBytes();
    await submit(daemon, lead, `short-${lead}`, SHORT_ENTRY_TEXT);
    await page.waitForFunction(
        ([css, count]) => document.querySelectorAll(css).length > count,
        [`${ENTRY}[data-kind='pi.assistant']`, shown] as [string, number],
        { timeout: WAIT_MS },
    );
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    return proxy.feedBytes() - before;
}

async function openedPage(t: TestContext, name: BrowserName, port: number, job: Job) {
    const proxy = await startWebProxy();
    proxies.push(proxy);
    const browser = await launchBrowser(t, name, { proxyPort: proxy.port });
    if (browser === undefined) return undefined;
    const page = await browser.newPage();
    await page.goto(jobUrl(port, job));
    await page.waitForSelector(ENTRY, { timeout: WAIT_MS });
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
    return { page, proxy };
}

for (const name of BROWSERS) {
    describe(`long activity in ${name}`, () => {
        it("opens a job of 2,000 entries within 3 seconds and expands a long output within 500 ms", {
            timeout: TEST_TIMEOUT_MS,
        }, async (t) => {
            const { daemon, port } = await startRig();
            const job = await buildJob(daemon, "long", LONG_ENTRIES);
            const browser = await launchBrowser(t, name);
            if (browser === undefined) return;
            const page = await browser.newPage();

            const started = Date.now();
            await page.goto(jobUrl(port, job));
            const opened = await msUntil(page, started, `!!document.querySelector("${LONG_ENTRY}")`);
            expectAtMost(t, "Opening the page", opened, PAGE_OPEN_LIMIT_MS, "ms");

            const expanded = await page.evaluate(
                ([selector, size]) =>
                    new Promise<number>((resolve) => {
                        const output = document.querySelector(`${selector} .output`) as HTMLElement;
                        const clickedAt = performance.now();
                        (document.querySelector(`${selector} button.output-more`) as HTMLElement).click();
                        const check = () => {
                            if ((output.textContent ?? "").length >= size) resolve(performance.now() - clickedAt);
                            else requestAnimationFrame(check);
                        };
                        check();
                    }),
                [LONG_ENTRY, LONG_RESULT_BYTES] as [string, number],
            );
            expectAtMost(t, "Expanding the output", expanded, EXPAND_LIMIT_MS, "ms");
        });

        it("sends no more data for a new short entry with 2,000 entries than with 20", {
            timeout: TEST_TIMEOUT_MS,
        }, async (t) => {
            const { daemon, port } = await startRig();
            const long = await buildJob(daemon, "long", LONG_ENTRIES);
            const short = await buildJob(daemon, "short", SHORT_ENTRIES);

            const onLong = await openedPage(t, name, port, long);
            if (onLong === undefined) return;
            const longBytes = await bytesForOneShortEntry(daemon, onLong.proxy, onLong.page, long.lead);
            const onShort = await openedPage(t, name, port, short);
            if (onShort === undefined) return;
            const shortBytes = await bytesForOneShortEntry(daemon, onShort.proxy, onShort.page, short.lead);

            t.assert.equal(longBytes > 0, true, "The feed carried nothing for the new entry");
            expectAtMost(
                t,
                `One short entry with ${LONG_ENTRIES} entries (vs ${SHORT_ENTRIES})`,
                longBytes,
                shortBytes,
                "bytes",
            );
        });
    });
}
