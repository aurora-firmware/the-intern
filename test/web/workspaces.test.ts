import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const OWNER_ONLY_MODE = 0o700;
const REGISTER_FORM = "main .workspace-register";
const BANNER = ".connection-banner";

const workspaceRow = (path: string) => `main .workspace[data-path=${JSON.stringify(path)}]`;

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

async function startServer(): Promise<{ daemon: DaemonProcess; port: number; env: HermeticEnv }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return { daemon, port: await daemon.networkPort(), env };
}

/** Creates an owner-only directory in the hermetic instance's temporary folder. */
async function makeDirectory(env: HermeticEnv, name: string): Promise<string> {
    const path = join(env.root, name);
    await mkdir(path, { mode: OWNER_ONLY_MODE });
    return path;
}

type Listing = { path: string; kind: string };

const registeredOf = async (daemon: DaemonProcess): Promise<string[]> =>
    ((await daemon.invoke("workspaces.list", {})) as { workspaces: Listing[] }).workspaces
        .filter((each) => each.kind === "registered")
        .map((each) => each.path);

const waitFor = (page: Page, condition: string) =>
    page.waitForFunction(condition, undefined, { timeout: WAIT_MS, polling: POLL_MS });

async function openWorkspaces(page: Page, port: number): Promise<void> {
    await page.goto(pageUrl(port, "/ui/#/workspaces"));
    await page.waitForSelector(REGISTER_FORM, { timeout: WAIT_MS });
}

describe("the Workspaces page in chrome", () => {
    it("registers an owner-only directory and unregisters it", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port, env } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openWorkspaces(page, port);
        const path = await makeDirectory(env, "project");

        await page.fill(`${REGISTER_FORM} input[name="path"]`, path);
        await page.click(`${REGISTER_FORM} .workspace-register-submit`);
        await page.waitForSelector(workspaceRow(path), { timeout: WAIT_MS });
        t.assert.deepEqual(await registeredOf(daemon), [path]);

        await page.click(`${workspaceRow(path)} .workspace-unregister`);
        await waitFor(page, `document.querySelector(${JSON.stringify(workspaceRow(path))}) === null`);
        t.assert.deepEqual(await registeredOf(daemon), []);
    });

    it("shows the service's refusal for a path that doesn't exist", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port, env } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openWorkspaces(page, port);
        const missing = join(env.root, "missing");

        await page.fill(`${REGISTER_FORM} input[name="path"]`, missing);
        await page.click(`${REGISTER_FORM} .workspace-register-submit`);

        await page.waitForSelector(`${REGISTER_FORM} .refusal`, { timeout: WAIT_MS });
        t.assert.notEqual((await page.locator(`${REGISTER_FORM} .refusal`).textContent()) ?? "", "");
        t.assert.equal(await page.locator(workspaceRow(missing)).count(), 0);
        t.assert.deepEqual(await registeredOf(daemon), []);
    });

    it("lists a workspace registered elsewhere after a settings change", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port, env } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openWorkspaces(page, port);
        const path = await makeDirectory(env, "elsewhere");

        await daemon.invoke("workspaces.register", { path });

        await page.waitForSelector(workspaceRow(path), { timeout: WAIT_MS });
    });

    it("reads the workspaces again on a new instance snapshot", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port, env } = await startServer();
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openWorkspaces(page, port);
        const path = await makeDirectory(env, "missed");

        proxy.dropFeedEvents();
        await daemon.invoke("workspaces.register", { path });
        proxy.forceFeedEnd("lagging");

        await page.waitForSelector(workspaceRow(path), { timeout: WAIT_MS });
    });

    it("disables registering and unregistering while the service can't be reached", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, env } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        const path = await makeDirectory(env, "kept");
        await daemon.invoke("workspaces.register", { path });
        await openWorkspaces(page, port);
        await page.waitForSelector(workspaceRow(path), { timeout: WAIT_MS });

        daemon.kill9();
        await daemon.exited;

        await waitFor(page, `document.querySelector(${JSON.stringify(BANNER)}) !== null`);
        for (const selector of [
            `${REGISTER_FORM} .workspace-register-submit`,
            `${workspaceRow(path)} .workspace-unregister`,
        ]) {
            t.assert.equal(await page.locator(selector).isDisabled(), true, selector);
        }
    });
});
