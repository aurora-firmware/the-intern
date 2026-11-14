import { readFile, writeFile } from "node:fs/promises";
import { afterEach, describe, it, type TestContext } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const SKILL = "carry-out-a-part";
const TYPED = "typed in the editor";
const HAND_EDIT = "edited by hand on disk\n";

type Job = { id: string; number: string };
type Rig = { daemon: DaemonProcess; port: number; job: Job; lead: string };
type SkillListing = { skills: { name: string; enabled: boolean }[] };
type InstructionListing = { files: { kind: string; path: string }[] };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startRig(): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    const job = (await daemon.invoke("jobs.create", { text: "job one" })) as Job;
    const detail = (await daemon.invoke("jobs.get", { job: job.id })) as { leadConversation?: string };
    if (detail.leadConversation === undefined) throw new Error(`job ${job.number} has no lead conversation`);
    return { daemon, port: await daemon.networkPort(), job, lead: detail.leadConversation };
}

const panelOf = (page: Page, rig: Rig) =>
    page.locator(`main details.activity[data-conversation="${rig.lead}"] .conversation-skills`);

const enabledOf = async (rig: Rig, name: string): Promise<boolean | undefined> =>
    ((await rig.daemon.invoke("skills.list", { conversation: rig.lead })) as SkillListing).skills.find(
        (skill) => skill.name === name,
    )?.enabled;

async function openPanel(t: TestContext, rig: Rig) {
    const browser = await launchBrowser(t, "chrome");
    if (browser === undefined) return undefined;
    const page = await browser.newPage();
    await page.goto(pageUrl(rig.port, `/ui/#/jobs/${rig.job.number}`));
    await panelOf(page, rig).locator("> summary").click({ timeout: WAIT_MS });
    await panelOf(page, rig).locator(".skill-row").first().waitFor({ timeout: WAIT_MS });
    return page;
}

async function commonPromptPath(rig: Rig): Promise<string> {
    const listing = (await rig.daemon.invoke("instructions.list", { conversation: rig.lead })) as InstructionListing;
    const common = listing.files.find((file) => file.kind === "common");
    if (common === undefined) throw new Error("the instructions list holds no common prompt");
    return common.path;
}

describe("the Skills panel on the Job page in chrome", () => {
    it("shows a skill enabled after its check box is checked, and the service agrees", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig();
        const page = await openPanel(t, rig);
        if (page === undefined) return;
        const box = panelOf(page, rig).locator(`.skill-row[data-skill="${SKILL}"] input[type=checkbox]`);
        t.assert.equal(await box.isChecked(), false);

        await box.check({ timeout: WAIT_MS });

        t.assert.equal(await box.isChecked(), true);
        t.assert.equal(await enabledOf(rig, SKILL), true);
    });

    it("shows a skill enabled elsewhere in the open panel without a reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig();
        const page = await openPanel(t, rig);
        if (page === undefined) return;
        await page.evaluate(() => Object.assign(globalThis, { notReloaded: true }));

        await rig.daemon.invoke("skills.enable", { conversation: rig.lead, name: SKILL });

        const box = panelOf(page, rig).locator(`.skill-row[data-skill="${SKILL}"] input[type=checkbox]`);
        await page.waitForFunction(
            (css) => (document.querySelector(css) as HTMLInputElement | null)?.checked === true,
            `main details.activity[data-conversation="${rig.lead}"] .skill-row[data-skill="${SKILL}"] input[type=checkbox]`,
            { timeout: WAIT_MS, polling: POLL_MS },
        );
        t.assert.equal(await box.isChecked(), true);
        t.assert.equal(await page.evaluate(() => "notReloaded" in globalThis), true);
    });

    it("shows the conflict and keeps the typed text when the common prompt was edited by hand", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig();
        const page = await openPanel(t, rig);
        if (page === undefined) return;
        const path = await commonPromptPath(rig);
        const editor = panelOf(page, rig).locator(".file-editor");
        await panelOf(page, rig).locator(`.instruction-row[data-kind="common"] .file-open`).click();
        await editor.locator("textarea").waitFor({ timeout: WAIT_MS });
        await writeFile(path, HAND_EDIT);

        await editor.locator("textarea").fill(TYPED);
        await editor.locator(".file-save").click();

        await editor.locator(".refusal").waitFor({ timeout: WAIT_MS });
        t.assert.equal(await editor.locator("textarea").inputValue(), TYPED);
        t.assert.equal(await readFile(path, "utf8"), HAND_EDIT);
    });

    it("loads the text from disk after a conflict and saves it with its token", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig();
        const page = await openPanel(t, rig);
        if (page === undefined) return;
        const path = await commonPromptPath(rig);
        const editor = panelOf(page, rig).locator(".file-editor");
        await panelOf(page, rig).locator(`.instruction-row[data-kind="common"] .file-open`).click();
        await editor.locator("textarea").waitFor({ timeout: WAIT_MS });
        await writeFile(path, HAND_EDIT);
        await editor.locator("textarea").fill(TYPED);
        await editor.locator(".file-save").click();
        await editor.locator(".file-use-disk").waitFor({ timeout: WAIT_MS });

        await editor.locator(".file-use-disk").click();

        await page.waitForFunction(
            ([css, wanted]) => (document.querySelector(css) as HTMLTextAreaElement | null)?.value === wanted,
            [`main details.activity[data-conversation="${rig.lead}"] .file-editor textarea`, HAND_EDIT] as const,
            { timeout: WAIT_MS, polling: POLL_MS },
        );
        await editor.locator("textarea").fill(`${HAND_EDIT}and one more line\n`);
        await editor.locator(".file-save").click();
        const saved = `${HAND_EDIT}and one more line\n`;
        const deadline = Date.now() + WAIT_MS;
        while ((await readFile(path, "utf8")) !== saved && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        t.assert.equal(await readFile(path, "utf8"), saved);
        t.assert.equal(await editor.locator(".refusal").count(), 0);
    });
});
