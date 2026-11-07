import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 30_000;
const TEST_TIMEOUT_MS = 120_000;
const MOST_TABS = 60;
const BANNER = ".connection-banner";
const REFUSAL = "main .job-actions .refusal";
const AXE_FILE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

type Job = { id: string; number: string };
type Violation = { id: string; nodes: { target: unknown; failureSummary?: string }[] };
type AxeResult = { violations: Violation[] };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startBlockedJob(): Promise<{ daemon: DaemonProcess; port: number; job: Job }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({
        hermetic: env,
        script: "block-with-reason",
        turnEndRule: true,
        networkListener: true,
    });
    daemons.push(daemon);
    await daemon.ready;
    const job = (await daemon.invoke("jobs.create", { text: "which colour" })) as Job;
    return { daemon, port: await daemon.networkPort(), job };
}

/** A page of the web interface: where it is, and the element that shows it has drawn. */
type PageToOpen = { name: string; path: string; ready: string };

const pagesToOpen = (job: Job): PageToOpen[] => [
    { name: "Board", path: "/ui/#/", ready: "main .board-column .card" },
    { name: "Job", path: `/ui/#/jobs/${job.number}`, ready: 'main .job-field[data-field="blocked-reason"]' },
    { name: "Front desk", path: "/ui/#/desk", ready: "main details.activity" },
    { name: "Roles", path: "/ui/#/roles", ready: "main .role" },
    { name: "Workspaces", path: "/ui/#/workspaces", ready: "main .workspace-register" },
    { name: "Status", path: "/ui/#/status", ready: "main .status" },
];

/** The contrast violations axe-core finds on the page as drawn now. */
async function contrastViolations(page: Page): Promise<string[]> {
    await page.addScriptTag({ path: AXE_FILE });
    const result = (await page.evaluate(() =>
        (globalThis as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<unknown> } }).axe.run(document, {
            runOnly: { type: "rule", values: ["color-contrast"] },
        }),
    )) as AxeResult;
    return result.violations.flatMap((violation) =>
        violation.nodes.map((node) => `${violation.id} ${JSON.stringify(node.target)}: ${node.failureSummary ?? ""}`),
    );
}

/** What the focused element looks like: a drawn outline, or none. */
const focusedOutline = (page: Page) =>
    page.evaluate(() => {
        const element = document.activeElement;
        if (element === null || element === document.body) return "nothing is focused";
        const style = getComputedStyle(element);
        const drawn = style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0;
        return drawn ? "visible" : `no outline on ${element.tagName.toLowerCase()}`;
    });

/** Presses `key` until the element matching `selector` has focus, and lists each stop where the focus was not visible. */
async function pressUntilFocused(page: Page, key: "Tab" | "Shift+Tab", selector: string): Promise<string[]> {
    const faults: string[] = [];
    for (let presses = 0; presses < MOST_TABS; presses++) {
        await page.keyboard.press(key);
        const outline = await focusedOutline(page);
        if (outline !== "visible") faults.push(outline);
        if (await page.evaluate((css) => document.activeElement?.matches(css) === true, selector)) return faults;
    }
    throw new Error(`${key} did not reach ${selector} within ${MOST_TABS} presses`);
}

const tabTo = (page: Page, selector: string) => pressUntilFocused(page, "Tab", selector);
const tabBackTo = (page: Page, selector: string) => pressUntilFocused(page, "Shift+Tab", selector);

describe("contrast and keyboard use in chrome", () => {
    it("reaches 4.5:1 on every page", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port, job } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        const found: string[] = [];

        for (const target of pagesToOpen(job)) {
            await page.goto(pageUrl(port, target.path));
            await page.waitForSelector(target.ready, { timeout: WAIT_MS });
            await page.evaluate(() => document.fonts.ready);
            found.push(...(await contrastViolations(page)).map((line) => `${target.name}: ${line}`));
        }

        t.assert.deepEqual(found, []);
    });

    it("reaches 4.5:1 on the connection banner", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/"));
        await page.waitForSelector("main .board-column .card", { timeout: WAIT_MS });

        daemon.kill9();
        await page.waitForSelector(BANNER, { timeout: WAIT_MS });
        await page.evaluate(() => document.fonts.ready);

        t.assert.deepEqual(await contrastViolations(page), []);
    });

    it("reaches 4.5:1 on the error box of a refused cancel", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port, job } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, `/ui/#/jobs/${job.number}`));
        await page.waitForSelector("main .job-actions .job-cancel", { timeout: WAIT_MS });

        await page.click("main .job-actions .job-cancel");
        await page.waitForSelector(REFUSAL, { timeout: WAIT_MS });
        await page.evaluate(() => document.fonts.ready);

        t.assert.deepEqual(await contrastViolations(page), []);
    });

    it("draws the agent names of the activity sections in Bruno Ace", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port, job } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, `/ui/#/jobs/${job.number}`));
        await page.waitForSelector("main details.activity > summary", { timeout: WAIT_MS });

        const families = await page
            .locator("main details.activity > summary")
            .evaluateAll((names) => names.map((name) => getComputedStyle(name).fontFamily));

        t.assert.ok(families.length > 0);
        t.assert.deepEqual(
            families.filter((family) => !family.startsWith('"Bruno Ace"')),
            [],
        );
    });

    it("opens a Blocked job, answers it and goes back with the keyboard alone, the focus visible throughout", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, job } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/"));
        await page.waitForSelector("main .board-column .card", { timeout: WAIT_MS });
        const faults: string[] = [];

        faults.push(...(await tabTo(page, `main .card a[href='#/jobs/${job.number}']`)));
        await page.keyboard.press("Enter");
        await page.waitForSelector("main .answer textarea", { timeout: WAIT_MS });
        faults.push(...(await tabTo(page, "main .answer textarea")));
        await page.keyboard.type("blue");
        faults.push(...(await tabTo(page, "main .answer button")));
        await page.keyboard.press("Enter");
        await page.waitForFunction(
            () =>
                document.querySelector('main .job-field[data-field="status"] .job-value')?.textContent ===
                "In progress",
            undefined,
            { timeout: WAIT_MS },
        );
        faults.push(...(await tabBackTo(page, ".sidebar a[href='#/']")));
        await page.keyboard.press("Enter");
        await page.waitForSelector("main .board-column .card", { timeout: WAIT_MS });

        t.assert.deepEqual(faults, []);
        t.assert.match(page.url(), /#\/$/);
        daemon.releaseRuns();
    });
});
