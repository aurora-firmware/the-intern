/**
 * Work that waits for a model, on the Front desk and Job pages (S-006 REQ-023, AC-023.2; ADR-014 decision 8): the
 * `intern.notice` entry shows where the transcript holds it and stays after a model is available, and a seat change to
 * no model names no model. The daemon's isolated pi agent folder names no default model at first.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import type { Page } from "playwright-core";
import { type FakeModelServer, MODEL_ID, startFakeModelServer } from "../install/fake_model_server.ts";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const TEST_TIMEOUT_MS = scaled(180_000);
const POLL_MS = 100;
const BOX = "main .desk textarea";
const SEND = "main .desk .desk-send";
const ENTRY = "main .activity-entry";
const NOTICE_KIND = "intern.notice";
const STEER_KIND = "intern.steer";
const NO_DEFAULT = "{}";
const LOOPBACK_DEFAULT = JSON.stringify({ defaultProvider: "loopback", defaultModel: MODEL_ID });

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const servers: FakeModelServer[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const server of servers.splice(0)) await server.close();
    for (const env of envs.splice(0)) await env.dispose();
});

type Rig = { env: HermeticEnv; daemon: DaemonProcess; port: number };
type Status = { noDefaultModel: { message: string } | null };

async function startNoModelDaemon(): Promise<Rig> {
    const env = await createHermeticEnv();
    envs.push(env);
    const server = await startFakeModelServer(() => "ok");
    servers.push(server);
    const models = {
        providers: {
            loopback: {
                baseUrl: server.baseUrl,
                api: "openai-completions",
                apiKey: "not-a-real-key",
                models: [{ id: MODEL_ID, reasoning: false }],
            },
        },
    };
    await writeFile(join(env.piAgentDir, "models.json"), JSON.stringify(models));
    await writeFile(join(env.piAgentDir, "settings.json"), NO_DEFAULT);
    const daemon = startDaemon({ hermetic: env, realModels: true, turnEndRule: false, networkListener: true });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon, port: await daemon.networkPort() };
}

/** Rewrites the folder's settings to name a default model, then waits until `daemon.status` shows that it noticed. */
async function nameDefaultModel(rig: Rig): Promise<void> {
    await writeFile(join(rig.env.piAgentDir, "settings.json"), LOOPBACK_DEFAULT);
    const deadline = Date.now() + WAIT_MS;
    while (((await rig.daemon.invoke("daemon.status", {})) as Status).noDefaultModel !== null) {
        if (Date.now() > deadline) throw new Error("the daemon did not notice the change of the default model");
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const waitFor = <Arg>(page: Page, predicate: (arg: Arg) => boolean, arg: Arg) =>
    page.waitForFunction(predicate, arg, { timeout: WAIT_MS, polling: POLL_MS });

/** Waits until the entries on the page read as `kinds`, in order. */
const waitForKinds = (page: Page, kinds: string[]) =>
    waitFor(
        page,
        ([selector, wanted]: [string, string[]]) => {
            const shown = [...document.querySelectorAll(selector)].map((node) => node.getAttribute("data-kind"));
            return shown.length === wanted.length && shown.every((kind, index) => kind === wanted[index]);
        },
        [ENTRY, kinds] as [string, string[]],
    );

const waitForPage = (page: Page) =>
    waitFor(page, (selector: string) => document.querySelector(selector) !== null, "main h2.page-heading");

const waitForText = (page: Page, selector: string, text: string) =>
    waitFor(
        page,
        ([sel, wanted]: [string, string]) =>
            [...document.querySelectorAll(sel)].some((node) => node.textContent?.includes(wanted)),
        [selector, text] as [string, string],
    );

async function openDesk(page: Page, port: number): Promise<void> {
    await page.goto(pageUrl(port, "/ui/#/desk"));
    await waitFor(
        page,
        (selector: string) => {
            const button = document.querySelector(selector) as HTMLButtonElement | null;
            return button !== null && !button.disabled && document.querySelector("main details.activity") !== null;
        },
        SEND,
    );
}

describe("the Front desk page with no model", () => {
    it("shows a message with the notice after it, not as failed, and keeps the notice above the answer", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startNoModelDaemon();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openDesk(page, rig.port);

        await page.fill(BOX, "hello desk");
        await page.click(SEND);

        await waitForKinds(page, [STEER_KIND, NOTICE_KIND]);
        await waitForText(page, `${ENTRY}[data-kind='${STEER_KIND}']`, "hello desk");
        t.assert.equal(await page.locator("main .desk-dropped, main .error").count(), 0);

        await nameDefaultModel(rig);
        await waitForKinds(page, [STEER_KIND, NOTICE_KIND, "intern.seat", "pi.assistant"]);
        await waitForText(page, ".activity-assistant", "ok");
    });
});

describe("a Job page with no model", () => {
    it("shows the job To do on the Board, its first input and the notice, and a seat change to no model as having none", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const rig = await startNoModelDaemon();
        await rig.daemon.invoke("roles.create", { name: "idle", instructions: "Wait." });
        const job = (await rig.daemon.invoke("jobs.create", { text: "wait for a model" })) as {
            id: string;
            number: string;
            leadConversation: string;
        };
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        await page.goto(pageUrl(rig.port, "/ui/#/"));
        await waitFor(
            page,
            (number: string) =>
                [...document.querySelectorAll("main .board-column[data-status='to_do'] .board-card")].some((card) =>
                    card.textContent?.includes(number),
                ),
            job.number,
        );
        await page.goto(pageUrl(rig.port, `/ui/#/jobs/${job.number}`));
        await waitForPage(page);
        await waitForKinds(page, ["pi.user", NOTICE_KIND]);
        await waitForText(page, `${ENTRY}[data-kind='pi.user']`, "wait for a model");

        await rig.daemon.invoke("conversations.seat", { conversationId: job.leadConversation, role: "idle" });
        await waitForText(page, ".activity-seat", "idle");
        const seat = (await page.locator(".activity-seat").last().textContent()) ?? "";
        t.assert.ok(seat.includes("no model"), seat);
        t.assert.ok(!seat.includes("null"), seat);
    });
});
