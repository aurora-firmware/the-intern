import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, freeLoopbackPort, startDaemon } from "../support/daemon_process.ts";
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
const CREATE_FORM = "main .schedule-create";
const BANNER = ".connection-banner";
const cardOf = (name: string) => `main .schedule[data-entry="${name}"]`;
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

const itemsOf = async (daemon: DaemonProcess, name = ENTRY): Promise<RunItem[]> =>
    ((await daemon.invoke("schedules.runs", { name })) as { items: RunItem[] }).items;

/** Finds the run by its kind: the order of items across UTC offsets is not what these tests check (B-034). */
const runNumberOf = async (daemon: DaemonProcess, name = ENTRY): Promise<string | undefined> => {
    const run = (await itemsOf(daemon, name)).find((item) => item.kind === "run");
    return run?.kind === "run" ? run.job.number : undefined;
};

async function untilRun(daemon: DaemonProcess, name = ENTRY): Promise<string> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const number = await runNumberOf(daemon, name);
        if (number !== undefined) return number;
        if (Date.now() > deadline) throw new Error("the entry started no scheduled run");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function until(describeWait: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${describeWait}`);
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

    it("adds, runs, changes and removes an entry, each shown on a second browser's page", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        const watcher = await launchBrowser(t, "chrome");
        if (browser === undefined || watcher === undefined) return;
        const page = await browser.newPage();
        const other = await watcher.newPage();
        await page.goto(pageUrl(port, "/ui/#/schedules"));
        await other.goto(pageUrl(port, "/ui/#/schedules"));
        await page.waitForSelector(entryCard, { timeout: WAIT_MS });
        await other.waitForSelector(entryCard, { timeout: WAIT_MS });
        const added = cardOf("weekly");

        await page.fill(`${CREATE_FORM} input[name="name"]`, "weekly");
        await page.fill(`${CREATE_FORM} input[name="cron"]`, "0 3 * * *");
        await page.fill(`${CREATE_FORM} textarea[name="request"]`, "Run weekly.");
        await page.click(`${CREATE_FORM} .schedule-create-submit`);
        await page.waitForSelector(added, { timeout: WAIT_MS });
        await other.waitForSelector(added, { timeout: WAIT_MS });
        const nextBefore = await other.locator(`${added} .schedule-next`).textContent();

        await page.click(`${added} .schedule-run-now`);
        const number = await untilRun(daemon, "weekly");
        for (const each of [page, other]) {
            await each.waitForSelector(`${added} .schedule-run a[href="#/jobs/${number}"]`, { timeout: WAIT_MS });
        }

        await page.fill(`${added} input[name="cron"]`, "0 5 * * *");
        await page.click(`${added} .schedule-save`);
        await waitFor(
            other,
            `document.querySelector('${added} .schedule-next')?.textContent !== ${JSON.stringify(nextBefore)}`,
        );

        await page.click(`${added} .schedule-remove`);
        for (const each of [page, other]) await waitFor(each, `document.querySelector('${added}') === null`);
        t.assert.equal(await page.locator(entryCard).count(), 1);
    });

    it("shows the service's reason when it refuses a new entry or a change, and keeps the entry as it was", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/schedules"));
        await page.waitForSelector(entryCard, { timeout: WAIT_MS });

        await page.fill(`${CREATE_FORM} input[name="name"]`, "broken");
        await page.fill(`${CREATE_FORM} input[name="cron"]`, "not a cron");
        await page.fill(`${CREATE_FORM} textarea[name="request"]`, "Never runs.");
        await page.click(`${CREATE_FORM} .schedule-create-submit`);
        await page.waitForSelector(`${CREATE_FORM} .refusal`, { timeout: WAIT_MS });
        t.assert.notEqual(((await page.locator(`${CREATE_FORM} .refusal`).textContent()) ?? "").trim(), "");
        t.assert.equal(await page.inputValue(`${CREATE_FORM} input[name="cron"]`), "not a cron");

        await page.fill(`${entryCard} input[name="cron"]`, "also not a cron");
        await page.click(`${entryCard} .schedule-save`);
        await page.waitForSelector(`${entryCard} .refusal`, { timeout: WAIT_MS });
        const listed = (await daemon.invoke("schedules.list", {})) as { schedules: { name: string; cron: string }[] };
        t.assert.deepEqual(
            listed.schedules.map((entry) => [entry.name, entry.cron]),
            [[ENTRY, "0 2 * * *"]],
        );
    });

    it("clears an optional value when the form is saved with it unset", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        await daemon.invoke("schedules.create", { name: "seated", cron: "0 3 * * *", request: "Go.", role: "gp" });
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/schedules"));
        const card = cardOf("seated");
        await waitFor(page, `document.querySelector('${card} select[name="role"]')?.value === "gp"`);

        await page.selectOption(`${card} select[name="role"]`, "");
        await page.click(`${card} .schedule-save`);

        await until("the role to be cleared", async () => {
            const { schedule } = (await daemon.invoke("schedules.get", { name: "seated" })) as {
                schedule: { role?: string };
            };
            return schedule.role === undefined;
        });
    });
});

describe("a scheduled run's Job page in chrome", () => {
    const ORIGIN = 'main [data-field="origin"] .job-value';

    it("shows the entry and the fire time of a run started by a fire", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await setClock(daemon, at(8, 2));
        const number = await untilRun(daemon);

        await page.goto(pageUrl(port, `/ui/#/jobs/${number}`));
        await page.waitForSelector(ORIGIN, { timeout: WAIT_MS });

        const text = (await page.locator(ORIGIN).textContent()) ?? "";
        t.assert.match(text, new RegExp(`${ENTRY}`));
        const fireTime = /fire time (\S+)/.exec(text)?.[1];
        t.assert.equal(new Date(fireTime ?? "").toISOString(), at(8, 2));
        t.assert.doesNotMatch(text, /on demand/);
    });

    it("also shows on demand with its way in for a run started from a browser", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/schedules"));
        await page.waitForSelector(entryCard, { timeout: WAIT_MS });
        await page.click(`${entryCard} .schedule-run-now`);
        const number = await untilRun(daemon);

        await page.goto(pageUrl(port, `/ui/#/jobs/${number}`));
        await page.waitForSelector(ORIGIN, { timeout: WAIT_MS });

        const text = (await page.locator(ORIGIN).textContent()) ?? "";
        t.assert.match(text, new RegExp(ENTRY));
        t.assert.match(text, /on demand by web interface from /);
    });
});

describe("the Schedules page when the connection is lost, in chrome", () => {
    it("disables its actions and keeps typed text, then loads fresh data when the service returns", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const env = await createHermeticEnv();
        envs.push(env);
        await writeFile(
            join(env.configDir, "config.toml"),
            `[[schedule]]\nname = "${ENTRY}"\ncron = "0 2 * * *"\nrequest = "${REQUEST_TEXT}"\n`,
        );
        const port = await freeLoopbackPort();
        const start = async (): Promise<DaemonProcess> => {
            const daemon = startDaemon({
                hermetic: env,
                script: "echo",
                turnEndRule: false,
                networkListener: true,
                fixedPort: port,
                scheduleClock: at(8, 1, 59),
            });
            daemons.push(daemon);
            await daemon.ready;
            return daemon;
        };
        const first = await start();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/schedules"));
        await page.waitForSelector(entryCard, { timeout: WAIT_MS });
        await page.fill(`${CREATE_FORM} input[name="name"]`, "typed-name");
        const actions = [
            `${CREATE_FORM} .schedule-create-submit`,
            `${entryCard} .schedule-save`,
            `${entryCard} .schedule-run-now`,
            `${entryCard} .schedule-remove`,
        ];

        first.kill9();
        await first.exited;

        await waitFor(page, `document.querySelector(${JSON.stringify(BANNER)}) !== null`);
        for (const selector of actions) t.assert.equal(await page.locator(selector).isDisabled(), true, selector);
        t.assert.equal(await page.inputValue(`${CREATE_FORM} input[name="name"]`), "typed-name");

        const second = await start();
        await second.invoke("schedules.create", { name: "while-away", cron: "0 4 * * *", request: "Back." });
        await waitFor(page, `document.querySelector(${JSON.stringify(BANNER)}) === null`);
        await page.waitForSelector(cardOf("while-away"), { timeout: WAIT_MS });
        for (const selector of actions) t.assert.equal(await page.locator(selector).isDisabled(), false, selector);
        t.assert.equal(await page.inputValue(`${CREATE_FORM} input[name="name"]`), "typed-name");
    });
});
