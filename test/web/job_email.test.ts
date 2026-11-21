/**
 * The email section of the Job page (S-009 REQ-018, AC-018.1; S-006 REQ-003): a job that came by email shows its
 * account, sender, subject, saved message, attachments, job thread and request mark, and offers no download. The
 * daemon runs in this process, with a scripted lead, so the test sets the request mark when it chooses.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import type { Page } from "playwright-core";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createNetworkListenerComponent } from "../../src/listeners/network_listener.ts";
import { networkSection } from "../../src/listeners/network_section.ts";
import { createMailComponent } from "../../src/mail/mail_component.ts";
import { composeMessage } from "../../src/mail/mime.ts";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { createTestClock } from "../support/schedule_rig.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const POLL_MS = 20;
const TEST_TIMEOUT_MS = scaled(120_000);
const ADDRESS = "bob@example.test";
const SENDER = "ann@example.test";
const PASSWORD = "s3cret";
const CLOCK_START = "2026-03-02T11:00:00.000Z";
const UNUSED_CONFIGURED_PORT = 1;
const HOLD_MARKER = "hold the mark";
const REPORT = { filename: "report.pdf", contentType: "application/pdf", content: Buffer.alloc(10_240, 7) };
const NOTE = { filename: "note.txt", contentType: "text/plain", content: Buffer.from("remember the milk") };

type Job = { id: string; number: string };
type World = { daemon: RunningDaemon; server: FakeMailServer; port: number; markRequest(): void };

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(what: string, attempt: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_MS);
    }
}

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");

/** Answers "done", except for a job whose first message holds the marker: its lead waits, then marks the request. */
function leadScript(fake: FauxProviderRegistration, gate: Promise<void>): FauxResponseFactory {
    const respond: FauxResponseFactory = async (context) => {
        fake.appendResponses([respond]);
        const first = context.messages.find((message) => message.role === "user");
        const isHeld = first !== undefined && textOf(first.content).includes(HOLD_MARKER);
        const hasAnswered = context.messages.some((message) => message.role === "assistant");
        if (!isHeld || hasAnswered) return fauxAssistantMessage("done");
        await gate;
        return fauxAssistantMessage([fauxToolCall("mark_request", { marked: true }, { id: "call-mark" })], {
            stopReason: "toolUse",
        });
    };
    return respond;
}

async function writeConfig(env: HermeticEnv, fake: FauxProviderRegistration, server: FakeMailServer): Promise<void> {
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: fake.getModel().provider, defaultModel: "model-one" }),
    );
    await writeFile(
        join(env.configDir, "config.toml"),
        [
            `[network]\naddress = "127.0.0.1"\nport = ${UNUSED_CONFIGURED_PORT}\n`,
            "[[mail_account]]",
            'name = "work"',
            'kind = "owned"',
            `address = "${ADDRESS}"`,
            `login = "${ADDRESS}"`,
            'imap_host = "127.0.0.1"',
            `imap_port = ${server.imapPort}`,
            'imap_security = "none"',
            'auth = "password_command"',
            `password_command = ["printf", "%s", "${PASSWORD}"]`,
            "",
        ].join("\n"),
    );
}

/** The agents, jobs, mail and network listener components in this process, watching the account's inbox. */
async function startWorld(): Promise<World> {
    const env = await createHermeticEnv();
    cleanups.push(() => env.dispose());
    const server = await startFakeMailServer();
    cleanups.push(() => server.stop());
    server.addAccount({ address: ADDRESS, login: ADDRESS, password: PASSWORD });
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    cleanups.push(async () => fake.unregister());
    const gate = Promise.withResolvers<void>();
    fake.setResponses([leadScript(fake, gate.promise)]);
    await writeConfig(env, fake, server);

    const log: string[] = [];
    const logger = createLogger({ verbose: true, stream: { write: (line) => log.push(String(line)) > 0 } });
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
    const mail = await createMailComponent({ agents, jobs, logger, clock: createTestClock(new Date(CLOCK_START)) });
    const network = createNetworkListenerComponent({ freePort: true });
    const provider = fake.getModel().provider;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        sections: [...agents.sections, ...mail.sections, networkSection],
        components: [agents.component, jobs.component, mail.component, network],
        operations: [...agents.operations, ...jobs.operations, ...mail.operations],
        accountStatus: mail.accountStatus,
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            if (!implementation) throw new Error("the fake model's api is not registered");
            runtime.models.registerNativeProvider(
                createProvider({
                    id: provider,
                    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                    models: fake.models,
                    api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
                }),
            );
            return runtime.models;
        },
    });
    cleanups.push(() => daemon.stop());
    await until("intake to watch the inbox", () => (log.join("").includes("mail intake watching") ? true : undefined));
    const port = await until("the network listener", () => network.address()?.port);
    return { daemon, server, port, markRequest: gate.resolve };
}

const asTeamMember = { actor: { kind: "team_member", wayIn: "command line" } } as const;

async function deliver(world: World, subject: string, attachments: (typeof REPORT)[] = []): Promise<Job> {
    const sent = await composeMessage({ from: SENDER, to: [ADDRESS], subject, text: "please look", attachments });
    world.server.deliver(ADDRESS, sent.raw);
    return until("the job of the email", async () => {
        const { jobs } = (await world.daemon.catalogue.invoke("jobs.list", {}, asTeamMember)) as {
            jobs: (Job & { request: { text: string } })[];
        };
        return jobs.find((job) => job.request.text.includes(`Subject: ${subject}`));
    });
}

async function openJob(page: Page, port: number, number: string): Promise<void> {
    await page.goto(pageUrl(port, `/ui/#/jobs/${number}`));
    await page.waitForSelector("main .job-field");
}

const emailField = (page: Page, name: string) => page.locator(`main .job-email [data-field="${name}"]`);

describe("the Job page's email section in chrome", () => {
    it("shows the account, sender, subject, saved message, attachments, thread and request mark", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const world = await startWorld();
        const job = await deliver(world, "Files for you", [REPORT, NOTE]);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        await openJob(page, world.port, job.number);

        await page.waitForSelector("main .job-email");
        t.assert.equal(await emailField(page, "account").locator(".job-value").textContent(), "work");
        t.assert.equal(await emailField(page, "sender").locator(".job-value").textContent(), SENDER);
        t.assert.equal(await emailField(page, "subject").locator(".job-value").textContent(), "Files for you");
        t.assert.match((await emailField(page, "message").locator(".job-value").textContent()) ?? "", /please look/);
        t.assert.deepEqual(await page.locator("main .job-email .job-attachment").allTextContents(), [
            "report.pdf, 10240 bytes",
            "note.txt, 17 bytes",
        ]);
        const thread = await page.locator("main .job-email .job-thread-entry").allTextContents();
        t.assert.equal(thread.length, 1);
        t.assert.match(thread[0] ?? "", /received/);
        t.assert.match(thread[0] ?? "", /ann@example\.test/);
        t.assert.match(thread[0] ?? "", /bob@example\.test/);
        t.assert.match(thread[0] ?? "", /Files for you/);
        t.assert.equal(await emailField(page, "request-mark").locator(".job-value").textContent(), "Not set");
    });

    it("offers no link or button that fetches an attachment", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const world = await startWorld();
        const job = await deliver(world, "Files for you", [REPORT]);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        await openJob(page, world.port, job.number);

        await page.waitForSelector("main .job-email .job-attachment");
        t.assert.equal(await page.locator("main .job-email a, main .job-email button").count(), 0);
    });

    it("shows no email section for a job that did not come by email", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const world = await startWorld();
        const job = (await world.daemon.catalogue.invoke("jobs.create", { text: "tidy up" }, asTeamMember)) as Job;
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        await openJob(page, world.port, job.number);

        t.assert.equal(await page.locator("main .job-email").count(), 0);
    });

    it("shows the request mark without a reload once the lead sets it", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const world = await startWorld();
        const job = await deliver(world, `Mark this, ${HOLD_MARKER}`);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await openJob(page, world.port, job.number);
        await page.waitForSelector("main .job-email");
        t.assert.equal(await emailField(page, "request-mark").locator(".job-value").textContent(), "Not set");

        world.markRequest();

        await page.waitForFunction(
            () =>
                document.querySelector('main .job-email [data-field="request-mark"] .job-value')?.textContent ===
                "Set",
            undefined,
            { timeout: WAIT_MS },
        );
    });
});
