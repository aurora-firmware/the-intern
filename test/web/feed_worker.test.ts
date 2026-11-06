import { afterEach, describe, it } from "node:test";
import type { BrowserContext, Page } from "playwright-core";
import { type BrowserName, launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const BROWSERS: BrowserName[] = ["chrome", "msedge", "firefox"];
const WORKER_URL = "./feed_worker.ts?v=test";
const PAGE_PATH = "/ui/index.html";
const SETTLE_MS = 400;
const WAIT_MS = 15_000;

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

type Fixture = { port: number; proxy: WebProxy; conversationId: string };

async function startFixture(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    const { conversationId } = (await daemon.invoke("test.createConversation", { key: "feed", cwd: "." })) as {
        conversationId: string;
    };
    const proxy = await startWebProxy();
    proxies.push(proxy);
    return { port: await daemon.networkPort(), proxy, conversationId };
}

/** Opens a page, connects it to the shared worker, and asks the worker for the instance feed and a conversation. */
async function connectTab(context: BrowserContext, port: number, conversationId: string): Promise<Page> {
    const page = await context.newPage();
    await page.goto(pageUrl(port, PAGE_PATH));
    await page.evaluate(
        ([workerUrl, id]) => {
            const received: { type: string; isConnected?: boolean; conversationId?: string }[] = [];
            const worker = new SharedWorker(workerUrl, { type: "module" });
            worker.port.onmessage = (event) => received.push(event.data);
            worker.port.postMessage({ type: "instance" });
            worker.port.postMessage({ type: "follow", conversationIds: [id] });
            Object.assign(globalThis, { received });
        },
        [WORKER_URL, conversationId],
    );
    return page;
}

const waitForMessage = (page: Page, type: string) =>
    page.waitForFunction(
        (wanted) =>
            (globalThis as unknown as { received: { type: string }[] }).received.some(
                (message) => message.type === wanted,
            ),
        type,
        { timeout: WAIT_MS },
    );

const feedRequests = (proxy: WebProxy, scope: string) =>
    proxy.requests().filter((request) => new URL(request.url).pathname === "/feed" && request.url.includes(scope));

for (const name of BROWSERS) {
    describe(`the shared feed worker in ${name}`, () => {
        it("holds one instance feed and one conversation stream when three tabs connect", async (t) => {
            const { port, proxy, conversationId } = await startFixture();
            const browser = await launchBrowser(t, name, { proxyPort: proxy.port });
            if (browser === undefined) {
                return;
            }
            const context = await browser.newContext();
            await context.route("**/ui/app.ts", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
            const pages = [];
            for (let tab = 0; tab < 3; tab++) {
                pages.push(await connectTab(context, port, conversationId));
            }
            await waitForMessage(pages[0], "instance-snapshot");
            await waitForMessage(pages[0], "conversation-snapshot");
            for (const page of pages) {
                await waitForMessage(page, "connection");
            }
            await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
            t.assert.equal(feedRequests(proxy, "scope=instance").length, 1);
            t.assert.equal(feedRequests(proxy, "scope=conversations").length, 1);
        });

        it("uses the same worker and opens no new stream when a reloaded tab connects again", async (t) => {
            const { port, proxy, conversationId } = await startFixture();
            const browser = await launchBrowser(t, name, { proxyPort: proxy.port });
            if (browser === undefined) {
                return;
            }
            const context = await browser.newContext();
            await context.route("**/ui/app.ts", (route) => route.fulfill({ contentType: "text/javascript", body: "" }));
            const pages = [];
            for (let tab = 0; tab < 3; tab++) {
                pages.push(await connectTab(context, port, conversationId));
            }
            await waitForMessage(pages[2], "conversation-snapshot");
            await pages[1].close();
            const reloaded = await connectTab(context, port, conversationId);
            await waitForMessage(reloaded, "connection");
            await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
            t.assert.equal(feedRequests(proxy, "scope=instance").length, 1);
            t.assert.equal(feedRequests(proxy, "scope=conversations").length, 1);
        });
    });
}
