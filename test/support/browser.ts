import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { type Browser, type BrowserType, chromium, firefox, type LaunchOptions } from "playwright-core";

export type BrowserName = "chrome" | "msedge" | "firefox";

export interface LaunchBrowserOptions {
    /** The port of a forward proxy on the loopback address that every request of the browser goes through. */
    proxyPort?: number;
}

/** The name the pages are opened at: not loopback, so a page is no secure context, as on a team's network. */
const PAGE_HOST = "intern.test";
const LOOPBACK = "127.0.0.1";

/** Playwright's messages for a browser that is not installed. */
const MISSING_BROWSER = /Executable doesn't exist|is not found at/;

/** The address of a path on the daemon's listener, as the browser tests open it. */
export function pageUrl(port: number, path: string): string {
    return `http://${PAGE_HOST}:${port}${path}`;
}

function launchOptions(name: BrowserName, options: LaunchBrowserOptions, temporary: string): LaunchOptions {
    const launch: LaunchOptions = { env: { ...process.env, TMPDIR: temporary } };
    if (name === "firefox") {
        launch.firefoxUserPrefs = { "network.dns.localDomains": PAGE_HOST };
    } else {
        launch.channel = name;
        launch.args = [`--host-resolver-rules=MAP ${PAGE_HOST} ${LOOPBACK}`];
    }
    if (options.proxyPort !== undefined) {
        launch.proxy = { server: `http://${LOOPBACK}:${options.proxyPort}` };
    }
    return launch;
}

/**
 * Runs a launch with `TMPDIR` set to `temporary`, so that what Playwright creates before a launch fails goes there. The
 * previous value is restored when the launch ends.
 */
async function launchInTemporaryDirectory(type: BrowserType, launch: LaunchOptions, temporary: string) {
    const previous = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
    try {
        return await type.launch(launch);
    } finally {
        if (previous === undefined) {
            delete process.env.TMPDIR;
        } else {
            process.env.TMPDIR = previous;
        }
    }
}

/**
 * Launches a browser that maps `intern.test` to the loopback address, and closes it when the test ends. A browser
 * that is not installed fails the test when `BOB_WEB_ALL_BROWSERS=1`; otherwise the test is skipped and the answer is
 * `undefined`, so the caller returns at once.
 *
 * The browser runs with its own temporary directory, which this function removes by name when the test ends or the test
 * is skipped, so a run leaves nothing of the browser in `TMPDIR`. Chrome leaves a `url_fetcher` directory there, and
 * Playwright leaves its artifacts and profile directories when a launch fails.
 */
export async function launchBrowser(
    t: TestContext,
    name: BrowserName,
    options: LaunchBrowserOptions = {},
): Promise<Browser | undefined> {
    const type = name === "firefox" ? firefox : chromium;
    // The name is short on purpose: Chrome refuses a socket path of more than 107 characters, and it nests under this.
    const temporary = await mkdtemp(join(tmpdir(), "bb-"));
    let browser: Browser;
    try {
        browser = await launchInTemporaryDirectory(type, launchOptions(name, options, temporary), temporary);
    } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        const message = error instanceof Error ? error.message : String(error);
        if (!MISSING_BROWSER.test(message)) {
            throw error;
        }
        if (process.env.BOB_WEB_ALL_BROWSERS === "1") {
            throw new Error(
                `Browser ${name} is not installed, and BOB_WEB_ALL_BROWSERS=1 requires every browser. ` +
                    `Install it with "playwright-core install ${name}". ${message}`,
            );
        }
        t.skip(`browser ${name} is not installed; install it with "playwright-core install ${name}". ${message}`);
        return undefined;
    }
    t.after(async () => {
        try {
            await browser.close();
        } finally {
            await rm(temporary, { recursive: true, force: true });
        }
    });
    return browser;
}
