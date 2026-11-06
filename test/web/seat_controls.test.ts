import { afterEach, describe, it, type TestContext } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const NEW_ROLE = "gp";
const BANNER = ".connection-banner";

type Job = { id: string; number: string };
type Entry = { id: string; kind: string };
type Rig = { daemon: DaemonProcess; port: number; job: Job; lead: string };

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

const entriesOf = async (daemon: DaemonProcess, conversationId: string): Promise<Entry[]> =>
    ((await daemon.invoke("conversations.entries", { conversationId, limit: 500 })) as { entries: Entry[] }).entries;

async function until(describeWait: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${describeWait}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/** A job whose lead has answered once and is idle, so the conversation has something to compact and reset. */
async function startRig(script: FakeScript): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    const job = (await daemon.invoke("jobs.create", { text: "job one" })) as Job;
    const detail = (await daemon.invoke("jobs.get", { job: job.id })) as { leadConversation?: string };
    if (detail.leadConversation === undefined) throw new Error(`job ${job.number} has no lead conversation`);
    const lead = detail.leadConversation;
    await until(
        "the lead to be idle",
        async () =>
            ((await daemon.invoke("conversations.get", { conversationId: lead })) as { status: string }).status ===
            "idle",
    );
    await until("the lead's answer", async () =>
        (await entriesOf(daemon, lead)).some((e) => e.kind === "pi.assistant"),
    );
    return { daemon, port: await daemon.networkPort(), job, lead };
}

const sectionOf = (page: Page, rig: Rig) => page.locator(`main details.activity[data-conversation="${rig.lead}"]`);
const settingsOf = (page: Page, rig: Rig) => sectionOf(page, rig).locator(".conversation-settings");

async function openSettings(page: Page, rig: Rig): Promise<void> {
    await page.goto(pageUrl(rig.port, `/ui/#/jobs/${rig.job.number}`));
    const settings = settingsOf(page, rig);
    await settings.locator("> summary").click({ timeout: WAIT_MS });
    await settings.locator(".seat-role option", { hasText: NEW_ROLE }).waitFor({ state: "attached", timeout: WAIT_MS });
}

const countOf = async (rig: Rig, kind: string) =>
    (await entriesOf(rig.daemon, rig.lead)).filter((entry) => entry.kind === kind).length;

async function openPage(t: TestContext, options: { script?: FakeScript; isProxied?: boolean } = {}) {
    const rig = await startRig(options.script ?? "echo");
    const proxy = options.isProxied ? await startWebProxy() : undefined;
    if (proxy !== undefined) proxies.push(proxy);
    const browser = await launchBrowser(t, "chrome", proxy && { proxyPort: proxy.port });
    if (browser === undefined) return undefined;
    const page = await browser.newPage();
    await openSettings(page, rig);
    return { rig, page, proxy };
}

describe("compact, reset and change seat on the Job page in chrome", () => {
    it("shows a new seat in the section's label and as an entry, with no reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const opened = await openPage(t);
        if (opened === undefined) return;
        const { rig, page } = opened;
        await page.evaluate(() => Object.assign(globalThis, { notReloaded: true }));

        await settingsOf(page, rig).locator(".seat-role").selectOption(NEW_ROLE);
        await settingsOf(page, rig).locator(".seat-change").click();

        await sectionOf(page, rig).locator(".activity-seat").waitFor({ timeout: WAIT_MS });
        t.assert.equal(await sectionOf(page, rig).locator("> summary").textContent(), NEW_ROLE);
        t.assert.equal(await page.evaluate(() => "notReloaded" in globalThis), true);
    });

    it("shows a compaction in the section's activity", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const opened = await openPage(t, { script: "long-output" });
        if (opened === undefined) return;
        const { rig, page } = opened;
        const compactions = sectionOf(page, rig).locator(".activity-compaction");
        const before = await countOf(rig, "pi.compaction");
        await page.waitForFunction(
            ([css, wanted]) => document.querySelectorAll(css).length === wanted,
            [`main details.activity[data-conversation="${rig.lead}"] .activity-compaction`, before] as const,
            { timeout: WAIT_MS, polling: POLL_MS },
        );

        await settingsOf(page, rig).locator(".compact-run").click();

        await until("the compaction in the entries", async () => (await countOf(rig, "pi.compaction")) === before + 1);
        await page.waitForFunction(
            ([css, wanted]) => document.querySelectorAll(css).length === wanted,
            [`main details.activity[data-conversation="${rig.lead}"] .activity-compaction`, before + 1] as const,
            { timeout: WAIT_MS, polling: POLL_MS },
        );
        t.assert.equal(await compactions.count(), before + 1);
    });

    it("makes only the accepted reset take effect after a declined one", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const opened = await openPage(t);
        if (opened === undefined) return;
        const { rig, page } = opened;
        const settings = settingsOf(page, rig);

        await settings.locator(".reset-open").click();
        await settings.locator(".reset-cancel").click();
        t.assert.equal(await page.locator("dialog[open]").count(), 0);
        t.assert.equal(await countOf(rig, "pi.reset"), 0);

        await settings.locator(".reset-open").click();
        await settings.locator(".reset-confirm").click();

        await sectionOf(page, rig).locator(".activity-reset").waitFor({ timeout: WAIT_MS });
        t.assert.equal(await countOf(rig, "pi.reset"), 1);
        t.assert.equal(await sectionOf(page, rig).locator(".activity-reset").count(), 1);
    });

    it("disables compact, reset and change seat while the service can't be reached", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const opened = await openPage(t, { isProxied: true });
        if (opened === undefined) return;
        const { rig, page, proxy } = opened;
        const settings = settingsOf(page, rig);

        proxy?.forceUnavailable("conversations.compact");
        await settings.locator(".compact-run").click();

        await page.waitForSelector(BANNER, { timeout: WAIT_MS });
        for (const control of [".compact-run", ".reset-open", ".seat-change"]) {
            t.assert.equal(await settings.locator(control).isDisabled(), true, control);
        }
    });
});
