import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { type BrowserName, launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, freeLoopbackPort, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const BROWSERS: BrowserName[] = ["chrome", "msedge", "firefox"];
const WAIT_MS = 20_000;
const BANNER = ".connection-banner";
const FEED_MODULE = "./feed_connection.ts";
const OTHER_VERSION = "99.0.0";

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const proxies: WebProxy[] = [];

afterEach(async () => {
    for (const proxy of proxies.splice(0)) {
        await proxy.stop();
    }
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) {
        await env.dispose();
    }
});

type Rig = { port: number; stop(): Promise<void>; start(): Promise<void> };

/** A daemon on one fixed address, which `stop` kills and `start` launches again on the same address and state. */
async function startRig(): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const port = await freeLoopbackPort();
    let current: DaemonProcess | undefined;
    const rig: Rig = {
        port,
        async stop() {
            current?.kill9();
            await current?.exited;
        },
        async start() {
            current = startDaemon({
                hermetic: env,
                script: "echo",
                turnEndRule: false,
                networkListener: true,
                fixedPort: port,
            });
            daemons.push(current);
            await current.ready;
        },
    };
    await rig.start();
    return rig;
}

const waitForBanner = (page: Page, isShown: boolean) =>
    page.waitForFunction(
        ([selector, wanted]) => (document.querySelector(selector) !== null) === wanted,
        [BANNER, isShown] as [string, boolean],
        { timeout: WAIT_MS },
    );

const openBoard = async (page: Page, port: number) => {
    await page.goto(pageUrl(port, "/ui/#/"));
    await page.waitForSelector("main h2.page-heading");
};

/** A second connection of the page, counting the instance snapshots it hears in `globalThis.snapshots`. */
const countSnapshots = (page: Page) =>
    page.evaluate(async (module) => {
        const { connectFeed } = await import(module);
        const feed = await connectFeed();
        const state = { count: 0 };
        feed.onInstanceSnapshot(() => state.count++);
        Object.assign(globalThis, { snapshots: state });
    }, FEED_MODULE);

const waitForSnapshots = (page: Page) =>
    page.waitForFunction(() => (globalThis as unknown as { snapshots: { count: number } }).snapshots.count > 0, null, {
        timeout: WAIT_MS,
    });

for (const name of BROWSERS) {
    describe(`the connection banner in ${name}`, () => {
        it("shows the banner on every open page when the daemon stops and removes it when the daemon is back", async (t) => {
            const rig = await startRig();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) {
                return;
            }
            const board = await browser.newPage();
            await openBoard(board, rig.port);
            const roles = await browser.newPage();
            await roles.goto(pageUrl(rig.port, "/ui/#/roles"));
            await roles.waitForSelector("main h2.page-heading");
            await countSnapshots(board);

            await rig.stop();
            await waitForBanner(board, true);
            await waitForBanner(roles, true);

            await rig.start();
            await waitForBanner(board, false);
            await waitForBanner(roles, false);
            await waitForSnapshots(board);
        });

        it("tells the instance snapshot listeners, with no banner, when the feed ends lagging", async (t) => {
            const rig = await startRig();
            const proxy = await startWebProxy();
            proxies.push(proxy);
            const browser = await launchBrowser(t, name, { proxyPort: proxy.port });
            if (browser === undefined) {
                return;
            }
            const page = await browser.newPage();
            await openBoard(page, rig.port);
            await countSnapshots(page);

            proxy.forceFeedEnd("lagging");
            await waitForSnapshots(page);
            t.assert.equal(await page.locator(BANNER).count(), 0);
        });

        it("shows the banner at once, tells the worker and shows no refusal message when a call through pageClient fails as unavailable", async (t) => {
            const rig = await startRig();
            const proxy = await startWebProxy();
            proxies.push(proxy);
            const browser = await launchBrowser(t, name, { proxyPort: proxy.port });
            if (browser === undefined) {
                return;
            }
            const page = await browser.newPage();
            await openBoard(page, rig.port);
            const statusCalls = () =>
                proxy.requests().filter((request) => request.url.endsWith("/operations/daemon.status")).length;
            const before = statusCalls();

            proxy.forceUnavailable("daemon.status");
            const code = await page.evaluate(async (module) => {
                const { pageClient } = await import(module);
                try {
                    await pageClient().invoke("daemon.status");
                    return "answered";
                } catch (error) {
                    return (error as { code?: string }).code ?? "other";
                }
            }, FEED_MODULE);
            t.assert.equal(code, "unavailable");
            await waitForBanner(page, true);
            // The failed call itself and the worker's check made at once because the tab told it.
            while (statusCalls() < before + 2) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            t.assert.equal(await page.locator(".refusal").count(), 0);
            // The service answers again, so the banner goes.
            await waitForBanner(page, false);
        });

        it("tells the worker and shows the banner when a call through pageClient fails as unreachable", async (t) => {
            const rig = await startRig();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) {
                return;
            }
            const page = await browser.newPage();
            await openBoard(page, rig.port);

            await rig.stop();
            const failure = await page.evaluate(async (module) => {
                const { pageClient } = await import(module);
                try {
                    await pageClient().invoke("daemon.status");
                    return "answered";
                } catch (error) {
                    return (error as Error).name;
                }
            }, FEED_MODULE);
            t.assert.equal(failure, "UnreachableError");
            await waitForBanner(page, true);
            t.assert.equal(await page.locator(".refusal").count(), 0);
        });

        it("reloads the tab when it reconnects and daemon.status reports a different version", async (t) => {
            const rig = await startRig();
            const browser = await launchBrowser(t, name);
            if (browser === undefined) {
                return;
            }
            const page = await browser.newPage();
            await openBoard(page, rig.port);
            await page.route("**/operations/daemon.status", async (route) => {
                // Node cannot resolve intern.test, so the request goes to the loopback address.
                const url = route.request().url().replace("intern.test", "127.0.0.1");
                try {
                    const response = await route.fetch({ url });
                    const answer = await response.json();
                    answer.result.versions.intern = OTHER_VERSION;
                    await route.fulfill({ response, json: answer });
                } catch {
                    await route.abort();
                }
            });
            await page.evaluate(() => Object.assign(globalThis, { notReloaded: true }));

            await rig.stop();
            await waitForBanner(page, true);
            await rig.start();
            await page.waitForFunction(() => !("notReloaded" in globalThis), null, { timeout: WAIT_MS });
            await page.waitForSelector("main h2.page-heading");
        });
    });
}
