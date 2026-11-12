import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const ENTRY = "nightly";
const REQUEST_TEXT = "Run nightly.";
const at = (day: number, hour: number, minute = 0): string => new Date(2026, 10, day, hour, minute, 0).toISOString();

type RunItem = { kind: "run"; job: { number: string } } | { kind: "skip"; skip: { reason: string; openRun: string } };

const entryCard = `main .schedule[data-entry="${ENTRY}"]`;
const RUN_LINKS = `${entryCard} .schedule-run a`;
const SKIPS = `${entryCard} .schedule-skip`;

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

/** A daemon whose schedules run on the test clock, with the entry `nightly` due at 02:00 each day. */
async function startServer(): Promise<{ daemon: DaemonProcess; port: number }> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(
        join(env.configDir, "config.toml"),
        `[[schedule]]\nname = "${ENTRY}"\ncron = "0 2 * * *"\nrequest = "${REQUEST_TEXT}"\n`,
    );
    const daemon = startDaemon({
        hermetic: env,
        script: "echo",
        turnEndRule: false,
        networkListener: true,
        scheduleClock: at(8, 1, 59),
    });
    daemons.push(daemon);
    await daemon.ready;
    return { daemon, port: await daemon.networkPort() };
}

const waitFor = (page: Page, condition: string) =>
    page.waitForFunction(condition, undefined, { timeout: WAIT_MS, polling: POLL_MS });

const itemsOf = async (daemon: DaemonProcess): Promise<RunItem[]> =>
    ((await daemon.invoke("schedules.runs", { name: ENTRY })) as { items: RunItem[] }).items;

/** Finds the run by its kind: the order of items across UTC offsets is not what these tests check (B-034). */
const runNumberOf = async (daemon: DaemonProcess): Promise<string | undefined> => {
    const run = (await itemsOf(daemon)).find((item) => item.kind === "run");
    return run?.kind === "run" ? run.job.number : undefined;
};

async function untilRun(daemon: DaemonProcess): Promise<string> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const number = await runNumberOf(daemon);
        if (number !== undefined) return number;
        if (Date.now() > deadline) throw new Error("the entry started no scheduled run");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const setClock = (daemon: DaemonProcess, time: string) => daemon.invoke("test.setClock", { time });

describe("the Schedules page in chrome", () => {
    it("opens at its address, keeps it through a reload and lists the entry with its next due time", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        await page.goto(pageUrl(port, "/ui/#/schedules"));
        await page.waitForSelector(entryCard, { timeout: WAIT_MS });
        t.assert.notEqual(((await page.locator(`${entryCard} .schedule-next`).textContent()) ?? "").trim(), "");

        await page.reload();
        await page.waitForSelector(entryCard, { timeout: WAIT_MS });
        t.assert.equal(new URL(page.url()).hash, "#/schedules");
    });

    it("shows a scheduled run, linked to its Job page, when it starts without a reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/schedules"));
        await page.waitForSelector(entryCard, { timeout: WAIT_MS });
        t.assert.equal(await page.locator(RUN_LINKS).count(), 0);
        const nextBefore = await page.locator(`${entryCard} .schedule-next`).textContent();

        await setClock(daemon, at(8, 2));
        const number = await untilRun(daemon);

        await page.waitForSelector(`${RUN_LINKS}[href="#/jobs/${number}"]`, { timeout: WAIT_MS });
        await waitFor(
            page,
            `document.querySelector('${entryCard} .schedule-next')?.textContent !== ${JSON.stringify(nextBefore)}`,
        );
    });

    it("shows a skipped fire with its reason and the open run's link when the next due time arrives", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await setClock(daemon, at(8, 2));
        const number = await untilRun(daemon);
        await page.goto(pageUrl(port, "/ui/#/schedules"));
        await page.waitForSelector(`${RUN_LINKS}[href="#/jobs/${number}"]`, { timeout: WAIT_MS });
        t.assert.equal(await page.locator(SKIPS).count(), 0);

        await setClock(daemon, at(9, 2));

        await page.waitForSelector(SKIPS, { timeout: WAIT_MS });
        const skip = (await itemsOf(daemon)).find((item) => item.kind === "skip");
        assert.ok(skip?.kind === "skip");
        t.assert.equal(await page.locator(`${SKIPS} .schedule-skip-reason`).textContent(), skip.skip.reason);
        t.assert.equal(await page.getAttribute(`${SKIPS} a`, "href"), `#/jobs/${number}`);
    });

    it("updates the list without a reload when an entry is added, changed and removed", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/schedules"));
        await page.waitForSelector(entryCard, { timeout: WAIT_MS });
        const added = 'main .schedule[data-entry="weekly"]';

        await daemon.invoke("schedules.create", { name: "weekly", cron: "0 3 * * *", request: "Run weekly." });
        await page.waitForSelector(added, { timeout: WAIT_MS });
        const nextBefore = await page.locator(`${added} .schedule-next`).textContent();

        await daemon.invoke("schedules.change", { name: "weekly", cron: "0 5 * * *" });
        await waitFor(
            page,
            `document.querySelector('${added} .schedule-next')?.textContent !== ${JSON.stringify(nextBefore)}`,
        );

        await daemon.invoke("schedules.remove", { name: "weekly" });
        await waitFor(page, `document.querySelector('${added}') === null`);
        t.assert.equal(await page.locator(entryCard).count(), 1);
    });
});
