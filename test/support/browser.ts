import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { sep } from "node:path";
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

/** What `launchBrowser` does with a launch error: throw it, fail the test with the install command, or skip the test. */
export type LaunchFailureAction = "rethrow" | "fail" | "skip";

/**
 * Decides what a failed launch means. An error that is not a missing browser is rethrown, for any browser, so an
 * installed browser that fails still fails. A missing Chrome or Firefox fails the test when `allBrowsers` is true, and
 * is skipped otherwise. A missing Edge is always skipped: Edge is good to have, not required.
 */
export function launchFailureAction(name: BrowserName, message: string, allBrowsers: boolean): LaunchFailureAction {
    if (!MISSING_BROWSER.test(message)) {
        return "rethrow";
    }
    return allBrowsers && name !== "msedge" ? "fail" : "skip";
}

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
 * Launches a browser that maps `intern.test` to the loopback address, and closes it when the test ends. A missing
 * Chrome or Firefox fails the test when `BOB_WEB_ALL_BROWSERS=1`. Any other missing browser, and a missing Edge always,
 * skips the test with a diagnostic and answers `undefined`, so the caller returns at once.
 *
 * The browser runs with its own temporary directory, which this function removes by name when the test ends or the test
 * is skipped, so a run leaves nothing of the browser in `TMPDIR`. Chrome leaves a `url_fetcher` directory there, and
 * Playwright leaves its artifacts and profile directories when a launch fails.
 *
 * The directory has no prefix, only the 6 characters `mkdtemp` adds, and that is deliberate. Chrome refuses a socket
 * path of more than 107 characters, and its path is `<TMPDIR>/com.google.Chrome.XXXXXX/SingletonSocket`, 41 characters
 * after the directory it runs in. This directory adds 7 characters (the separator and 6), so Chrome needs a `TMPDIR` of
 * at most 59 characters, where without it 66 would do.
 */
export async function launchBrowser(
    t: TestContext,
    name: BrowserName,
    options: LaunchBrowserOptions = {},
): Promise<Browser | undefined> {
    const type = name === "firefox" ? firefox : chromium;
    const temporary = await mkdtemp(`${tmpdir()}${sep}`);
    let browser: Browser;
    try {
        browser = await launchInTemporaryDirectory(type, launchOptions(name, options, temporary), temporary);
    } catch (error) {
        await rm(temporary, { recursive: true, force: true });
        const message = error instanceof Error ? error.message : String(error);
        const action = launchFailureAction(name, message, process.env.BOB_WEB_ALL_BROWSERS === "1");
        if (action === "rethrow") {
            throw error;
        }
        if (action === "fail") {
            throw new Error(
                `Browser ${name} is not installed, and BOB_WEB_ALL_BROWSERS=1 requires Chrome and Firefox. ` +
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
