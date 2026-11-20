/**
 * The mail tools that sort and draft (S-009 REQ-011, REQ-010: AC-011.2, AC-010.2): `mail_move`, `mail_set_flags` and
 * `mail_save_draft`, on the fake model against the fake mail server, for an owned and a monitored account.
 */
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
import { composeMessage, parseMessage } from "../../src/mail/mime.ts";
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
const quietLogger = createLogger({ stream: { write: () => true } });
const cliCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

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
            '[roles.sorter]\ninstructions = "Sort the mail."\ntools = ["read", "mail"]\n',
            accountToml(WORK, "owned", workServer, PASSWORD),
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
        mail,
        daemon,
        invoke,
        async seat(role: string, isLead = false): Promise<{ conversationId: string; workspace: string }> {
            assert.ok(!seatedKeys.has(role), "seat a role once");
            seatedKeys.add(role);
            const seat = agents.runtime().catalog.seatFor(role);
            const { conversationId } = await createSeatedConversation(ctx.host, {
                scope: "mail-tools-sort-test",
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

const jsonOf = (result: Seen | undefined) => JSON.parse(result?.text ?? "null");

type Found = { messages: { folder: string; uidValidity: number; uid: number; subject: string }[] };

async function deliverMessage(server: FakeMailServer, to: string, input: { subject: string; text: string }) {
    const { raw } = await composeMessage({ from: "ann@example.test", to: [to], ...input });
    server.deliver(to, raw);
}

async function deliverAll(server: FakeMailServer, address: string, subjects: string[]): Promise<void> {
    for (const subject of subjects) await deliverMessage(server, address, { subject, text: `${subject} body` });
}

/** The folder's messages as `mail_search` names them, newest first. */
async function inFolder(started: Started, conversationId: string, account: string, folder = "INBOX") {
    const [found] = await started.run(conversationId, [{ name: "mail_search", arguments: { account, folder } }]);
    return (jsonOf(found) as Found).messages;
}

const subjectsIn = async (server: FakeMailServer, address: string, folder: string) =>
    (await Promise.all(server.mailbox(address, folder).map((message) => parseMessage(message.raw)))).map(
        (message) => message.subject,
    );

describe("the mail tools that sort and draft", { timeout: TEST_TIMEOUT_MS }, () => {
    it("moves a message to Trash without expunging it and refuses a folder that doesn't exist (AC-1)", async () => {
        const started = await start();
        await deliverAll(started.workServer, WORK.address, ["keep", "bin"]);
        const { conversationId } = await started.seat("sorter");
        const [bin] = (await inFolder(started, conversationId, WORK.name)).filter((m) => m.subject === "bin");

        const [moved, refused] = await started.run(conversationId, [
            {
                name: "mail_move",
                arguments: {
                    account: WORK.name,
                    folder: "INBOX",
                    uidValidity: bin?.uidValidity,
                    uids: [bin?.uid],
                    target: "Trash",
                },
            },
            {
                name: "mail_move",
                arguments: {
                    account: WORK.name,
                    folder: "INBOX",
                    uidValidity: bin?.uidValidity,
                    uids: [bin?.uid],
                    target: "Nowhere",
                },
            },
        ]);

        assert.equal(moved?.isError, false, moved?.text);
        assert.deepEqual(await subjectsIn(started.workServer, WORK.address, "Trash"), ["bin"]);
        assert.deepEqual(await subjectsIn(started.workServer, WORK.address, "INBOX"), ["keep"]);
        assert.ok(!started.workServer.mailbox(WORK.address, "Trash").some((m) => m.flags.includes("\\Deleted")));
        assert.equal(refused?.isError, true);
        assert.match(refused?.text ?? "", /Nowhere/);
        assert.deepEqual(await subjectsIn(started.workServer, WORK.address, "INBOX"), ["keep"]);
    });

    it("leaves the same end state when a move is repeated (AC-5)", async () => {
        const started = await start();
        await deliverAll(started.workServer, WORK.address, ["one", "two"]);
        const { conversationId } = await started.seat("sorter");
        const [two] = (await inFolder(started, conversationId, WORK.name)).filter((m) => m.subject === "two");
        const call = {
            name: "mail_move",
            arguments: {
                account: WORK.name,
                folder: "INBOX",
                uidValidity: two?.uidValidity,
                uids: [two?.uid],
                target: "Trash",
            },
        };

        await started.run(conversationId, [call]);
        await started.run(conversationId, [call]);

        assert.deepEqual(await subjectsIn(started.workServer, WORK.address, "Trash"), ["two"]);
        assert.deepEqual(await subjectsIn(started.workServer, WORK.address, "INBOX"), ["one"]);
    });

    describe("mail_set_flags", () => {
        async function flagged() {
            const started = await start();
            await deliverAll(started.workServer, WORK.address, ["one"]);
            const { conversationId } = await started.seat("sorter");
            const [target] = await inFolder(started, conversationId, WORK.name);
            const set = (changes: Record<string, unknown>) => ({
                name: "mail_set_flags",
                arguments: {
                    account: WORK.name,
                    folder: "INBOX",
                    uidValidity: target?.uidValidity,
                    uids: [target?.uid],
                    ...changes,
                },
            });
            const flagsNow = () => started.workServer.mailbox(WORK.address, "INBOX")[0]?.flags.toSorted();
            return { started, conversationId, set, flagsNow };
        }

        it("sets and clears seen, flagged and answered, and the same call again changes nothing more (AC-3, AC-5)", async () => {
            const { started, conversationId, set, flagsNow } = await flagged();

            await started.run(conversationId, [set({ seen: true, flagged: true, answered: true })]);
            assert.deepEqual(flagsNow(), ["\\Answered", "\\Flagged", "\\Seen"]);
            await started.run(conversationId, [set({ flagged: false }), set({ flagged: false })]);

            assert.deepEqual(flagsNow(), ["\\Answered", "\\Seen"]);
        });

        it("refuses a call that names none of the three flags and sets no other flag (AC-3)", async () => {
            const { started, conversationId, set, flagsNow } = await flagged();

            const [none, other] = await started.run(conversationId, [set({}), set({ deleted: true })]);

            assert.equal(none?.isError, true);
            assert.equal(other?.isError, true);
            assert.deepEqual(flagsNow(), []);
        });
    });
});
