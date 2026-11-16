import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const TEST_TIMEOUT_MS = scaled(120_000);
/** Commands, and text the service supplies as it stands: a role's name and instructions, an agent's words. */
const NOT_THE_PAGES_WORDING = "code, [data-verbatim]";

/**
 * The words `docs/system_overview.html` (section 4, Say and Not) rules out, each as a whole word, case-insensitively,
 * with its plural. `owner-only` and `worker thread` are right.
 */
const RULED_OUT: readonly { word: string; pattern: RegExp }[] = [
    { word: "user", pattern: /\busers?\b/i },
    { word: "operator", pattern: /\boperators?\b/i },
    { word: "admin", pattern: /\badmins?\b/i },
    { word: "owner", pattern: /\bowners?\b(?!-only)/i },
    { word: "subagent", pattern: /\bsubagents?\b/i },
    { word: "sandbox", pattern: /\bsandbox(?:es)?\b/i },
    { word: "thread", pattern: /(?<!\bworker )\bthreads?\b/i },
    { word: "bob", pattern: /\bbob\b/i },
    { word: "task", pattern: /\btasks?\b/i },
];

/** The ruled-out words that `text` holds. */
const wordsRuledOut = (text: string): string[] =>
    RULED_OUT.filter(({ pattern }) => pattern.test(text)).map(({ word }) => word);

type Job = { id: string; number: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startBlockedJob(): Promise<{ port: number; job: Job }> {
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
    return { port: await daemon.networkPort(), job };
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
    { name: "Job", path: `/ui/#/jobs/${job.number}`, ready: "main details.activity li.activity-entry" },
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

/** The visible text of the page with every collapsed area open, leaving out code and verbatim text. */
function pageWording(page: Page): Promise<string[]> {
    return page.evaluate((skipped) => {
        for (const area of document.querySelectorAll("details")) area.open = true;
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const lines: string[] = [];
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const element = node.parentElement;
            const text = node.textContent?.trim() ?? "";
            if (element === null || text === "" || element.closest(skipped) !== null) continue;
            if (!element.checkVisibility() || element.closest("script, style") !== null) continue;
            lines.push(text);
        }
        return lines;
    }, NOT_THE_PAGES_WORDING);
}

describe("the search for words the vocabulary rules out", () => {
    it("finds each ruled-out word as a whole word, and passes the right ones", (t) => {
        t.assert.deepEqual(wordsRuledOut("A User, the OPERATORS, an admin; sandbox"), [
            "user",
            "operator",
            "admin",
            "sandbox",
        ]);
        t.assert.deepEqual(wordsRuledOut("an owner, a subagent, a thread, Bob, the task"), [
            "owner",
            "subagent",
            "thread",
            "bob",
            "task",
        ]);
        t.assert.deepEqual(wordsRuledOut("owner-only, worker threads, a job, username, tasking, bobbin"), []);
    });
});

describe("the page text in chrome", () => {
    it("holds no word the vocabulary rules out on any page", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port, job } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        const found: string[] = [];

        for (const target of pagesToOpen(job)) {
            await page.goto(pageUrl(port, target.path));
            await page.waitForSelector(target.ready, { timeout: WAIT_MS });
            await target.open?.(page);
            await page.evaluate(() => document.fonts.ready);
            for (const line of await pageWording(page)) {
                for (const word of wordsRuledOut(line)) found.push(`${target.name}: "${word}" in "${line}"`);
            }
        }

        t.assert.deepEqual(found, []);
    });
});
