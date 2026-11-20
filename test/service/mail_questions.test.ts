/**
 * Questions by email (S-009 REQ-009, REQ-013, REQ-014; S-004 v0.18 REQ-013): the lead's block with a mail text, the
 * sender, the fake mail server and intake joined in one daemon of this process. The lead follows a script of the fake
 * model, so each test chooses what it calls and when; a script is chosen by a key in the first message of its job.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createMailComponent } from "../../src/mail/mail_component.ts";
import { parseMessage } from "../../src/mail/mime.ts";
import type { Caller } from "../../src/service/operations.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const OWNED = "bob@example.test";
const PASSWORD = "pw";
const ANA = "ana@example.com";
const OPS = "ops@example.com";
const QUESTION = "Which server do you mean?";
const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };
const commandLineCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

type Step = { calls: { name: string; arguments: Record<string, unknown> }[] } | { hold: Promise<unknown> };
type Steer = { kind: string; data: { actor: unknown; content: string } };
type JobView = { id: string; status: string; leadConversation: string };

const block = (arguments_: Record<string, unknown>): Step => ({
    calls: [{ name: "block_job", arguments: arguments_ }],
});
const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];
const servers: FakeMailServer[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const server of servers.splice(0)) await server.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

async function until<T>(what: string, attempt: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");

/**
 * A daemon with the agents, jobs and mail components over a fake mail server that serves the owned account, and the
 * notice settings when given. `scripts` maps a key to the lead's steps, one for each of its model replies.
 */
async function start(scripts: Record<string, Step[]>, options: { notice?: string; turnEndRule?: boolean } = {}) {
    const env = await createHermeticEnv();
    envs.push(env);
    const server = await startFakeMailServer();
    servers.push(server);
    server.addAccount({ address: OWNED, login: OWNED, password: PASSWORD });
    const name = options.notice ?? "work";
    const noticeToml = options.notice === undefined ? "" : `[mail]\nnotice_to = "${OPS}"\nnotice_from = "${name}"\n\n`;
    await writeFile(
        join(env.configDir, "config.toml"),
        `${noticeToml}[[mail_account]]\nname = "${name}"\nkind = "owned"\naddress = "${OWNED}"\n` +
            `imap_host = "127.0.0.1"\nimap_port = ${server.imapPort}\nimap_security = "none"\n` +
            `smtp_host = "127.0.0.1"\nsmtp_port = ${server.smtpPort}\nsmtp_security = "none"\n` +
            `auth = "password_command"\npassword_command = ["printf", "%s", "${PASSWORD}"]\n`,
    );
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const toolResults: { text: string; isError: boolean }[] = [];
    const respond: FauxResponseFactory = async (context, streamOptions) => {
        fake.appendResponses([respond]);
        const first = context.messages.find((message) => message.role === "user");
        const text = first === undefined ? "" : textOf(first.content);
        const key = Object.keys(scripts).find((candidate) => text.includes(candidate));
        if (key === undefined) return fauxAssistantMessage("done");
        for (const m of context.messages)
            if (m.role === "toolResult") toolResults.push({ text: textOf(m.content), isError: m.isError });
        const step = (scripts[key] as Step[])[context.messages.filter((m) => m.role === "assistant").length];
        if (step === undefined) return fauxAssistantMessage("finished");
        if ("hold" in step) {
            // An abort ends the held request, as it ends a real one.
            const isAborted = new Promise((resolve) => streamOptions?.signal?.addEventListener("abort", resolve));
            await Promise.race([step.hold, isAborted]);
            return fauxAssistantMessage("done");
        }
        return fauxAssistantMessage(
            step.calls.map((c) => fauxToolCall(c.name, c.arguments as never)),
            { stopReason: "toolUse" },
        );
    };
    fake.setResponses([respond]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const log: string[] = [];
    const logger = createLogger({ stream: { write: (line) => log.push(String(line)) > 0 } });
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({
        agents,
        logger,
        ...(options.turnEndRule !== undefined && { turnEndRule: options.turnEndRule }),
    });
    const mail = await createMailComponent({ agents, jobs, logger });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        checkModels: async (ctx) => {
            captured = ctx;
        },
    };
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        sections: [...agents.sections, ...mail.sections],
        components: [agents.component, jobs.component, mail.component, probe],
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
    daemons.push(daemon);
    await until("intake to watch the inbox", () => (log.join("").includes("mail intake watching") ? true : undefined));
    const ctx = captured as ServiceContext;
    const invoke = (op: string, input: unknown, as: Caller = webCaller) => daemon.catalogue.invoke(op, input, as);
    const jobList = async () => ((await invoke("jobs.list", {})) as { jobs: JobView[] }).jobs;
    return {
        server,
        ctx,
        toolResults,
        jobList,
        invoke,
        job: async (id: string) => (await invoke("jobs.get", { job: id })) as JobView,
        statusEntries: async (id: string) =>
            (await ctx.jobStore.listHistory(id, { limit: 100 })).entries.filter((entry) => entry.field === "status"),
        outboxRows: (id: string) => ctx.jobStore.readMail((tx) => tx.outboxRowsOfJob(id, ["owed", "sending", "sent"])),
        steers: async (id: string) => {
            const { leadConversation } = (await invoke("jobs.get", { job: id })) as JobView;
            const read = (await invoke("conversations.entries", { conversationId: leadConversation, limit: 500 })) as {
                entries: Steer[];
            };
            return read.entries.filter((entry) => entry.kind === "intern.steer");
        },
    };
}

type World = Awaited<ReturnType<typeof start>>;

const rawMail = (from: string, to: string, subject: string, text: string, headers: string[] = []): string =>
    `From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replaceAll(" ", "-")}-${text.length}@example.test>\r\n` +
    `${headers.map((header) => `${header}\r\n`).join("")}\r\n${text}\r\n`;

const untilBlockedTimes = (world: World, jobId: string, count: number) =>
    until(`${count} block(s) of the job`, async () =>
        (await world.statusEntries(jobId)).filter((entry) => entry.new === "blocked").length >= count
            ? true
            : undefined,
    );

/** The email the daemon sent first, parsed, once the server holds it. */
async function sentQuestion(world: World) {
    const [mail] = await until("the question to be sent", () =>
        world.server.received().length > 0 ? world.server.received() : undefined,
    );
    return { envelope: mail?.envelope, parsed: await parseMessage(mail?.raw as Buffer) };
}

type Sent = Awaited<ReturnType<typeof sentQuestion>>;

/** Delivers a reply to the sent question, from `from`, with the extra headers. */
const reply = (world: World, question: Sent, from: string, text: string, extra: string[] = []) =>
    world.server.deliver(
        OWNED,
        rawMail(from, OWNED, `Re: ${question.parsed.subject}`, text, [
            `In-Reply-To: ${question.parsed.messageId}`,
            ...extra,
        ]),
    );

const untilResumed = (world: World, jobId: string) =>
    until("the job to resume", async () => ((await world.job(jobId)).status === "in_progress" ? true : undefined));

const emailJob = async (world: World, subject: string) => {
    world.server.deliver(OWNED, rawMail(ANA, OWNED, subject, "please look"));
    const [job] = await until("the email's job", async () => {
        const jobs = await world.jobList();
        return jobs.length > 0 ? jobs : undefined;
    });
    return job as JobView;
};

describe("questions by email", () => {
    it("resumes a Blocked job on the reply to its mailed question, and takes the next reply as input (AC-1)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const { promise: hold, resolve: release } = Promise.withResolvers<void>();
        const world = await start({
            "E5 question": [block({ reason: "needs a server", mailText: QUESTION }), { hold }],
        });
        const created = await emailJob(world, "E5 question");
        await untilBlockedTimes(world, created.id, 1);
        const question = await sentQuestion(world);

        reply(world, question, ANA, "the staging one");
        await untilResumed(world, created.id);
        reply(world, question, ANA, "and the staging db too");

        await until("the second reply to be recorded", async () => {
            const { entries } = await world.ctx.jobStore.listHistory(created.id, { limit: 100 });
            const received = entries.filter(
                (e) => e.field === "mail" && (e.new as { mail: string }).mail === "received",
            );
            return received.length === 3 ? true : undefined;
        });
        release();
        const steers = await until("both replies as input", async () => {
            const found = await world.steers(created.id);
            return found.length === 2 ? found : undefined;
        });
        assert.deepEqual(
            steers.map((steer) => steer.data.actor),
            [
                { kind: "team_member", wayIn: "email" },
                { kind: "team_member", wayIn: "email" },
            ],
        );
        assert.match(steers[0]?.data.content ?? "", /From: ana@example\.com[\s\S]*the staging one/);
        assert.match(steers[1]?.data.content ?? "", /From: ana@example\.com[\s\S]*and the staging db too/);
        assert.equal((await world.jobList()).length, 1);
        assert.deepEqual(
            (await world.statusEntries(created.id)).filter((e) => e.old === "blocked").map((e) => e.new),
            ["in_progress"],
        );
    });

    it("mails a command-line job's question to the notice address, and its reply resumes the job (AC-2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const world = await start(
            { "C7 question": [block({ reason: "needs a server", mailText: QUESTION })] },
            { notice: "intern" },
        );
        const created = (await world.invoke("jobs.create", { text: "C7 question" }, commandLineCaller)) as JobView;
        await untilBlockedTimes(world, created.id, 1);

        const question = await sentQuestion(world);
        assert.deepEqual(question.envelope?.to, [OPS]);
        assert.equal(question.parsed.from, OWNED);
        assert.equal(question.parsed.text.trim(), QUESTION);
        reply(world, question, OPS, "use staging");

        await untilResumed(world, created.id);
        const [steer] = await world.steers(created.id);
        assert.deepEqual(steer?.data.actor, { kind: "team_member", wayIn: "email" });
        assert.match(steer?.data.content ?? "", /From: ops@example\.com[\s\S]*use staging/);
    });

    it("sends no further email for a repeated question or a block by the reminder rule (AC-3)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const block_ = block({ reason: "needs a server", mailText: QUESTION });
        const world = await start({ "E3 question": [block_, block_] });
        const created = await emailJob(world, "E3 question");
        await untilBlockedTimes(world, created.id, 1);
        const question = await sentQuestion(world);

        reply(world, question, ANA, "away", ["Auto-Submitted: auto-replied"]);
        await untilBlockedTimes(world, created.id, 2);
        reply(world, question, ANA, "still away");
        await untilBlockedTimes(world, created.id, 3);

        const blocks = (await world.statusEntries(created.id)).filter((entry) => entry.new === "blocked");
        assert.deepEqual(
            blocks.map((entry) => entry.author.kind),
            ["agent", "agent", "daemon"],
        );
        assert.equal((await world.outboxRows(created.id)).length, 1);
        assert.equal(world.server.received().length, 1);
        assert.equal((await world.jobList()).length, 1);
    });

    it("refuses a block without a mail text where the question will be mailed, the job staying In progress (AC-4)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const world = await start({ "E4 question": [block({ reason: "needs a server" })] }, { turnEndRule: false });
        const created = await emailJob(world, "E4 question");

        await until("the refusal", () => (world.toolResults.length > 0 ? true : undefined));
        const [result] = world.toolResults;
        assert.equal(result?.isError, true);
        assert.match(result?.text ?? "", /mail text/i);
        assert.equal((await world.job(created.id)).status, "in_progress");
        assert.deepEqual(
            (await world.statusEntries(created.id)).filter((entry) => entry.new === "blocked"),
            [],
        );
        assert.deepEqual(await world.outboxRows(created.id), []);
        assert.deepEqual(world.server.received(), []);
    });
});
