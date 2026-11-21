import { createRequire } from "node:module";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright-core";
import { composeMessage } from "../../src/mail/mime.ts";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { TEST_CA_FILE } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const TEST_TIMEOUT_MS = scaled(120_000);
const MOST_TABS = 60;
const BANNER = ".connection-banner";
const REFUSAL = "main .job-actions .refusal";
const RED = "rgb(230, 59, 38)";
const DARK_BLUE = "rgb(8, 10, 36)";
const AXE_FILE = createRequire(import.meta.url).resolve("axe-core/axe.min.js");

type Job = { id: string; number: string };
type Violation = { id: string; nodes: { target: unknown; failureSummary?: string }[] };
type AxeResult = { violations: Violation[] };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const rigs: MailRig[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const rig of rigs.splice(0)) await rig.stop();
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
    await daemon.invoke("schedules.create", { name: "weekly", cron: "0 3 * * *", request: "Run the weekly review." });
    return { daemon, port: await daemon.networkPort(), job };
}

/** A page of the web interface: where it is, and the element that shows it has drawn. */
type PageToOpen = { name: string; path: string; ready: string; open?: (page: Page) => Promise<void> };

/** Opens the Skills panel inside `scope`, then the editor of its first instruction file. */
async function openPanelAndEditor(page: Page, scope: string, panel: string): Promise<void> {
    await page.locator(`${scope} ${panel} > summary`).first().click({ timeout: WAIT_MS });
    await page.locator(`${scope} ${panel} .skill-row`).first().waitFor({ timeout: WAIT_MS });
    await page.locator(`${scope} ${panel} .instruction-row .file-open`).first().click({ timeout: WAIT_MS });
    await page.locator(`${scope} ${panel} .file-editor textarea`).waitFor({ timeout: WAIT_MS });
}

/** Opens the Skills panel of the first role and its editor, then the editor of the common prompt. */
async function openRolesEditors(page: Page): Promise<void> {
    await openPanelAndEditor(page, "main .role", ".role-skills");
    await page.locator("main .skills-instructions .common-prompt .file-open").click({ timeout: WAIT_MS });
    await page.locator("main .skills-instructions .file-editor textarea").waitFor({ timeout: WAIT_MS });
}

const openJobEditors = (page: Page) => openPanelAndEditor(page, "main details.activity", ".conversation-skills");

const pagesToOpen = (job: Job): PageToOpen[] => [
    { name: "Board", path: "/ui/#/", ready: "main .board-column .card" },
    { name: "Job", path: `/ui/#/jobs/${job.number}`, ready: 'main .job-field[data-field="blocked-reason"]' },
    { name: "Front desk", path: "/ui/#/desk", ready: "main details.activity" },
    { name: "Roles", path: "/ui/#/roles", ready: "main .role" },
    { name: "Workspaces", path: "/ui/#/workspaces", ready: "main .workspace-register" },
    { name: "Status", path: "/ui/#/status", ready: "main .status" },
    { name: "Schedules", path: "/ui/#/schedules", ready: "main .schedule" },
    {
        name: "Roles with the Skills panel and the editors open",
        path: "/ui/#/roles",
        ready: "main .role",
        open: openRolesEditors,
    },
    {
        name: "Job with the Skills panel and the editor open",
        path: `/ui/#/jobs/${job.number}`,
        ready: "main details.activity",
        open: openJobEditors,
    },
];

const MAIL_ACCOUNT = { name: "work", address: "work@example.test", password: "work-secret" };
const MAIL_CLOCK = "2026-03-02T09:00:00.000Z";
const STOP_TIMEOUT_MS = scaled(20_000);
const POLL_MS = 100;

async function until<T>(description: string, attempt: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
        await sleep(POLL_MS);
    }
}

/**
 * A daemon with a network listener, an owned mail account that is ready and one job that came by email with an
 * attachment. The rig's own daemon has no listener, so another takes its directories, as `mail_page` does.
 */
async function startMailJob(): Promise<{ port: number; job: Job }> {
    const rig = await startMailRig({ accounts: [MAIL_ACCOUNT], clockStart: new Date(MAIL_CLOCK) });
    rigs.push(rig);
    const first = rig.process();
    first.signal("SIGTERM");
    await Promise.race([first.exited, sleep(STOP_TIMEOUT_MS, undefined, { ref: false })]);
    const daemon = startDaemon({
        hermetic: { ...rig.env, env: { ...rig.env.env, NODE_EXTRA_CA_CERTS: TEST_CA_FILE } },
        mailClock: MAIL_CLOCK,
        oauthEndpoints: rig.oauth.endpoints,
        networkListener: true,
    });
    daemons.push(daemon);
    await daemon.ready;
    await until("intake to watch the inbox", async () =>
        daemon.stderr().includes("mail intake watching") ? true : undefined,
    );
    const sent = await composeMessage({
        from: "ann@example.test",
        to: [MAIL_ACCOUNT.address],
        subject: "Files for you",
        text: "please look",
        attachments: [{ filename: "report.pdf", contentType: "application/pdf", content: Buffer.alloc(1024, 7) }],
    });
    rig.deliver(MAIL_ACCOUNT.address, sent.raw);
    const job = await until("the job of the email", async () => {
        const { jobs } = (await daemon.invoke("jobs.list", {})) as { jobs: Job[] };
        return jobs[0];
    });
    return { port: await daemon.networkPort(), job };
}

const mailPagesToOpen = (job: Job): PageToOpen[] => [
    { name: "Mail", path: "/ui/#/mail", ready: "main .mail-account" },
    { name: "Job that came by email", path: `/ui/#/jobs/${job.number}`, ready: "main .job-email" },
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

/** The contrast violations of each page, with the page's name. */
async function contrastFound(page: Page, port: number, targets: PageToOpen[]): Promise<string[]> {
    const found: string[] = [];
    for (const target of targets) {
        await page.goto(pageUrl(port, target.path));
        await page.waitForSelector(target.ready, { timeout: WAIT_MS });
        await target.open?.(page);
        await page.evaluate(() => document.fonts.ready);
        found.push(...(await contrastViolations(page)).map((line) => `${target.name}: ${line}`));
    }
    return found;
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

        t.assert.deepEqual(await contrastFound(page, port, pagesToOpen(job)), []);
    });

    it("reaches 4.5:1 on the Mail page and a job that came by email", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port, job } = await startMailJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        t.assert.deepEqual(await contrastFound(page, port, mailPagesToOpen(job)), []);
    });

    it("reaches each control of the Mail page with the keyboard alone, the focus visible throughout", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port } = await startMailJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/mail"));
        await page.waitForSelector("main .mail-account", { timeout: WAIT_MS });
        const faults: string[] = [];

        faults.push(...(await tabTo(page, "main .mail-notice .mail-notice-save")));
        faults.push(...(await tabTo(page, "main .mail-account .mail-save")));
        faults.push(...(await tabTo(page, "main .mail-account .mail-remove")));
        faults.push(...(await tabTo(page, "main .mail-create .mail-create-submit")));
        faults.push(...(await tabBackTo(page, "main .mail-account .mail-remove")));

        t.assert.deepEqual(faults, []);
    });

    it("reaches 4.5:1 on the connection banner, drawn Dark Blue on Red", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/"));
        await page.waitForSelector("main .board-column .card", { timeout: WAIT_MS });

        daemon.kill9();
        await page.waitForSelector(BANNER, { timeout: WAIT_MS });
        await page.evaluate(() => document.fonts.ready);

        const drawn = await page.locator(BANNER).evaluate((el) => ({
            background: getComputedStyle(el).backgroundColor,
            color: getComputedStyle(el).color,
        }));
        t.assert.deepEqual(drawn, { background: RED, color: DARK_BLUE });
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

        t.assert.notEqual(families.length, 0);
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
