import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { type TestContext, test } from "node:test";
import { promisify } from "node:util";
import { type BrowserName, launchBrowser, launchFailureAction, pageUrl } from "../support/browser.ts";

const run = promisify(execFile);
const BROWSERS = ["chrome", "msedge", "firefox"] as const;
const SUPPORT_MODULE = join(import.meta.dirname, "..", "support", "browser.ts");

const PAGE = `<!doctype html><title>probe</title><body>probe`;

/** Starts a loopback server that answers every request with a page and records each request's `Host` header. */
async function startServer(t: TestContext): Promise<{ port: number; hosts: string[] }> {
    const hosts: string[] = [];
    const server: Server = createServer((request: IncomingMessage, response) => {
        hosts.push(request.headers.host ?? "");
        response.setHeader("content-type", "text/html");
        response.end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        server.closeAllConnections();
        server.close();
    });
    return { port: (server.address() as AddressInfo).port, hosts };
}

for (const name of BROWSERS) {
    test(`${name} reaches the loopback server with intern.test as the host and no secure context`, async (t) => {
        const { port, hosts } = await startServer(t);
        const browser = await launchBrowser(t, name);
        if (browser === undefined) {
            return;
        }
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/"));
        const isSecure = await page.evaluate(() => globalThis.isSecureContext);
        t.assert.equal(new URL(page.url()).host, `intern.test:${port}`);
        // The browser may also ask for a favicon, so the requests are checked for their host, not their number.
        assert.ok(hosts.length > 0);
        assert.ok(hosts.every((host) => host === `intern.test:${port}`));
        t.assert.equal(isSecure, false);
    });
}

test("pageUrl gives the intern.test address of a path", (t) => {
    t.assert.equal(pageUrl(4321, "/ui/"), "http://intern.test:4321/ui/");
});

test("launchBrowser sends the page's requests through the forward proxy of proxyPort", async (t) => {
    const seen: string[] = [];
    const proxy = createServer((request, response) => {
        seen.push(request.url ?? "");
        response.setHeader("content-type", "text/html");
        response.end(PAGE);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    t.after(() => {
        proxy.closeAllConnections();
        proxy.close();
    });
    const browser = await launchBrowser(t, "chrome", { proxyPort: (proxy.address() as AddressInfo).port });
    if (browser === undefined) {
        return;
    }
    const page = await browser.newPage();
    await page.goto(pageUrl(4321, "/ui/"));
    // Chrome's own background requests go through the proxy too, so the page's request is looked for among them.
    assert.ok(seen.includes("http://intern.test:4321/ui/"));
});

/** Runs `launchBrowser(name)` in a child process whose Playwright browser directory is empty. */
async function launchMissingBrowser(name: BrowserName, allBrowsers: boolean) {
    const emptyDirectory = await mkdtemp(join(tmpdir(), "bob-no-browsers-"));
    const script = `
        const { launchBrowser } = await import(process.argv[1]);
        const skips = [];
        const t = { skip: (reason) => skips.push(reason), after: () => {} };
        try {
            const browser = await launchBrowser(t, process.argv[2]);
            console.log(JSON.stringify({ browser: browser === undefined ? "undefined" : "launched", skips }));
            await browser?.close();
        } catch (error) {
            console.log(JSON.stringify({ error: String(error.message), skips }));
        }`;
    try {
        const env: NodeJS.ProcessEnv = { ...process.env, PLAYWRIGHT_BROWSERS_PATH: emptyDirectory };
        if (allBrowsers) {
            env.BOB_WEB_ALL_BROWSERS = "1";
        } else {
            delete env.BOB_WEB_ALL_BROWSERS;
        }
        const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script, SUPPORT_MODULE, name], {
            env,
        });
        return JSON.parse(stdout) as { browser?: string; error?: string; skips: string[] };
    } finally {
        await rm(emptyDirectory, { recursive: true, force: true });
    }
}

test("launchBrowser fails naming the install command when a browser is missing and all browsers are required", async (t) => {
    const outcome = await launchMissingBrowser("firefox", true);
    t.assert.match(outcome.error ?? "", /playwright-core install/);
    t.assert.deepEqual(outcome.skips, []);
});

test("launchBrowser skips the test with a diagnostic and answers undefined when a browser is missing", async (t) => {
    const outcome = await launchMissingBrowser("firefox", false);
    t.assert.equal(outcome.browser, "undefined");
    t.assert.equal(outcome.skips.length, 1);
    t.assert.match(outcome.skips[0] ?? "", /firefox/);
});

test("launchBrowser skips a missing msedge with a diagnostic when all browsers are required", async (t) => {
    // Playwright finds Edge by channel at a system path, so an empty browser directory hides it only where it is absent.
    const outcome = await launchMissingBrowser("msedge", true);
    if (outcome.browser === "launched") {
        t.skip("browser msedge is installed");
        return;
    }
    t.assert.equal(outcome.browser, "undefined");
    t.assert.equal(outcome.skips.length, 1);
    t.assert.match(outcome.skips[0] ?? "", /msedge/);
});

const MISSING = "Executable doesn't exist at /somewhere";

for (const name of ["chrome", "firefox"] as const) {
    test(`launchFailureAction fails a missing ${name} when all browsers are required`, (t) => {
        t.assert.equal(launchFailureAction(name, MISSING, true), "fail");
    });

    test(`launchFailureAction skips a missing ${name} when all browsers are not required`, (t) => {
        t.assert.equal(launchFailureAction(name, MISSING, false), "skip");
    });
}

for (const allBrowsers of [true, false]) {
    test(`launchFailureAction skips a missing msedge when all browsers required is ${allBrowsers}`, (t) => {
        t.assert.equal(launchFailureAction("msedge", MISSING, allBrowsers), "skip");
    });
}

for (const name of BROWSERS) {
    test(`launchFailureAction rethrows a ${name} launch error that is not a missing browser`, (t) => {
        t.assert.equal(launchFailureAction(name, "Process crashed", true), "rethrow");
        t.assert.equal(launchFailureAction(name, "Process crashed", false), "rethrow");
    });
}

/**
 * Runs `launchBrowser(name)` in a child process whose `TMPDIR` is a new directory, loads a page over http when the
 * browser starts, ends the test, and answers what the browser left in that `TMPDIR`.
 */
async function leftInTemporaryDirectory(name: BrowserName) {
    // The name has no prefix on purpose: Chrome refuses a socket path of more than 107 characters, and it nests under this.
    const temporary = await mkdtemp(`${tmpdir()}${sep}`);
    const script = `
        const http = await import("node:http");
        const { readdirSync } = await import("node:fs");
        const { launchBrowser, pageUrl } = await import(process.argv[1]);
        const afters = [];
        const t = { skip: () => {}, after: (callback) => afters.push(callback) };
        const server = http.createServer((request, response) => response.end("hi"));
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const browser = await launchBrowser(t, process.argv[2]);
        if (browser !== undefined) {
            const page = await browser.newPage();
            await page.goto(pageUrl(server.address().port, "/"));
            await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        for (const callback of afters.reverse()) {
            await callback();
        }
        server.closeAllConnections();
        server.close();
        console.log(JSON.stringify({ launched: browser !== undefined, left: readdirSync(process.env.TMPDIR) }));`;
    try {
        const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: temporary };
        delete env.BOB_WEB_ALL_BROWSERS;
        const { stdout } = await run(process.execPath, ["--input-type=module", "-e", script, SUPPORT_MODULE, name], {
            env,
        });
        return JSON.parse(stdout) as { launched: boolean; left: string[] };
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

test("launchBrowser leaves nothing in TMPDIR after a chrome page loaded over http and the test ended", async (t) => {
    const outcome = await leftInTemporaryDirectory("chrome");
    if (!outcome.launched) {
        t.skip("browser chrome is not installed");
        return;
    }
    t.assert.deepEqual(outcome.left, []);
});

test("launchBrowser leaves nothing in TMPDIR when the browser is missing and the test is skipped", async (t) => {
    // Edge cannot be installed on a development machine, so the launch fails as it does for any missing browser.
    const outcome = await leftInTemporaryDirectory("msedge");
    if (outcome.launched) {
        t.skip("browser msedge is installed");
        return;
    }
    t.assert.deepEqual(outcome.left, []);
});
