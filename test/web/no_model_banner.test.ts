/**
 * The no-model banner and the Status page's notice (S-006 REQ-011, REQ-023; ADR-014 decision 6): a daemon whose
 * isolated pi agent folder names no default model shows the banner on every page, and the open page follows the
 * folder with no reload.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { type FakeModelServer, MODEL_ID, startFakeModelServer } from "../install/fake_model_server.ts";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const TEST_TIMEOUT_MS = scaled(180_000);
const POLL_MS = 100;
const BANNER = ".no-model-banner";
const NOTICE = "main .status-no-model";
const NO_DEFAULT = "{}";
const LOOPBACK_DEFAULT = JSON.stringify({ defaultProvider: "loopback", defaultModel: MODEL_ID });
const PAGES = ["#/", "#/desk", "#/roles", "#/workspaces", "#/schedules", "#/mail", "#/status"];

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const servers: FakeModelServer[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const server of servers.splice(0)) await server.close();
    for (const env of envs.splice(0)) await env.dispose();
});

type Rig = { env: HermeticEnv; daemon: DaemonProcess; port: number };

// The fake model registers in the daemon's first model runtime only, so the default the test names is a model the
// pi agent folder defines in `models.json`, on a loopback server.
async function startNoModelDaemon(): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const server = await startFakeModelServer(() => "ok");
    servers.push(server);
    const models = {
        providers: {
            loopback: {
                baseUrl: server.baseUrl,
                api: "openai-completions",
                apiKey: "not-a-real-key",
                models: [{ id: MODEL_ID, reasoning: false }],
            },
        },
    };
    await writeFile(join(env.piAgentDir, "models.json"), JSON.stringify(models));
    await writeFile(join(env.piAgentDir, "settings.json"), NO_DEFAULT);
    const daemon = startDaemon({ hermetic: env, realModels: true, turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon, port: await daemon.networkPort() };
}

type Status = { noDefaultModel: { message: string } | null };

const readStatus = async (daemon: DaemonProcess) => (await daemon.invoke("daemon.status", {})) as Status;

/** Rewrites the folder's settings, then waits until `daemon.status` shows that the daemon noticed. */
async function setDefault(rig: Rig, settings: string, hasModel: boolean): Promise<void> {
    await writeFile(join(rig.env.piAgentDir, "settings.json"), settings);
    const deadline = Date.now() + WAIT_MS;
    while (((await readStatus(rig.daemon)).noDefaultModel === null) !== hasModel) {
        if (Date.now() > deadline) throw new Error("the daemon did not notice the change of the default model");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const waitForCount = (page: Page, selector: string, count: number) =>
    page.waitForFunction(
        ([sel, wanted]) => document.querySelectorAll(sel).length === wanted,
        [selector, count] as [string, number],
        { timeout: WAIT_MS, polling: POLL_MS },
    );

const openPage = async (page: Page, port: number, hash: string) => {
    await page.goto(pageUrl(port, `/ui/${hash}`));
    await page.waitForSelector("main h2.page-heading");
};

describe("the no-model banner in chrome", () => {
    it("shows the banner on each sidebar page and on a Job page while the folder names no default model", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startNoModelDaemon();
        const job = (await rig.daemon.invoke("jobs.create", { text: "wait for a model" })) as { number: string };
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openPage(page, rig.port, "#/");
        for (const hash of [...PAGES, `#/jobs/${job.number}`]) {
            await page.evaluate((target) => {
                location.hash = target;
            }, hash);
            await waitForCount(page, BANNER, 1);
            t.assert.equal(await page.locator(`main ${BANNER}`).count(), 1, hash);
        }
    });

    it("removes the banner and shows it again with no reload as the folder names a default model and stops", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startNoModelDaemon();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openPage(page, rig.port, "#/roles");
        await waitForCount(page, BANNER, 1);
        await page.evaluate(() => {
            Object.assign(globalThis, { notReloaded: true });
        });

        await setDefault(rig, LOOPBACK_DEFAULT, true);
        await waitForCount(page, BANNER, 0);
        await setDefault(rig, NO_DEFAULT, false);
        await waitForCount(page, BANNER, 1);

        t.assert.equal(await page.evaluate(() => (globalThis as { notReloaded?: boolean }).notReloaded), true);
    });

    it("shows the daemon's notice on the Status page and stops showing it with no reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startNoModelDaemon();
        const message = (await readStatus(rig.daemon)).noDefaultModel?.message ?? "";
        assert.match(message, /\/login/);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openPage(page, rig.port, "#/status");
        await waitForCount(page, NOTICE, 1);
        assert.ok(((await page.locator(NOTICE).textContent()) ?? "").includes(message));

        await setDefault(rig, LOOPBACK_DEFAULT, true);
        await waitForCount(page, NOTICE, 0);
    });

    it("keeps the actions of the Front desk and a Job page enabled while the banner shows", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startNoModelDaemon();
        const job = (await rig.daemon.invoke("jobs.create", { text: "wait for a model" })) as { number: string };
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        const isEnabled = (selector: string) =>
            page.waitForFunction(
                (sel) => {
                    const button = document.querySelector(sel) as HTMLButtonElement | null;
                    return button !== null && !button.disabled;
                },
                selector,
                { timeout: WAIT_MS, polling: POLL_MS },
            );

        await openPage(page, rig.port, "#/desk");
        await waitForCount(page, BANNER, 1);
        await isEnabled("main .desk-send");
        await page.evaluate((target) => {
            location.hash = target;
        }, `#/jobs/${job.number}`);
        await waitForCount(page, BANNER, 1);
        await isEnabled("main .job-complete");
        await isEnabled("main .job-cancel");
        t.assert.equal(await page.locator(`main ${BANNER}`).count(), 1);
    });
});
