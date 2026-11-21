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
/** Commands, and text the service supplies as it stands: a role's name and instructions, an agent's words. */
const NOT_THE_PAGES_WORDING = "code, [data-verbatim]";

/**
 * The words `docs/system_overview.html` (section 4, Say and Not) rules out, each as a whole word, case-insensitively,
 * with its plural. `owner-only` and `worker thread` are right, and so is `job thread`, S-009's term for the emails
 * linked to a job.
 */
const RULED_OUT: readonly { word: string; pattern: RegExp }[] = [
    { word: "user", pattern: /\busers?\b/i },
    { word: "operator", pattern: /\boperators?\b/i },
    { word: "admin", pattern: /\badmins?\b/i },
    { word: "owner", pattern: /\bowners?\b(?!-only)/i },
    { word: "subagent", pattern: /\bsubagents?\b/i },
    { word: "sandbox", pattern: /\bsandbox(?:es)?\b/i },
    { word: "thread", pattern: /(?<!\b(?:worker|job) )\bthreads?\b/i },
    { word: "bob", pattern: /\bbob\b/i },
    { word: "task", pattern: /\btasks?\b/i },
];

/** The ruled-out words that `text` holds. */
const wordsRuledOut = (text: string): string[] =>
    RULED_OUT.filter(({ pattern }) => pattern.test(text)).map(({ word }) => word);

type Job = { id: string; number: string };

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
        t.assert.deepEqual(wordsRuledOut("Job thread, the job threads"), []);
        t.assert.deepEqual(wordsRuledOut("a mail thread, thread"), ["thread"]);
    });
});

/** Each ruled-out word the text of the pages holds, with the page and the line. */
async function wordsFound(page: Page, port: number, targets: PageToOpen[]): Promise<string[]> {
    const found: string[] = [];
    for (const target of targets) {
        await page.goto(pageUrl(port, target.path));
        await page.waitForSelector(target.ready, { timeout: WAIT_MS });
        await target.open?.(page);
        await page.evaluate(() => document.fonts.ready);
        for (const line of await pageWording(page)) {
            for (const word of wordsRuledOut(line)) found.push(`${target.name}: "${word}" in "${line}"`);
        }
    }
    return found;
}

describe("the page text in chrome", () => {
    it("holds no word the vocabulary rules out on any page", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port, job } = await startBlockedJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        t.assert.deepEqual(await wordsFound(page, port, pagesToOpen(job)), []);
    });

    it("holds no word the vocabulary rules out on the Mail page and a job that came by email", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port, job } = await startMailJob();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        t.assert.deepEqual(await wordsFound(page, port, mailPagesToOpen(job)), []);
    });
});
