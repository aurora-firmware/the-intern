import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it, type TestContext } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const POLL_MS = 100;
const TEST_TIMEOUT_MS = scaled(120_000);
const SKILL = "carry-out-a-part";
const TYPED = "typed in the editor";
const HAND_EDIT = "edited by hand on disk\n";

type Job = { id: string; number: string };
type Rig = { env: HermeticEnv; daemon: DaemonProcess; port: number; job: Job; lead: string };
type SkillListing = {
    skills: { name: string; enabled: boolean; shadowed: { path: string }[] }[];
    leftOut: { path: string; reason: string }[];
};
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
    return { env, daemon, port: await daemon.networkPort(), job, lead: detail.leadConversation };
}

const panelOf = (page: Page, rig: Rig) =>
    page.locator(`main details.activity[data-conversation="${rig.lead}"] .conversation-skills`);

const enabledOf = async (rig: Rig, name: string): Promise<boolean | undefined> =>
    ((await rig.daemon.invoke("skills.list", { conversation: rig.lead })) as SkillListing).skills.find(
        (skill) => skill.name === name,
    )?.enabled;

/** The service learns of a check box change after the page sent it, so the answer is awaited, not read once. */
async function waitUntilEnabled(rig: Rig, name: string): Promise<boolean | undefined> {
    const deadline = Date.now() + WAIT_MS;
    let enabled = await enabledOf(rig, name);
    while (enabled !== true && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        enabled = await enabledOf(rig, name);
    }
    return enabled;
}

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
    it("lays the panel out as white cards with the check box beside the name and the source apart from Edit", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig();
        const page = await openPanel(t, rig);
        if (page === undefined) return;
        const row = panelOf(page, rig).locator(`.skill-row[data-skill="${SKILL}"]`);
        await panelOf(page, rig).locator(".instruction-row .file-open").first().click();
        await panelOf(page, rig).locator(".file-editor textarea").waitFor({ timeout: WAIT_MS });

        const layout = await page.evaluate(
            ([rowCss, panelCss]) => {
                const box = (css: string) => document.querySelector(css) as HTMLElement;
                const rect = (css: string) => box(css).getBoundingClientRect();
                const style = (css: string) => getComputedStyle(box(css));
                const panel = box(panelCss);
                const editorRect = (panel.querySelector(".file-editor") as HTMLElement).getBoundingClientRect();
                const areaRect = (panel.querySelector(".file-editor textarea") as HTMLElement).getBoundingClientRect();
                const editorStyle = getComputedStyle(panel.querySelector(".file-editor") as HTMLElement);
                const check = rect(`${rowCss} input[type=checkbox]`);
                const name = rect(`${rowCss} .skill-name`);
                const source = rect(`${rowCss} .skill-source`);
                const edit = rect(`${rowCss} .file-open`);
                return {
                    listStyle: style(`${panelCss} .skill-rows`).listStyleType,
                    rowBackground: style(rowCss).backgroundColor,
                    rowBorder: style(rowCss).borderTopWidth,
                    editorBackground: editorStyle.backgroundColor,
                    editorBorder: editorStyle.borderTopWidth,
                    checkBesideName:
                        Math.abs(check.top + check.height / 2 - (name.top + name.height / 2)) < check.height,
                    checkLeftOfName: check.right <= name.left,
                    sourceToEditGap: edit.left >= source.right + 4 || edit.top >= source.bottom,
                    areaFillsEditor: editorRect.width - areaRect.width < 40,
                };
            },
            [
                `main details.activity[data-conversation="${rig.lead}"] .skill-row[data-skill="${SKILL}"]`,
                `main details.activity[data-conversation="${rig.lead}"] .conversation-skills`,
            ] as const,
        );
        t.assert.equal(await row.count(), 1);
        t.assert.equal(layout.listStyle, "none");
        t.assert.equal(layout.rowBackground, "rgb(255, 255, 255)");
        t.assert.equal(layout.rowBorder, "1px");
        t.assert.equal(layout.editorBackground, "rgb(255, 255, 255)");
        t.assert.equal(layout.editorBorder, "1px");
        t.assert.equal(layout.checkBesideName, true);
        t.assert.equal(layout.checkLeftOfName, true);
        t.assert.equal(layout.sourceToEditGap, true);
        t.assert.equal(layout.areaFillsEditor, true);
    });

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
        t.assert.equal(await waitUntilEnabled(rig, SKILL), true);
    });

    it("keeps a check box checked while the panel reads again after the change", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig();
        const page = await openPanel(t, rig);
        if (page === undefined) return;
        const css = `main details.activity[data-conversation="${rig.lead}"] .skill-row[data-skill="${SKILL}"] input[type=checkbox]`;
        await page.evaluate((selector) => {
            const box = document.querySelector(selector) as HTMLInputElement;
            const seen: boolean[] = [];
            Object.assign(globalThis, { seenChecked: seen });
            box.addEventListener("click", () => {
                const start = performance.now();
                const sample = () => {
                    seen.push((document.querySelector(selector) as HTMLInputElement).checked);
                    if (performance.now() - start < 300) requestAnimationFrame(sample);
                };
                requestAnimationFrame(sample);
            });
        }, css);

        await panelOf(page, rig).locator(`.skill-row[data-skill="${SKILL}"] input[type=checkbox]`).check({
            timeout: WAIT_MS,
        });
        await page.waitForTimeout(400);

        const seen = await page.evaluate(() => (globalThis as unknown as { seenChecked: boolean[] }).seenChecked);
        t.assert.equal(seen.length > 0, true);
        t.assert.equal(seen.includes(false), false);
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

    it("shows the copies a skill shadows and the paths left out", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const rig = await startRig();
        const folders = [join(rig.env.root, "twins-a"), join(rig.env.root, "twins-b")];
        for (const folder of folders) {
            await mkdir(join(folder, "twin"), { recursive: true, mode: 0o700 });
            await chmod(folder, 0o700);
            await writeFile(join(folder, "twin", "SKILL.md"), "---\nname: twin\ndescription: a twin\n---\n\nBody.\n");
            await rig.daemon.invoke("skills.paths.add", { path: folder });
        }
        await mkdir(join(folders[1] as string, "broken"));
        await writeFile(join(folders[1] as string, "broken", "SKILL.md"), "---\nname: broken\n---\n\nBody.\n");
        const listing = (await rig.daemon.invoke("skills.list", { conversation: rig.lead })) as SkillListing;
        const shadowedPath = listing.skills.find((skill) => skill.name === "twin")?.shadowed[0]?.path;
        const leftOut = listing.leftOut[0];
        if (shadowedPath === undefined || leftOut === undefined)
            throw new Error("the rig has no shadowed copy or left-out path");
        const page = await openPanel(t, rig);
        if (page === undefined) return;

        const row = panelOf(page, rig).locator('.skill-row[data-skill="twin"] .skill-shadowed');
        await row.waitFor({ timeout: WAIT_MS });
        t.assert.match((await row.textContent()) ?? "", new RegExp(shadowedPath.replaceAll("/", "\\/")));
        const left = panelOf(page, rig).locator(".skills-left-out li");
        t.assert.match((await left.first().textContent()) ?? "", new RegExp(leftOut.reason.split(":")[0] as string));
        t.assert.match((await left.first().textContent()) ?? "", new RegExp(leftOut.path.replaceAll("/", "\\/")));
    });

    it("shows each skill change in the lead's activity, in order, naming the team member and the change", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startRig();
        const page = await openPanel(t, rig);
        if (page === undefined) return;
        const entries = page.locator(
            `main details.activity[data-conversation="${rig.lead}"] li.activity-entry[data-kind="intern.skills"]`,
        );

        await rig.daemon.invoke("skills.enable", { conversation: rig.lead, name: SKILL });
        await rig.daemon.invoke("skills.disable", { conversation: rig.lead, name: SKILL });

        await page.waitForFunction(
            (css) => document.querySelectorAll(css).length === 2,
            `main details.activity[data-conversation="${rig.lead}"] li.activity-entry[data-kind="intern.skills"]`,
            { timeout: WAIT_MS, polling: POLL_MS },
        );
        const enabled = (await entries.nth(0).textContent()) ?? "";
        const disabled = (await entries.nth(1).textContent()) ?? "";
        t.assert.match(enabled, /team member/i);
        t.assert.match(enabled, new RegExp(SKILL));
        t.assert.match(enabled, /\benabled\b/);
        t.assert.match(disabled, new RegExp(SKILL));
        t.assert.match(disabled, /\bdisabled\b/);
    });
});
