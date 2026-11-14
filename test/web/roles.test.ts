import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { startWebProxy, type WebProxy } from "../support/web_proxy.ts";

const WAIT_MS = 30_000;
const POLL_MS = 100;
const TEST_TIMEOUT_MS = 120_000;
const NOTE = "main .roles-note";
const CREATE_FORM = "main .role-create";
const CHANGE_PATH = "/operations/roles.change";
const BANNER = ".connection-banner";

type Role = {
    name: string;
    instructions: string;
    instructionsVersion?: string;
    shipped: boolean;
    changed: boolean;
};

const roleCard = (name: string) => `main .role[data-role="${name}"]`;

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const proxies: WebProxy[] = [];

afterEach(async () => {
    for (const proxy of proxies.splice(0)) await proxy.stop();
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function startServer(): Promise<{ daemon: DaemonProcess; port: number; env: HermeticEnv }> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return { daemon, port: await daemon.networkPort(), env };
}

const rolesOf = async (daemon: DaemonProcess): Promise<Role[]> =>
    ((await daemon.invoke("roles.list", {})) as { roles: Role[] }).roles;

const roleOf = async (daemon: DaemonProcess, name: string): Promise<Role | undefined> =>
    (await rolesOf(daemon)).find((role) => role.name === name);

type Entry = { kind: string };

/** The text of the system entry a new job's lead stores when it is seated, which holds the role's instructions. */
async function seatedInstructions(daemon: DaemonProcess, text: string): Promise<string> {
    const job = (await daemon.invoke("jobs.create", { text })) as { id: string };
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const detail = (await daemon.invoke("jobs.get", { job: job.id })) as { leadConversation?: string };
        if (detail.leadConversation !== undefined) {
            const { entries } = (await daemon.invoke("conversations.entries", {
                conversationId: detail.leadConversation,
                limit: 50,
            })) as { entries: Entry[] };
            const system = entries.find((entry) => entry.kind === "pi.system");
            if (system !== undefined) return JSON.stringify(system);
        }
        if (Date.now() > deadline) throw new Error("the new lead stored no system entry");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const waitFor = (page: Page, condition: string) =>
    page.waitForFunction(condition, undefined, { timeout: WAIT_MS, polling: POLL_MS });

async function openRoles(page: Page, port: number): Promise<void> {
    await page.goto(pageUrl(port, "/ui/#/roles"));
    await page.waitForSelector(roleCard("gp"), { timeout: WAIT_MS });
}

describe("the Roles page in chrome", () => {
    it("changes a shipped role's instructions and restores the shipped ones", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);
        const shipped = (await roleOf(daemon, "gp"))?.instructions;

        await page.fill(`${roleCard("gp")} textarea[name="instructions"]`, "Do it my way.");
        await page.click(`${roleCard("gp")} .role-save`);
        await waitFor(page, `document.querySelector('${roleCard("gp")}')?.dataset.changed === "true"`);
        t.assert.equal((await roleOf(daemon, "gp"))?.instructions, "Do it my way.");

        await page.click(`${roleCard("gp")} .role-restore`);
        await waitFor(page, `document.querySelector('${roleCard("gp")}')?.dataset.changed === "false"`);
        const restored = await roleOf(daemon, "gp");
        t.assert.equal(restored?.instructions, shipped);
        t.assert.equal(restored?.changed, false);
        t.assert.equal(await page.inputValue(`${roleCard("gp")} textarea[name="instructions"]`), shipped);
    });

    it("seats a new agent with the changed instructions, then with the shipped ones after a restore", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);
        const bob = roleCard("bob");
        const shipped = (await roleOf(daemon, "bob"))?.instructions ?? "";

        await page.fill(`${bob} textarea[name="instructions"]`, "SEATING-MARKER-7431");
        await page.click(`${bob} .role-save`);
        await waitFor(page, `document.querySelector('${bob}')?.dataset.changed === "true"`);
        t.assert.match(await seatedInstructions(daemon, "first job"), /SEATING-MARKER-7431/);

        await page.click(`${bob} .role-restore`);
        await waitFor(page, `document.querySelector('${bob}')?.dataset.changed === "false"`);
        const afterRestore = await seatedInstructions(daemon, "second job");
        t.assert.doesNotMatch(afterRestore, /SEATING-MARKER-7431/);
        t.assert.equal(afterRestore.includes(JSON.stringify(shipped.slice(0, 40)).slice(1, -1)), true);
    });

    it("shows the service's refusal when desk is removed, and the role stays", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        await page.click(`${roleCard("desk")} .role-remove`);

        await page.waitForSelector(`${roleCard("desk")} .refusal`, { timeout: WAIT_MS });
        t.assert.notEqual((await page.locator(`${roleCard("desk")} .refusal`).textContent()) ?? "", "");
        t.assert.notEqual(await roleOf(daemon, "desk"), undefined);
        t.assert.equal(await page.locator(roleCard("desk")).count(), 1);
    });

    it("creates a role and removes it", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        await page.fill(`${CREATE_FORM} input[name="name"]`, "reviewer");
        await page.fill(`${CREATE_FORM} textarea[name="instructions"]`, "Review the work.");
        await page.click(`${CREATE_FORM} .role-create-submit`);
        await page.waitForSelector(roleCard("reviewer"), { timeout: WAIT_MS });
        t.assert.equal((await roleOf(daemon, "reviewer"))?.instructions, "Review the work.");

        await page.click(`${roleCard("reviewer")} .role-remove`);
        await waitFor(page, `document.querySelector('${roleCard("reviewer")}') === null`);
        t.assert.equal(await roleOf(daemon, "reviewer"), undefined);
    });

    it("states that a change affects only agents seated afterwards", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        t.assert.match((await page.locator(NOTE).textContent()) ?? "", /only agents seated afterwards/);
    });

    it("states that instructions reach running agents from their next model request", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        const note = (await page.locator(NOTE).textContent()) ?? "";
        t.assert.match(note, /tools, default skills, default model, thinking level or workspace/);
        t.assert.match(note, /running agents from their next model request/);
    });

    it("sends the instructions token with changed instructions and shows the new text", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);
        const token = (await roleOf(daemon, "gp"))?.instructionsVersion;
        const bodies: Record<string, unknown>[] = [];
        page.on("request", (request) => {
            if (new URL(request.url()).pathname === CHANGE_PATH) bodies.push(request.postDataJSON());
        });

        await page.fill(`${roleCard("gp")} textarea[name="instructions"]`, "Do it my way.");
        await page.click(`${roleCard("gp")} .role-save`);
        await waitFor(page, `document.querySelector('${roleCard("gp")}')?.dataset.changed === "true"`);

        t.assert.equal(typeof token, "string");
        t.assert.equal(bodies[0]?.instructionsVersion, token);
        t.assert.equal(await page.inputValue(`${roleCard("gp")} textarea[name="instructions"]`), "Do it my way.");
    });

    it("leaves instructions and the token out of a save that changes only the tools", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);
        const bodies: Record<string, unknown>[] = [];
        page.on("request", (request) => {
            if (new URL(request.url()).pathname === CHANGE_PATH) bodies.push(request.postDataJSON());
        });

        await page.fill(`${roleCard("gp")} textarea[name="tools"]`, "read");
        await page.click(`${roleCard("gp")} .role-save`);
        await waitFor(page, `document.querySelector('${roleCard("gp")}')?.dataset.changed === "true"`);

        t.assert.equal("instructions" in (bodies[0] ?? {}), false);
        t.assert.equal("instructionsVersion" in (bodies[0] ?? {}), false);
    });

    it("shows the conflict and keeps the typed text when the file was edited by hand", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, env } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        await writeFile(join(env.dataDir, "instructions", "roles", "gp.md"), "Edited by hand.");
        await page.fill(`${roleCard("gp")} textarea[name="instructions"]`, "My typed text.");
        await page.click(`${roleCard("gp")} .role-save`);

        await page.waitForSelector(`${roleCard("gp")} .refusal`, { timeout: WAIT_MS });
        t.assert.equal(await page.inputValue(`${roleCard("gp")} textarea[name="instructions"]`), "My typed text.");
        t.assert.notEqual((await roleOf(daemon, "gp"))?.instructions, "My typed text.");
    });

    it("shows that a role's instruction file is missing", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port, env } = await startServer();
        await daemon.invoke("roles.create", { name: "ghost", instructions: "Haunt.", tools: [] });
        await rm(join(env.dataDir, "instructions", "roles", "ghost.md"));
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        await page.waitForSelector(`${roleCard("ghost")} .instructions-missing`, { timeout: WAIT_MS });
        t.assert.equal(await page.locator(`${roleCard("gp")} .instructions-missing`).count(), 0);
    });

    it("takes skills as names", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        const label = await page.locator(`${roleCard("gp")} label:has(textarea[name="skills"])`).textContent();

        t.assert.match(label ?? "", /Skills \(names, one per line\)/);
    });

    it("lists a role created elsewhere after a settings change", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        await daemon.invoke("roles.create", {
            name: "elsewhere",
            instructions: "Made on the command line.",
            tools: [],
        });

        await page.waitForSelector(roleCard("elsewhere"), { timeout: WAIT_MS });
    });

    it("reads the roles again on a new instance snapshot", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const proxy = await startWebProxy();
        proxies.push(proxy);
        const browser = await launchBrowser(t, "chrome", { proxyPort: proxy.port });
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        proxy.dropFeedEvents();
        await daemon.invoke("roles.create", { name: "missed", instructions: "Made while events dropped.", tools: [] });
        proxy.forceFeedEnd("lagging");

        await page.waitForSelector(roleCard("missed"), { timeout: WAIT_MS });
    });

    it("disables creating, changing, restoring and removing while the service can't be reached", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        daemon.kill9();
        await daemon.exited;

        await waitFor(page, `document.querySelector(${JSON.stringify(BANNER)}) !== null`);
        for (const selector of [
            `${roleCard("gp")} .role-save`,
            `${roleCard("gp")} .role-restore`,
            `${roleCard("gp")} .role-remove`,
            `${CREATE_FORM} .role-create-submit`,
        ]) {
            t.assert.equal(await page.locator(selector).isDisabled(), true, selector);
        }
    });
});

const SECTION = "main .skills-instructions";
const SKILL = "carry-out-a-part";
const shippedSkill = `${SECTION} .shipped-skill[data-skill="${SKILL}"]`;

type PathEntry = { path: string };
type SkillEntry = { name: string; path: string; edited: boolean };

async function skillFolder(root: string, name: string): Promise<string> {
    const folder = join(root, name);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    await chmod(root, 0o700);
    await writeFile(join(folder, "SKILL.md"), `---\nname: ${name}\ndescription: a skill\n---\n\nBody.\n`);
    return root;
}

const searchPathsOf = async (daemon: DaemonProcess): Promise<string[]> =>
    ((await daemon.invoke("skills.paths.list", {})) as PathEntry[]).map((entry) => entry.path);

describe("the Skills and instructions section of the Roles page in chrome", () => {
    it("lists an added search path last, and shows the reason next to a refused one", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port, env } = await startServer();
        const first = await skillFolder(join(env.root, "first-skills"), "first");
        const second = await skillFolder(join(env.root, "second-skills"), "second");
        await daemon.invoke("skills.paths.add", { path: first });
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);
        await page.waitForSelector(`${SECTION} .search-path`, { timeout: WAIT_MS });

        await page.fill(`${SECTION} input[name="searchPath"]`, second);
        await page.click(`${SECTION} .search-path-add`);
        await waitFor(page, `document.querySelectorAll(${JSON.stringify(`${SECTION} .search-path`)}).length === 2`);
        const shown = await page
            .locator(`${SECTION} .search-path`)
            .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.path));
        t.assert.deepEqual(shown, [first, second]);
        t.assert.deepEqual(await searchPathsOf(daemon), [first, second]);

        await page.fill(`${SECTION} input[name="searchPath"]`, join(env.root, "no-such-folder"));
        await page.click(`${SECTION} .search-path-add`);
        await page.waitForSelector(`${SECTION} .search-paths-form .refusal`, { timeout: WAIT_MS });
        t.assert.deepEqual(await searchPathsOf(daemon), [first, second]);
    });

    it("shows a restored shipped skill as not edited", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const listed = (await daemon.invoke("skills.list", { role: "gp" })) as { skills: SkillEntry[] };
        const skill = listed.skills.find((entry) => entry.name === SKILL);
        if (skill === undefined) throw new Error(`${SKILL} is not shipped`);
        await writeFile(join(skill.path, "SKILL.md"), "---\nname: carry-out-a-part\ndescription: mine\n---\n\nMine.\n");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);
        await waitFor(page, `document.querySelector(${JSON.stringify(shippedSkill)})?.dataset.edited === "true"`);

        await page.click(`${shippedSkill} .skill-restore`);

        await waitFor(page, `document.querySelector(${JSON.stringify(shippedSkill)})?.dataset.edited === "false"`);
        const after = (await daemon.invoke("skills.list", { role: "gp" })) as { skills: SkillEntry[] };
        t.assert.equal(after.skills.find((entry) => entry.name === SKILL)?.edited, false);
    });

    it("changes a role's default skills from its Skills panel", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);
        const panel = `${roleCard("gp")} .role-skills`;
        await page.click(`${panel} > summary`);
        const box = page.locator(`${panel} .skill-row[data-skill="${SKILL}"] input[type=checkbox]`);
        await box.waitFor({ timeout: WAIT_MS });
        const before = (await roleOf(daemon, "gp"))?.skills ?? [];
        t.assert.equal(before.includes(SKILL), false);

        await box.check({ timeout: WAIT_MS });

        await waitFor(page, `document.querySelector(${JSON.stringify(roleCard("gp"))}) !== null`);
        const deadline = Date.now() + WAIT_MS;
        while (!((await roleOf(daemon, "gp"))?.skills ?? []).includes(SKILL) && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
        t.assert.equal(((await roleOf(daemon, "gp"))?.skills ?? []).includes(SKILL), true);
    });

    it("shows the common prompt in the editor", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer();
        const listing = (await daemon.invoke("instructions.list", { role: "gp" })) as {
            files: { kind: string; path: string }[];
        };
        const common = listing.files.find((file) => file.kind === "common");
        if (common === undefined) throw new Error("the instructions list holds no common prompt");
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openRoles(page, port);

        await page.click(`${SECTION} .common-prompt .file-open`);

        const editor = `${SECTION} .common-prompt .file-editor textarea`;
        await page.waitForSelector(editor, { timeout: WAIT_MS });
        t.assert.equal(await page.inputValue(editor), await readFile(common.path, "utf8"));
    });
});
