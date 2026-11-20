/**
 * The mail tools that read (S-009 REQ-011, REQ-010: AC-011.1): `mail_list_folders`, `mail_search`, `mail_read` and
 * `mail_save_attachments`, on the fake model against the fake mail server, for an owned and a monitored account.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
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
import { type ImapConnection, ImapFailure } from "../../src/mail/imap_client.ts";
import { createMailComponent } from "../../src/mail/mail_component.ts";
import { composeMessage } from "../../src/mail/mime.ts";
import { createToolConnections, MailToolRefusal } from "../../src/mail/tool_connection.ts";
import { MAIL_TOOL_NAMES } from "../../src/roles/role_model.ts";
import type { Caller } from "../../src/service/operations.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
/** How long `openImap`'s client lets its socket sit quiet (its `socketTimeout`). */
const IMAP_SOCKET_TIMEOUT_MS = 30_000;
const SCRIPT_INPUT = "script";
const WORK = { name: "work", address: "bob@example.test" };
const WATCH = { name: "watch", address: "inbox@example.test" };
const PASSWORD = "s3cret";
const READ_TOOLS = ["mail_list_folders", "mail_search", "mail_read", "mail_save_attachments"];
const quietLogger = createLogger({ stream: { write: () => true } });
const cliCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
const BINARY = Buffer.from([0, 1, 2, 254, 255, 10, 13, 0, 128]);

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

type Call = { name: string; arguments: Record<string, unknown> };
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
) =>
    `[[mail_account]]
name = "${account.name}"
kind = "${kind}"
address = "${account.address}"
imap_host = "127.0.0.1"
imap_port = ${server.imapPort}
imap_security = "none"
${kind === "owned" ? `smtp_host = "127.0.0.1"\nsmtp_port = ${server.smtpPort}\nsmtp_security = "none"\n` : ""}auth = "password_command"
password_command = ["${process.execPath}", "-e", "process.stdout.write('${password}')"]
`;

async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const workServer = await mailServer(WORK.address);
    const watchServer = await mailServer(WATCH.address);
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
        return fauxAssistantMessage([fauxToolCall(next.name, next.arguments as never)], { stopReason: "toolUse" });
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
            '[roles.reader]\ninstructions = "Read the mail."\ntools = ["read", "mail"]\n',
            accountToml(WORK, "owned", workServer, PASSWORD),
            accountToml({ name: "broken", address: WORK.address }, "owned", workServer, "wrong"),
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
    await until("broken to fail", async () => (await statusOf("broken")) === "failing");
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
        mail,
        daemon,
        invoke,
        async seat(role: string): Promise<{ conversationId: string; workspace: string }> {
            assert.ok(!seatedKeys.has(role), "seat a role once");
            seatedKeys.add(role);
            const seat = agents.runtime().catalog.seatFor(role);
            const { conversationId } = await createSeatedConversation(ctx.host, {
                scope: "mail-tools-read-test",
                key: role,
                job: { jobId: job.id, isLead: false, origin: { kind: "request", wayIn: "command line" }, depth: 1 },
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

async function deliverMessage(
    server: FakeMailServer,
    to: string,
    input: { subject: string; text: string; attachments?: { filename: string; content: Uint8Array }[] },
): Promise<void> {
    const { raw } = await composeMessage({
        from: "ann@example.test",
        to: [to],
        subject: input.subject,
        text: input.text,
        attachments: (input.attachments ?? []).map((attachment) => ({
            ...attachment,
            contentType: "application/octet-stream",
        })),
    });
    server.deliver(to, raw);
}

const jsonOf = (result: Seen | undefined) => JSON.parse(result?.text ?? "null");

type Found = { messages: { folder: string; uidValidity: number; uid: number; subject: string }[] };
type ReadBack = {
    headers: { from: string; to: string[]; subject: string };
    text: string;
    attachments: { filename: string; contentType: string; size: number }[];
};

describe("the mail tools that read", { timeout: TEST_TIMEOUT_MS }, () => {
    it("offers the mail tools to the reader agent and to no other (AC-1)", async () => {
        const started = await start();
        const reader = await started.seat("reader");
        const gp = await started.seat("gp");

        const toReader = await started.offeredTo(reader.conversationId);
        const toGp = await started.offeredTo(gp.conversationId);
        const toDesk = await started.offeredTo(await started.deskId());

        for (const name of READ_TOOLS) assert.ok(toReader.includes(name), `the reader is offered ${name}`);
        assert.deepEqual(
            [toGp, toDesk].map((tools) =>
                tools.filter((name) => (MAIL_TOOL_NAMES as readonly string[]).includes(name)),
            ),
            [[], []],
        );
    });

    describe("on an owned account", () => {
        async function readerWithMail(): Promise<{ started: Started; conversationId: string; workspace: string }> {
            const started = await start();
            await deliverMessage(started.workServer, WORK.address, {
                subject: "first",
                text: "older body",
            });
            await deliverMessage(started.workServer, WORK.address, {
                subject: "second",
                text: "newer body",
                attachments: [
                    { filename: "data.bin", content: BINARY },
                    { filename: "note.txt", content: Buffer.from("hello") },
                ],
            });
            const reader = await started.seat("reader");
            return { started, ...reader };
        }

        it("lists the folders, searches newest first and reads headers, text and attachments (AC-2)", async () => {
            const { started, conversationId } = await readerWithMail();

            const [folders, found] = await started.run(conversationId, [
                { name: "mail_list_folders", arguments: { account: WORK.name } },
                { name: "mail_search", arguments: { account: WORK.name, folder: "INBOX" } },
            ]);
            const [read] = await started.run(conversationId, [
                {
                    name: "mail_read",
                    arguments: {
                        account: WORK.name,
                        folder: "INBOX",
                        uidValidity: (jsonOf(found) as Found).messages[0]?.uidValidity,
                        uid: (jsonOf(found) as Found).messages[0]?.uid,
                    },
                },
            ]);

            assert.equal(folders?.isError, false, folders?.text);
            assert.deepEqual(
                (jsonOf(folders) as { folders: { path: string }[] }).folders.map((folder) => folder.path).sort(),
                ["Drafts", "INBOX", "Sent", "Trash"],
            );
            assert.deepEqual(
                (jsonOf(found) as Found).messages.map((message) => message.subject),
                ["second", "first"],
            );
            const message = jsonOf(read) as ReadBack;
            assert.equal(message.headers.subject, "second");
            assert.equal(message.headers.from, "ann@example.test");
            assert.deepEqual(message.headers.to, [WORK.address]);
            assert.equal(message.text.trim(), "newer body");
            assert.deepEqual(
                message.attachments.map((attachment) => [attachment.filename, attachment.size]),
                [
                    ["data.bin", BINARY.length],
                    ["note.txt", 5],
                ],
            );
        });

        it("returns an error result for an unknown account, one that isn't ready and a missing folder (AC-3)", async () => {
            const { started, conversationId } = await readerWithMail();

            const results = await started.run(conversationId, [
                { name: "mail_list_folders", arguments: { account: "nobody" } },
                { name: "mail_list_folders", arguments: { account: "broken" } },
                { name: "mail_search", arguments: { account: WORK.name, folder: "Nowhere" } },
                { name: "mail_read", arguments: { account: WORK.name, folder: "Nowhere", uidValidity: 1, uid: 1 } },
            ]);

            assert.deepEqual(
                results.map((result) => result.isError),
                [true, true, true, true],
            );
            assert.match(results[0]?.text ?? "", /nobody/);
            assert.match(results[1]?.text ?? "", /broken.*failing/);
            assert.match(results[2]?.text ?? "", /Nowhere/);
            assert.match(results[3]?.text ?? "", /Nowhere/);
        });

        async function saveCall(started: Started, conversationId: string, directory: string) {
            const [found] = await started.run(conversationId, [
                { name: "mail_search", arguments: { account: WORK.name, subject: "second" } },
            ]);
            const target = (jsonOf(found) as Found).messages[0];
            return {
                name: "mail_save_attachments",
                arguments: {
                    account: WORK.name,
                    folder: "INBOX",
                    uidValidity: target?.uidValidity,
                    uid: target?.uid,
                    directory,
                },
            };
        }

        it("writes each attachment byte for byte into a folder of the workspace (AC-4)", async () => {
            const { started, conversationId, workspace } = await readerWithMail();
            await mkdir(join(workspace, "saved"), { recursive: true });

            const [saved] = await started.run(conversationId, [await saveCall(started, conversationId, "saved")]);

            assert.equal(saved?.isError, false, saved?.text);
            assert.deepEqual(await readFile(join(workspace, "saved", "data.bin")), BINARY);
            assert.equal(await readFile(join(workspace, "saved", "note.txt"), "utf8"), "hello");
        });

        it("refuses a file that exists, leaves it unchanged and writes nothing else of the message (AC-4)", async () => {
            const { started, conversationId, workspace } = await readerWithMail();
            await mkdir(join(workspace, "saved"), { recursive: true });
            await writeFile(join(workspace, "saved", "data.bin"), "mine");

            const [refused] = await started.run(conversationId, [await saveCall(started, conversationId, "saved")]);

            assert.equal(refused?.isError, true);
            assert.match(refused?.text ?? "", /data\.bin/);
            assert.equal(await readFile(join(workspace, "saved", "data.bin"), "utf8"), "mine");
            assert.deepEqual(await readdir(join(workspace, "saved")), ["data.bin"]);
        });

        it("refuses a repeated call because its files exist (AC-4)", async () => {
            const { started, conversationId, workspace } = await readerWithMail();
            await mkdir(join(workspace, "saved"), { recursive: true });
            const call = await saveCall(started, conversationId, "saved");

            const [first, repeated] = await started.run(conversationId, [call, call]);

            assert.equal(first?.isError, false, first?.text);
            assert.equal(repeated?.isError, true);
            assert.deepEqual(await readFile(join(workspace, "saved", "data.bin")), BINARY);
        });

        it("refuses two attachments of one name and writes none of the message (AC-4)", async () => {
            const started = await start();
            await deliverMessage(started.workServer, WORK.address, {
                subject: "twins",
                text: "two files, one name",
                attachments: [
                    { filename: "same.txt", content: Buffer.from("one") },
                    { filename: "same.txt", content: Buffer.from("two") },
                ],
            });
            const { conversationId, workspace } = await started.seat("reader");
            await mkdir(join(workspace, "saved"), { recursive: true });
            const [found] = await started.run(conversationId, [
                { name: "mail_search", arguments: { account: WORK.name } },
            ]);
            const target = (jsonOf(found) as Found).messages[0];

            const [refused] = await started.run(conversationId, [
                {
                    name: "mail_save_attachments",
                    arguments: {
                        account: WORK.name,
                        folder: "INBOX",
                        uidValidity: target?.uidValidity,
                        uid: target?.uid,
                        directory: "saved",
                    },
                },
            ]);

            assert.equal(refused?.isError, true);
            assert.match(refused?.text ?? "", /same\.txt/);
            assert.deepEqual(await readdir(join(workspace, "saved")), []);
        });

        it("closes the account's tools connection when the account stops, and every connection when the daemon stops", async () => {
            const { started, conversationId } = await readerWithMail();
            await started.run(conversationId, [{ name: "mail_list_folders", arguments: { account: WORK.name } }]);
            await until(
                "the tools connection to be the only one open",
                () => started.workServer.openConnections() === 1,
            );

            started.mail.control.stopAccount(WORK.name);
            await until("the stopped account's connection to close", () => started.workServer.openConnections() === 0);
            await started.run(conversationId, [{ name: "mail_list_folders", arguments: { account: WATCH.name } }]);
            await until("the watch connection to be open", () => started.watchServer.openConnections() === 1);
            await started.daemon.stop();

            await until("the daemon's connections to close", () => started.watchServer.openConnections() === 0);
        });

        it("refuses a folder that doesn't exist and doesn't create it (AC-4)", async () => {
            const { started, conversationId, workspace } = await readerWithMail();

            const [refused] = await started.run(conversationId, [await saveCall(started, conversationId, "missing")]);

            assert.equal(refused?.isError, true);
            assert.match(refused?.text ?? "", /missing/);
            assert.equal(existsSync(join(workspace, "missing")), false);
        });
    });

    it("answers the same tools on a monitored account as on an owned one (AC-5)", async () => {
        const started = await start();
        await deliverMessage(started.watchServer, WATCH.address, {
            subject: "watched",
            text: "seen from outside",
            attachments: [{ filename: "data.bin", content: BINARY }],
        });
        const reader = await started.seat("reader");
        await mkdir(join(reader.workspace, "saved"), { recursive: true });

        const [folders, found] = await started.run(reader.conversationId, [
            { name: "mail_list_folders", arguments: { account: WATCH.name } },
            { name: "mail_search", arguments: { account: WATCH.name } },
        ]);
        const target = (jsonOf(found) as Found).messages[0];
        const location = { account: WATCH.name, folder: "INBOX", uidValidity: target?.uidValidity, uid: target?.uid };
        const [read, saved] = await started.run(reader.conversationId, [
            { name: "mail_read", arguments: location },
            { name: "mail_save_attachments", arguments: { ...location, directory: "saved" } },
        ]);

        assert.equal(folders?.isError, false, folders?.text);
        assert.equal((jsonOf(read) as ReadBack).text.trim(), "seen from outside");
        assert.equal(saved?.isError, false, saved?.text);
        assert.deepEqual(await readFile(join(reader.workspace, "saved", "data.bin")), BINARY);
    });
});

describe("the mail tools' connections", () => {
    const account = { name: "work", imapHost: "h", imapPort: 1, imapSecurity: "none", checkIntervalSeconds: 60 };

    function connections(idleMs: number) {
        const state = { opened: 0, loggedOut: 0, running: 0, mostRunning: 0, closed: new Set<ImapConnection>() };
        const tools = createToolConnections({
            account: () => account as never,
            status: () => "ready",
            credential: async () => ({ user: "u", password: "p" }),
            idleMs,
            open: async () => {
                state.opened += 1;
                const connection = {
                    logout: async () => {
                        state.loggedOut += 1;
                        state.closed.add(connection);
                    },
                } as unknown as ImapConnection;
                return connection;
            },
        });
        const call = () =>
            tools.use("work", async () => {
                state.running += 1;
                state.mostRunning = Math.max(state.mostRunning, state.running);
                await sleep(POLL_MS);
                state.running -= 1;
            });
        return { state, tools, call };
    }

    it("opens one connection at the first call and keeps it for the next", async () => {
        const { state, call, tools } = connections(scaled(60_000));

        await call();
        await call();

        assert.equal(state.opened, 1);
        await tools.closeAll();
        assert.equal(state.loggedOut, 1);
    });

    it("closes the connection after the idle time and opens another for the next call", async () => {
        const { state, call, tools } = connections(1);

        await call();
        await until("the idle connection to close", () => state.loggedOut === 1);
        await call();

        assert.equal(state.opened, 2);
        await tools.closeAll();
    });

    it("keeps the connection when a call is refused for a reason of its own", async () => {
        const { state, tools } = connections(scaled(60_000));

        await assert.rejects(
            tools.use("work", async () => {
                throw new MailToolRefusal("no such folder");
            }),
            /no such folder/,
        );
        await tools.use("work", async () => undefined);

        assert.deepEqual([state.opened, state.loggedOut], [1, 0]);
        await tools.closeAll();
    });

    it("runs a call queued behind a lost connection on a new one", async () => {
        const { state, tools } = connections(scaled(60_000));
        const lost = tools.use("work", async () => {
            throw new ImapFailure("unreachable", "the connection was lost");
        });
        const queued = tools.use("work", async (imap) => (state.closed.has(imap) ? "closed" : "open"));

        await assert.rejects(lost, /lost/);

        assert.equal(await queued, "open");
        assert.equal(state.opened, 2);
        await tools.closeAll();
    });

    it("runs the calls of one account one after another", async () => {
        const { state, call, tools } = connections(scaled(60_000));

        await Promise.all([call(), call(), call()]);

        assert.equal(state.mostRunning, 1);
        await tools.closeAll();
    });

    it("keeps a connection that only listed folders open past the client's quiet-socket timeout", {
        timeout: scaled(60_000),
    }, async () => {
        const server = await mailServer(WORK.address);
        const tools = createToolConnections({
            account: () =>
                ({ ...account, imapHost: "127.0.0.1", imapPort: server.imapPort, checkIntervalSeconds: 60 }) as never,
            status: () => "ready",
            credential: async () => ({ user: WORK.address, password: PASSWORD }),
        });
        await tools.use("work", (imap) => imap.listFolders());

        // Not a wait for a state: the claim is that nothing ends the connection while it is quiet. The client's
        // socket timer (30 s, `imap_client.ts`) was armed by the call's last reply, before this timer, and Node
        // fires timers in the order they fall due, so the socket timeout has run by the time this one ends.
        await sleep(IMAP_SOCKET_TIMEOUT_MS + 5_000);
        const folders = await tools.use("work", (imap) => imap.listFolders());

        assert.equal(folders.length, 4);
        assert.equal(server.openConnections(), 1);
        await tools.closeAll();
    });
});
