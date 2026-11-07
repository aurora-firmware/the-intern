import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const SLOW_MS = 4000;
const ONE_MIB = 1024 * 1024;
const EXPAND_LIMIT_MS = 500;

type Job = { id: string; number: string };
type Detail = { leadConversation?: string };
type Entry = { id: string; kind: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startNetworkDaemon(
    script: FakeScript,
    delayMs?: number,
): Promise<{ daemon: DaemonProcess; port: number }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({
        hermetic: env,
        script,
        turnEndRule: true,
        networkListener: true,
        ...(delayMs !== undefined && { delayMs }),
    });
    daemons.push(daemon);
    await daemon.ready;
    return { daemon, port: await daemon.networkPort() };
}

async function leadOf(daemon: DaemonProcess, job: Job): Promise<string> {
    const detail = (await daemon.invoke("jobs.get", { job: job.id })) as Detail;
    if (detail.leadConversation === undefined) throw new Error(`job ${job.number} has no lead conversation`);
    return detail.leadConversation;
}

async function entriesOf(daemon: DaemonProcess, conversationId: string): Promise<Entry[]> {
    const page = (await daemon.invoke("conversations.entries", { conversationId, limit: 500 })) as {
        entries: Entry[];
    };
    return page.entries;
}

async function waitForEntry(daemon: DaemonProcess, conversationId: string, kind: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await entriesOf(daemon, conversationId)).some((entry) => entry.kind === kind)) {
        if (Date.now() > deadline) throw new Error(`no ${kind} entry in ${conversationId}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const sections = (page: Page) => page.locator("main details.activity");
const sectionOf = (page: Page, conversationId: string) =>
    page.locator(`main details.activity[data-conversation="${conversationId}"]`);

const waitForCount = (page: Page, selector: string, count: number) =>
    page.waitForFunction(
        ([css, wanted]) => document.querySelectorAll(css).length >= wanted,
        [selector, count] as [string, number],
        { timeout: WAIT_MS },
    );

async function openJob(page: Page, port: number, number: string): Promise<void> {
    await page.goto(pageUrl(port, `/ui/#/jobs/${number}`));
    await page.waitForSelector("main .job-field");
}

describe("the Job page's live activity in chrome", () => {
    it("shows the lead's tool call and result and the invoked agents' activity, each under its agent", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon("invoke-parked", SLOW_MS);
        const job = (await daemon.invoke("jobs.create", { text: "look into it" })) as Job;
        const lead = await leadOf(daemon, job);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, port, job.number);
        await page.evaluate(() => Object.assign(globalThis, { notReloaded: true }));

        await waitForCount(page, "main details.activity", 3);
        await waitForCount(page, "main details.activity .activity-tool-result", 1);
        await waitForCount(page, "main details.activity .activity-assistant:has(.output)", 3);

        const leadText = (await sectionOf(page, lead).textContent()) ?? "";
        t.assert.match(leadText, /look into it/);
        t.assert.equal(
            await sectionOf(page, lead)
                .locator(".activity-tool-call")
                .first()
                .textContent()
                .then((text) => /invoke/.test(text ?? "")),
            true,
        );
        t.assert.equal((await sectionOf(page, lead).locator(".activity-tool-result").count()) >= 1, true);
        t.assert.equal(await sections(page).count(), 3);
        for (const prompt of ["A", "B"]) {
            const invoked = page.locator(`main details.activity:not([data-conversation="${lead}"])`, {
                hasText: `job ${prompt}`,
            });
            t.assert.equal(await invoked.count(), 1);
            t.assert.equal(await invoked.locator("> summary").textContent(), "gp");
        }
        t.assert.equal(await sectionOf(page, lead).locator("summary").first().textContent(), "bob");
        t.assert.equal(await page.evaluate(() => "notReloaded" in globalThis), true);
    });

    it("shows the earlier activity of a job that has run, then follows it with none lost or repeated", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon("invoke-parked", SLOW_MS);
        const job = (await daemon.invoke("jobs.create", { text: "look into it" })) as Job;
        const lead = await leadOf(daemon, job);
        await waitForEntry(daemon, lead, "pi.assistant");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        await openJob(page, port, job.number);

        await waitForCount(page, `main details.activity[data-conversation="${lead}"] .activity-entry`, 2);
        await waitForCount(page, "main details.activity", 3);
        await waitForCount(page, "main details.activity .activity-entry[data-kind='intern.report']", 1);
        await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
        const shown = await page
            .locator(`main details.activity[data-conversation="${lead}"] .activity-entry`)
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-entry-id")));
        const stored = (await entriesOf(daemon, lead)).filter((entry) =>
            ["pi.user", "pi.assistant", "pi.tool-result", "intern.report"].includes(entry.kind),
        );
        t.assert.equal(new Set(shown).size, shown.length);
        t.assert.deepEqual(
            shown,
            stored.map((entry) => entry.id),
        );
    });

    it("collapses a 1 MiB tool result, says there is more and expands it on request", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startNetworkDaemon("long-output");
        const job = (await daemon.invoke("jobs.create", { text: "print it" })) as Job;
        const lead = await leadOf(daemon, job);
        await waitForEntry(daemon, lead, "pi.tool-result");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, port, job.number);
        const result = sectionOf(page, lead).locator(".activity-tool-result");
        await result.waitFor({ timeout: WAIT_MS });

        const collapsed = (await result.locator(".output").textContent()) ?? "";
        t.assert.equal(collapsed.length < ONE_MIB / 100, true);
        t.assert.equal(await result.locator(".output-collapsed").count(), 1);
        const more = result.locator("button.output-more");
        t.assert.match((await more.textContent()) ?? "", /more/i);

        const elapsed = await page.evaluate(
            ([selector, size]) =>
                new Promise<number>((resolve) => {
                    const output = document.querySelector(`${selector} .output`) as HTMLElement;
                    const started = performance.now();
                    (document.querySelector(`${selector} button.output-more`) as HTMLElement).click();
                    const check = () => {
                        if ((output.textContent ?? "").length >= size) resolve(performance.now() - started);
                        else requestAnimationFrame(check);
                    };
                    check();
                }),
            [`main details.activity[data-conversation="${lead}"] .activity-tool-result`, ONE_MIB] as [string, number],
        );

        t.assert.equal(elapsed < EXPAND_LIMIT_MS, true);
        t.assert.equal(await result.locator(".output-collapsed").count(), 0);
    });
});
