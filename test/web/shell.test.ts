import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { type BrowserName, launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const BROWSERS: BrowserName[] = ["chrome", "msedge", "firefox"];
const LINKS = [
    { name: "Board", hash: "#/" },
    { name: "Front desk", hash: "#/desk" },
    { name: "Roles", hash: "#/roles" },
    { name: "Workspaces", hash: "#/workspaces" },
    { name: "Status", hash: "#/status" },
];

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) {
        await env.dispose();
    }
});

async function startNetworkDaemon(): Promise<number> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return daemon.networkPort();
}

const heading = (page: Page) => page.locator("main h2.page-heading").textContent();
const activeLinks = (page: Page) => page.locator(".sidebar a[aria-current='page']").allInnerTexts();

for (const name of BROWSERS) {
    describe(`the page shell in ${name}`, () => {
        it("shows the sidebar with the logo and the five links when /ui/ opens", async (t) => {
            const port = await startNetworkDaemon();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) {
                return;
            }
            const page = await browser.newPage();
            await page.goto(pageUrl(port, "/ui/"));
            await page.waitForSelector(".sidebar a");
            t.assert.deepEqual(
                await page.locator(".sidebar a").allInnerTexts(),
                LINKS.map((link) => link.name),
            );
            t.assert.deepEqual(
                await page.locator(".sidebar a").evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href"))),
                LINKS.map((link) => link.hash),
            );
            const logo = page.locator(".sidebar img");
            t.assert.equal(await logo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), true);
            t.assert.equal(await page.title(), "The Intern");
            t.assert.equal(await heading(page), "Board");
        });

        it("shows each page's heading and marks its link active when a sidebar link is followed", async (t) => {
            const port = await startNetworkDaemon();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) {
                return;
            }
            const page = await browser.newPage();
            await page.goto(pageUrl(port, "/ui/"));
            for (const link of LINKS) {
                await page.locator(".sidebar a", { hasText: link.name }).click();
                await page.waitForFunction(
                    (text) => document.querySelector("main h2.page-heading")?.textContent === text,
                    link.name,
                );
                t.assert.equal(new URL(page.url()).hash, link.hash === "#/" ? "#/" : link.hash);
                t.assert.equal(await heading(page), link.name);
                t.assert.deepEqual(await activeLinks(page), [link.name]);
            }
        });

        it("shows the page of an address opened directly, and the Board's heading for an unknown one", async (t) => {
            const port = await startNetworkDaemon();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) {
                return;
            }
            const page = await browser.newPage();
            await page.goto(pageUrl(port, "/ui/#/roles"));
            await page.waitForSelector("main h2.page-heading");
            t.assert.equal(await heading(page), "Roles");
            await page.goto(pageUrl(port, "/ui/#/nowhere"));
            await page.reload();
            await page.waitForSelector("main h2.page-heading");
            t.assert.equal(await heading(page), "Board");
        });

        it("loads preact and the client modules from the service at the addresses of ADR-006", async (t) => {
            const port = await startNetworkDaemon();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) {
                return;
            }
            const page = await browser.newPage();
            const loaded: string[] = [];
            page.on("response", (response) => {
                if (response.status() === 200) {
                    loaded.push(new URL(response.url()).pathname);
                }
            });
            await page.goto(pageUrl(port, "/ui/"));
            await page.waitForSelector(".sidebar a");
            for (const path of [
                "/ui/app.ts",
                "/ui/vendor/preact.mjs",
                "/ui/style/tokens.css",
                "/ui/style/components.css",
            ]) {
                assert.ok(loaded.includes(path), `${path} was not loaded; loaded: ${loaded.join(", ")}`);
            }
        });

        it("serves preact/hooks and the client modules at the addresses the import map and pages use", async (t) => {
            const port = await startNetworkDaemon();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) {
                return;
            }
            const page = await browser.newPage();
            await page.goto(pageUrl(port, "/ui/"));
            const mapped = await page.evaluate(
                () => JSON.parse(document.querySelector("script[type=importmap]")?.textContent ?? "{}").imports,
            );
            t.assert.deepEqual(mapped, { preact: "./vendor/preact.mjs", "preact/hooks": "./vendor/hooks.mjs" });
            for (const path of ["/ui/vendor/hooks.mjs", "/ui/client/client.ts", "/ui/client/browser_transport.ts"]) {
                const status = await page.evaluate(async (address) => (await fetch(address)).status, path);
                t.assert.equal(status, 200, path);
            }
        });
    });
}
