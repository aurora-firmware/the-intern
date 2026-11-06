import type { TestContext } from "node:test";
import { type Browser, chromium, firefox, type LaunchOptions } from "playwright-core";

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

function launchOptions(name: BrowserName, options: LaunchBrowserOptions): LaunchOptions {
    const launch: LaunchOptions = {};
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
 * Launches a browser that maps `intern.test` to the loopback address, and closes it when the test ends. A browser
 * that is not installed fails the test when `BOB_WEB_ALL_BROWSERS=1`; otherwise the test is skipped and the answer is
 * `undefined`, so the caller returns at once.
 */
export async function launchBrowser(
    t: TestContext,
    name: BrowserName,
    options: LaunchBrowserOptions = {},
): Promise<Browser | undefined> {
    const type = name === "firefox" ? firefox : chromium;
    let browser: Browser;
    try {
        browser = await type.launch(launchOptions(name, options));
    } catch (error) {
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
    t.after(() => browser.close());
    return browser;
}
