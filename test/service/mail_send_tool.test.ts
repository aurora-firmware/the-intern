/**
 * The send tool (S-009 REQ-010, REQ-011, REQ-012, REQ-022: AC-010.1, AC-012.1): `mail_send` on the fake model against
 * the fake mail server, with the allowlist, the notice, the Sent folder copy and the owed row of a server that is
 * away. The owned account reaches the fake server's SMTP side through a proxy a test can close.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
    type Message,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { createSeatedConversation } from "../../src/host/seating.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createMailComponent } from "../../src/mail/mail_component.ts";
import { sendTool } from "../../src/mail/mail_send_tool.ts";
import { composeMessage, parseMessage } from "../../src/mail/mime.ts";
import { skipsSentCopy } from "../../src/mail/outbox.ts";
import type { Caller } from "../../src/service/operations.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const SCRIPT_INPUT = "script";
const WORK = { name: "work", address: "bob@example.test" };
const WATCH = { name: "watch", address: "inbox@example.test" };
const PASSWORD = "s3cret";
const NOTICE_TO = "team@example.test";
const quietLogger = createLogger({ stream: { write: () => true } });
const cliCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];
const servers: FakeMailServer[] = [];
const proxies: SmtpProxy[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const proxy of proxies.splice(0)) await proxy.stop();
    for (const server of servers.splice(0)) await server.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

type Call = { name: string; arguments: Record<string, unknown>; id?: string };
type Seen = { text: string; isError: boolean };
type OfferedTool = { name: string };

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

// pi-durable sends the tools as changes on system messages; the tools in effect are the fold of them.
function toolsOf(messages: Message[]): string[] {
    const inEffect = new Map<string, OfferedTool>();
    for (const message of messages) {
        if (message.role !== "system") continue;
        for (const tool of message.toolsAdded ?? []) inEffect.set(tool.name, tool);
        for (const tool of message.toolsRemoved ?? []) inEffect.delete(tool.name);
    }
    return [...inEffect.keys()];
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(what: string, condition: () => Promise<boolean> | boolean): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_MS);
    }
}

type SmtpProxy = { port: number; setUp(isUp: boolean): void; stop(): Promise<void> };

// A port that passes connections to the fake server's SMTP side while it is up and drops them at once while it is down.
async function smtpProxy(target: number): Promise<SmtpProxy> {
    let isUp = true;
    const sockets = new Set<Socket>();
    const server: Server = createServer((client) => {
        sockets.add(client);
        client.once("close", () => sockets.delete(client));
        if (!isUp) {
            client.destroy();
            return;
        }
        const upstream = createConnection({ host: "127.0.0.1", port: target });
        sockets.add(upstream);
        upstream.once("close", () => sockets.delete(upstream));
        client.on("error", () => upstream.destroy());
        upstream.on("error", () => client.destroy());
        client.pipe(upstream);
        upstream.pipe(client);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    return {
        port: (server.address() as { port: number }).port,
        setUp: (value) => {
            isUp = value;
        },
        async stop() {
            for (const socket of sockets) socket.destroy();
            await new Promise((resolve) => server.close(resolve));
        },
    };
}

async function mailServer(address: string): Promise<FakeMailServer> {
    const server = await startFakeMailServer();
    server.addAccount({ address, login: address, password: PASSWORD });
    servers.push(server);
    return server;
}

const accountToml = (
    account: { name: string; address: string },
    kind: string,
    server: FakeMailServer,
    password: string,
    extra: { smtpPort?: number; allow?: string[] } = {},
) =>
    `[[mail_account]]
name = "${account.name}"
kind = "${kind}"
address = "${account.address}"
imap_host = "127.0.0.1"
imap_port = ${server.imapPort}
imap_security = "none"
${kind === "owned" ? `smtp_host = "127.0.0.1"\nsmtp_port = ${extra.smtpPort ?? server.smtpPort}\nsmtp_security = "none"\n` : ""}auth = "password_command"
password_command = ["${process.execPath}", "-e", "process.stdout.write('${password}')"]
${extra.allow === undefined ? "" : `allow = ${JSON.stringify(extra.allow)}\n`}`;

async function start(options: { allow?: string[]; notice?: boolean } = {}) {
    const env = await createHermeticEnv();
    envs.push(env);
    const workServer = await mailServer(WORK.address);
    const watchServer = await mailServer(WATCH.address);
    const proxy = await smtpProxy(workServer.smtpPort);
    proxies.push(proxy);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    let script: Call[] = [];
    let step = 0;
    let results: Seen[] = [];
    let offered: string[] = [];
    const respond: FauxResponseFactory = async (context) => {
        fake.appendResponses([respond]);
        const isScripted = context.messages.some(
            (message) => message.role === "user" && textOf(message.content) === SCRIPT_INPUT,
        );
        if (!isScripted) return fauxAssistantMessage("done");
        offered = toolsOf(context.messages);
        const seen = context.messages.flatMap((message) =>
            message.role === "toolResult" ? [{ text: textOf(message.content), isError: message.isError }] : [],
        );
        results = seen.slice(seen.length - step);
        const next = script[step];
        step += 1;
        if (next === undefined) return fauxAssistantMessage("finished");
        return fauxAssistantMessage(
            [fauxToolCall(next.name, next.arguments as never, next.id === undefined ? undefined : { id: next.id })],
            { stopReason: "toolUse" },
        );
    };
    fake.setResponses([respond]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    await writeFile(
        join(env.configDir, "config.toml"),
        [
            options.notice ? `[mail]\nnotice_to = "${NOTICE_TO}"\nnotice_from = "${WORK.name}"\n` : "",
            '[roles.sorter]\ninstructions = "Sort the mail."\ntools = ["read", "mail"]\n',
            accountToml(WORK, "owned", workServer, PASSWORD, {
                smtpPort: proxy.port,
                ...(options.allow && { allow: options.allow }),
            }),
            accountToml(WATCH, "monitored", watchServer, PASSWORD),
        ].join("\n"),
    );
    const agents = await createAgentsComponent({ logger: quietLogger });
    const jobs = await createJobsComponent({ agents, logger: quietLogger, turnEndRule: false });
    const desk = await createDeskComponent({ agents, jobs, logger: quietLogger });
    const mail = await createMailComponent({ agents, jobs, logger: quietLogger });
    let captured: ServiceContext | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger: quietLogger,
        workerThreadCount: 1,
        sections: [...agents.sections, ...mail.sections],
        components: [
            agents.component,
            jobs.component,
            desk.component,
            mail.component,
            {
                name: "probe",
                start: async (ctx) => {
                    captured = ctx;
                },
            },
        ],
        operations: [...agents.operations, ...jobs.operations, ...desk.operations, ...mail.operations],
        accountStatus: mail.accountStatus,
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            assert.ok(implementation, "the fake model's api is registered");
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
    await until("the daemon to be ready", () => daemon.phase() === "ready");
    const ctx = captured as ServiceContext;
    const invoke = (name: string, input: unknown) => daemon.catalogue.invoke(name, input, cliCaller);
    const statusOf = async (name: string) =>
        ((await invoke("daemon.status", {})) as { mailAccounts: { name: string; status: string }[] }).mailAccounts.find(
            (account) => account.name === name,
        )?.status;
    for (const name of [WORK.name, WATCH.name])
        await until(`${name} to be ready`, async () => (await statusOf(name)) === "ready");
    const job = (await invoke("jobs.create", { text: "probe" })) as { id: string };
    let turn = 0;
    const seatedKeys = new Set<string>();
    async function run(conversationId: string, calls: Call[]): Promise<Seen[]> {
        script = calls;
        step = 0;
        turn += 1;
        const submission = await submitInput(ctx.host, conversationId, {
            content: SCRIPT_INPUT,
            requestId: `script-${turn}`,
            busyMode: "reject",
        });
        const outcome = await waitForSubmission(ctx.host, submission.submissionId, WAIT_MS);
        assert.equal(outcome.state, "done");
        return results;
    }
    return {
        workServer,
        watchServer,
        proxy,
        ctx,
        job,
        mail,
        daemon,
        invoke,
        async seat(role: string, isLead = false): Promise<{ conversationId: string; workspace: string }> {
            assert.ok(!seatedKeys.has(role), "seat a role once");
            seatedKeys.add(role);
            const seat = agents.runtime().catalog.seatFor(role);
            const { conversationId } = await createSeatedConversation(ctx.host, {
                scope: "mail-send-tool-test",
                key: role,
                job: {
                    jobId: job.id,
                    isLead,
                    origin: { kind: "schedule", entry: "sorting", fireTime: "2026-03-02T08:00:00Z" },
                    depth: 1,
                },
                seat,
                actor: { kind: "team_member", wayIn: "command line" },
            });
            return { conversationId, workspace: seat.workspace };
        },
        deskId: async () => ((await invoke("desk.get", {})) as { conversationId: string }).conversationId,
        run,
        offeredTo: async (conversationId: string) => {
            await run(conversationId, []);
            return offered;
        },
    };
}

type Started = Awaited<ReturnType<typeof start>>;

const subjectsIn = async (server: FakeMailServer, address: string, folder: string) =>
    (await Promise.all(server.mailbox(address, folder).map((message) => parseMessage(message.raw)))).map(
        (message) => message.subject,
    );

const sendCall = (extra: Record<string, unknown> = {}, id?: string): Call => ({
    name: "mail_send",
    ...(id !== undefined && { id }),
    arguments: { account: WORK.name, to: ["ana@example.test"], subject: "Hello", text: "Here it is.", ...extra },
});

const mailHistory = async (started: Started) => {
    const { entries } = await started.ctx.jobStore.listHistory(started.job.id, {});
    return entries.filter((entry) => entry.field === "mail");
};

describe("the send tool", { timeout: TEST_TIMEOUT_MS }, () => {
    it("refuses a send on a monitored account and sends nothing (AC-1)", async () => {
        const started = await start();
        const { conversationId } = await started.seat("sorter", true);

        const [refused] = await started.run(conversationId, [sendCall({ account: WATCH.name }, "call-1")]);

        assert.equal(refused?.isError, true);
        assert.match(refused?.text ?? "", /monitored/);
        assert.deepEqual(started.watchServer.received(), []);
        assert.deepEqual(started.workServer.received(), []);
    });

    it("sends nothing to an address the allowlist holds back, tells the agent and sends one notice (AC-2)", async () => {
        const started = await start({ allow: ["@example.com"], notice: true });
        const { conversationId } = await started.seat("sorter");

        const [held] = await started.run(conversationId, [
            sendCall({ to: ["ana@example.com", "bo@other.org"] }, "call-1"),
        ]);

        assert.equal(held?.isError, true);
        assert.match(held?.text ?? "", /bo@other\.org/);
        await until("the notice to be sent", () => started.workServer.received().length >= 1);
        const [notice] = started.workServer.received();
        assert.deepEqual(notice?.envelope.to, [NOTICE_TO]);
        const [entry] = (await mailHistory(started)).map((item) => item.new);
        assert.deepEqual(entry, {
            mail: "held_back",
            from: WORK.address,
            to: ["ana@example.com", "bo@other.org"],
            subject: "Hello",
            notAllowed: ["bo@other.org"],
        });
        assert.equal(started.workServer.received().length, 1);
    });

    it("sends once, joins the thread, records the agent as author and copies it to Sent (AC-3)", async () => {
        const started = await start();
        const { conversationId } = await started.seat("sorter");

        const [sent] = await started.run(conversationId, [sendCall({}, "call-1")]);

        assert.equal(sent?.isError, false, sent?.text);
        const [mail] = started.workServer.received();
        assert.equal(started.workServer.received().length, 1);
        assert.deepEqual(mail?.envelope.to, ["ana@example.test"]);
        const parsed = await parseMessage(mail?.raw as Buffer);
        assert.equal(parsed.from, WORK.address);
        assert.equal(parsed.text.trim(), "Here it is.");
        const [entry] = await mailHistory(started);
        assert.deepEqual(entry?.new, {
            mail: "sent",
            from: WORK.address,
            to: ["ana@example.test"],
            subject: "Hello",
        });
        assert.deepEqual(entry?.author, { kind: "agent", conversationId, role: "sorter" });
        const copies = started.workServer.mailbox(WORK.address, "Sent");
        assert.equal(copies.length, 1);
        assert.equal((await parseMessage(copies[0]?.raw as Buffer)).messageId, parsed.messageId);

        const { raw } = await composeMessage({
            from: "ana@example.test",
            to: [WORK.address],
            subject: "Re: Hello",
            text: "Thanks.",
            inReplyTo: parsed.messageId as string,
        });
        started.workServer.deliver(WORK.address, raw);
        await until("the reply to reach the job", async () =>
            (await mailHistory(started)).some((item) => (item.new as { mail: string }).mail === "received"),
        );
    });

    it("sends once and returns the first outcome when the tool call is repeated (AC-4)", async () => {
        const started = await start();
        const { conversationId } = await started.seat("sorter");

        const [first, repeated] = await started.run(conversationId, [sendCall({}, "call-1"), sendCall({}, "call-1")]);

        assert.equal(first?.isError, false, first?.text);
        assert.equal(repeated?.text, first?.text);
        assert.equal(started.workServer.received().length, 1);
        assert.deepEqual(await subjectsIn(started.workServer, WORK.address, "Sent"), ["Hello"]);
    });

    it("says the email waits for the server and sends it, with its copy, once the account is ready (AC-5)", async () => {
        const started = await start();
        const { conversationId } = await started.seat("sorter");
        started.proxy.setUp(false);

        const [waiting] = await started.run(conversationId, [sendCall({}, "call-1")]);

        assert.equal(waiting?.isError, false, waiting?.text);
        assert.match(waiting?.text ?? "", /waits for the server/);
        assert.deepEqual(started.workServer.received(), []);
        assert.equal((await started.ctx.jobStore.readMail((tx) => tx.rowsInState("owed"))).length, 1);

        started.proxy.setUp(true);
        await started.mail.control.restartAccount(WORK.name);

        await until("the email to be sent", () => started.workServer.received().length === 1);
        await until("the copy in Sent", () => started.workServer.mailbox(WORK.address, "Sent").length === 1);
        const [entry] = await mailHistory(started);
        assert.deepEqual(entry?.author, { kind: "agent", conversationId, role: "sorter" });
    });

    it("names the server's answer when it refuses the email for good (AC-5)", async () => {
        const started = await start();
        const { conversationId } = await started.seat("sorter");
        started.workServer.refuseRecipient("ana@example.test", "550 5.1.1 no such user");

        const [refused] = await started.run(conversationId, [sendCall({}, "call-1")]);

        assert.equal(refused?.isError, true);
        assert.match(refused?.text ?? "", /550 5\.1\.1 no such user/);
        assert.deepEqual(started.workServer.mailbox(WORK.address, "Sent"), []);
    });

    it("is refused, writing no row, while mail is not started yet", async () => {
        const tool = sendTool({
            connections: () => assert.fail("no connection is opened"),
            host: () => undefined,
            outbox: () => undefined,
        });

        const result = await tool.execute(
            sendCall().arguments as never,
            { conversationId: "c-1", callId: "call-1" } as never,
        );

        assert.equal(result.isError, true);
        assert.match(JSON.stringify(result.output), /not started/);
    });

    it("leaves the copy to Gmail and Outlook, whose servers file a submission themselves", () => {
        assert.equal(skipsSentCopy("imap.gmail.com"), true);
        assert.equal(skipsSentCopy("outlook.office365.com"), true);
        assert.equal(skipsSentCopy("imap.example.test"), false);
    });
});
