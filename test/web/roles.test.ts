import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const NOTE = "main .roles-note";
const CREATE_FORM = "main .role-create";
const BANNER = ".connection-banner";

type Role = { name: string; instructions: string; shipped: boolean; changed: boolean };

const roleCard = (name: string) => `main .role[data-role="${name}"]`;

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

async function startServer(): Promise<{ daemon: DaemonProcess; port: number }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return { daemon, port: await daemon.networkPort() };
}

const rolesOf = async (daemon: DaemonProcess): Promise<Role[]> =>
    ((await daemon.invoke("roles.list", {})) as { roles: Role[] }).roles;

const roleOf = async (daemon: DaemonProcess, name: string): Promise<Role | undefined> =>
    (await rolesOf(daemon)).find((role) => role.name === name);

const waitFor = (page: Page, condition: string) =>
    page.waitForFunction(condition, undefined, { timeout: WAIT_MS, polling: POLL_MS });

async function openRoles(page: Page, port: number): Promise<void> {
    await page.goto(pageUrl(port, "/ui/#/roles"));
    await page.waitForSelector(roleCard("gp"), { timeout: WAIT_MS });
}

describe("the Roles page in chrome", () => {
    it("changes a shipped role's instructions and restores the shipped ones", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);
        const shipped = (await roleOf(daemon, "gp"))?.instructions;

        await page.fill(`${roleCard("gp")} textarea[name="instructions"]`, "Do it my way.");
        await page.click(`${roleCard("gp")} .role-save`);
        await waitFor(page, `document.querySelector('${roleCard("gp")}')?.dataset.changed === "true"`);
        t.assert.equal((await roleOf(daemon, "gp"))?.instructions, "Do it my way.");

        await page.click(`${roleCard("gp")} .role-restore`);
        await waitFor(page, `document.querySelector('${roleCard("gp")}')?.dataset.changed === "false"`);
        const restored = await roleOf(daemon, "gp");
        t.assert.equal(restored?.instructions, shipped);
        t.assert.equal(restored?.changed, false);
        t.assert.equal(await page.inputValue(`${roleCard("gp")} textarea[name="instructions"]`), shipped);
    });

    it("shows the service's refusal when desk is removed, and the role stays", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        await page.click(`${roleCard("desk")} .role-remove`);

        await page.waitForSelector(`${roleCard("desk")} .refusal`, { timeout: WAIT_MS });
        t.assert.notEqual((await page.locator(`${roleCard("desk")} .refusal`).textContent()) ?? "", "");
        t.assert.notEqual(await roleOf(daemon, "desk"), undefined);
        t.assert.equal(await page.locator(roleCard("desk")).count(), 1);
    });

    it("creates a role and removes it", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        await page.fill(`${CREATE_FORM} input[name="name"]`, "reviewer");
        await page.fill(`${CREATE_FORM} textarea[name="instructions"]`, "Review the work.");
        await page.click(`${CREATE_FORM} .role-create-submit`);
        await page.waitForSelector(roleCard("reviewer"), { timeout: WAIT_MS });
        t.assert.equal((await roleOf(daemon, "reviewer"))?.instructions, "Review the work.");

        await page.click(`${roleCard("reviewer")} .role-remove`);
        await waitFor(page, `document.querySelector('${roleCard("reviewer")}') === null`);
        t.assert.equal(await roleOf(daemon, "reviewer"), undefined);
    });

    it("states that a change affects only agents seated afterwards", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        t.assert.match((await page.locator(NOTE).textContent()) ?? "", /only agents seated afterwards/);
    });

    it("lists a role created elsewhere after a settings change", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        await daemon.invoke("roles.create", {
            name: "elsewhere",
            instructions: "Made on the command line.",
            tools: [],
        });

        await page.waitForSelector(roleCard("elsewhere"), { timeout: WAIT_MS });
    });

    it("reads the roles again on a new instance snapshot", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        proxy.dropFeedEvents();
        await daemon.invoke("roles.create", { name: "missed", instructions: "Made while events dropped.", tools: [] });
        proxy.forceFeedEnd("lagging");

        await page.waitForSelector(roleCard("missed"), { timeout: WAIT_MS });
    });

    it("disables creating, changing, restoring and removing while the service can't be reached", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        daemon.kill9();
        await daemon.exited;

        await waitFor(page, `document.querySelector(${JSON.stringify(BANNER)}) !== null`);
        for (const selector of [
            `${roleCard("gp")} .role-save`,
            `${roleCard("gp")} .role-restore`,
            `${roleCard("gp")} .role-remove`,
            `${CREATE_FORM} .role-create-submit`,
        ]) {
            t.assert.equal(await page.locator(selector).isDisabled(), true, selector);
        }
    });
});
