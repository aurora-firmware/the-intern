/**
 * No internals in mail (S-009 REQ-016, AC-016.1): The Intern sends each kind of email it can send, from leads whose
 * Blocked reasons and justifications hold short numbers and saved-mail paths, and a scan reads every message the fake
 * mail server received or holds in Drafts and Sent. The leads follow scripts of the fake model, each chosen by a key in
 * the first message of its job.
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
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createMailComponent } from "../../src/mail/mail_component.ts";
import { MAIL_HEADERS } from "../../src/mail/mail_model.ts";
import { parseMessage } from "../../src/mail/mime.ts";
import type { Caller } from "../../src/service/operations.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(90_000);
const WAIT_MS = scaled(30_000);
const POLL_MS = 10;
const OWNED = "bob@example.test";
const PASSWORD = "pw";
const ANA = "ana@example.com";
const OPS = "ops@example.com";
const OUTSIDER = "bo@other.org";
const UNKNOWN = "nobody@example.com";
const SORTER = "sorter";
const SENDING_TOOLS = ["mail_send", "mail_save_draft"];
const LEAD_TOOLS = ["block_job", "complete_job", "mark_request", "update_job"];
const CLI_TITLE = "Fix the C-7 regression";
const SEND_TITLE = "Tidy the Q-9 drafts";
const commandLineCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

/** Written for the team, with short numbers and a saved-mail path, and never to be mailed. */
const EMAIL_QUESTION_REASON = "Waiting on E-7 after S-3 and C-7 failed; see /var/lib/intern/mail/m-5/message.eml";
const NOTICE_QUESTION_REASON = "C-7 needs the staging answer from E-7, see /var/lib/intern/mail/m-6/message.eml";
const JUSTIFICATION = "Done for E-8 per S-4, the saved mail /var/lib/intern/mail/m-8/message.eml agrees";
const MAIL_QUESTION = "Which server do you mean?";
const CLI_QUESTION = "Which environment should the fix go to?";
const RESULT_REPLY = "The change is made.";

type Call = { name: string; arguments: Record<string, unknown>; id?: string };
type JobView = { number: string; leadConversation: string };

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

const call = (name: string, arguments_: Record<string, unknown>, id?: string): Call => ({
    name,
    arguments: arguments_,
    ...(id !== undefined && { id }),
});
const send = (id: string, to: string[], subject: string, text: string) =>
    call("mail_send", { account: "work", to, subject, text }, id);

/** The steps of each lead, one for each of its model replies. */
const SCRIPTS: Record<string, Call[]> = {
    "A question": [call("block_job", { reason: EMAIL_QUESTION_REASON, mailText: MAIL_QUESTION }, "call-block-email")],
    "B result": [
        call("mark_request", { marked: true }, "call-mark"),
        call("update_job", { definitionOfDone: "The change is made" }, "call-define"),
        call("complete_job", { justification: JUSTIFICATION, mailText: RESULT_REPLY }, "call-complete"),
    ],
    "C notice question": [
        call("block_job", { reason: NOTICE_QUESTION_REASON, mailText: CLI_QUESTION }, "call-block-notice"),
    ],
    "D sending": [
        send("call-held", [ANA, OUTSIDER], "Held one", "This one has a recipient off the allowlist."),
        send("call-refused", [ANA, UNKNOWN], "Partly refused", "One of the recipients is unknown."),
        send("call-plain", [ANA], "Plain send", "Here it is."),
        call(
            "mail_save_draft",
            { account: "work", to: [ANA], subject: "Draft answer", text: "To be checked first." },
            "call-draft",
        ),
    ],
};

/** A daemon with the agents, jobs and mail components over a fake mail server that serves the owned account. */
async function start() {
    const env = await createHermeticEnv();
    envs.push(env);
    const server = await startFakeMailServer();
    servers.push(server);
    server.addAccount({ address: OWNED, login: OWNED, password: PASSWORD });
    server.refuseRecipient(UNKNOWN, "550 5.1.1 no such user");
    await writeFile(
        join(env.configDir, "config.toml"),
        `[mail]\nnotice_to = "${OPS}"\nnotice_from = "work"\n\n` +
            `[roles.${SORTER}]\ninstructions = "Send and draft mail."\ntools = ["read", "mail"]\n\n` +
            `[[mail_account]]\nname = "work"\nkind = "owned"\naddress = "${OWNED}"\n` +
            `imap_host = "127.0.0.1"\nimap_port = ${server.imapPort}\nimap_security = "none"\n` +
            `smtp_host = "127.0.0.1"\nsmtp_port = ${server.smtpPort}\nsmtp_security = "none"\n` +
            `allow = ["@example.com"]\n` +
            `auth = "password_command"\npassword_command = ["printf", "%s", "${PASSWORD}"]\n`,
    );
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const respond: FauxResponseFactory = async (context) => {
        fake.appendResponses([respond]);
        const first = context.messages.find((message) => message.role === "user");
        const text = first === undefined ? "" : textOf(first.content);
        const key = Object.keys(SCRIPTS).find((candidate) => text.includes(candidate));
        if (key === undefined) return fauxAssistantMessage("done");
        const next = (SCRIPTS[key] as Call[])[context.messages.filter((m) => m.role === "assistant").length];
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
    const log: string[] = [];
    const logger = createLogger({ stream: { write: (line) => log.push(String(line)) > 0 } });
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
    const mail = await createMailComponent({ agents, jobs, logger });
    let captured: ServiceContext | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        sections: [...agents.sections, ...mail.sections],
        components: [
            agents.component,
            jobs.component,
            mail.component,
            {
                name: "probe",
                checkModels: async (ctx) => {
                    captured = ctx;
                },
            },
        ],
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
    const invoke = (op: string, input: unknown) => daemon.catalogue.invoke(op, input, commandLineCaller);
    return { server, ctx: captured as ServiceContext, invoke };
}

type World = Awaited<ReturnType<typeof start>>;

const rawMail = (subject: string): string =>
    `From: ${ANA}\r\nTo: ${OWNED}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replaceAll(" ", "-")}@example.test>\r\n\r\nplease look\r\n`;

type Scanned = { where: string; subject: string; text: string; headers: { name: string; value: string }[] };

/** The header lines of a message as written, with folded lines joined. */
function headersOf(raw: Buffer): { name: string; value: string }[] {
    const [head = ""] = raw.toString("latin1").split(/\r?\n\r?\n/, 1);
    return head
        .replace(/\r?\n[ \t]+/g, " ")
        .split(/\r?\n/)
        .filter((line) => line !== "")
        .map((line) => {
            const colon = line.indexOf(":");
            return { name: line.slice(0, colon), value: line.slice(colon + 1).trim() };
        });
}

async function scan(world: World): Promise<Scanned[]> {
    const holders = [
        ...world.server.received().map((mail, index) => ({ where: `received #${index + 1}`, raw: mail.raw })),
        ...["Drafts", "Sent"].flatMap((folder) =>
            world.server
                .mailbox(OWNED, folder)
                .map((mail, index) => ({ where: `${folder} #${index + 1}`, raw: mail.raw })),
        ),
    ];
    return Promise.all(
        holders.map(async ({ where, raw }) => {
            const parsed = await parseMessage(raw);
            return { where, subject: parsed.subject, text: parsed.text, headers: headersOf(raw) };
        }),
    );
}

const wholeOf = (mail: Scanned): string =>
    [mail.subject, mail.text, ...mail.headers.map((header) => `${header.name}: ${header.value}`)].join("\n");

describe("no internals in mail", { timeout: TEST_TIMEOUT_MS }, () => {
    it("shows no reason, justification or title, and no header outside the standard ones, in any email (AC-016.1)", async () => {
        const world = await start();
        world.server.deliver(OWNED, rawMail("A question"));
        world.server.deliver(OWNED, rawMail("B result"));
        const cliJob = (await world.invoke("jobs.create", {
            text: "C notice question",
            title: CLI_TITLE,
        })) as JobView;
        const sendJob = (await world.invoke("jobs.create", {
            text: "D sending",
            title: SEND_TITLE,
            role: SORTER,
        })) as JobView;
        // The two question mails, the result reply, the three sends' mails and the two notices.
        await until("every email to be received", () => (world.server.received().length >= 7 ? true : undefined));
        await until("the draft and the copies in Sent", () =>
            world.server.mailbox(OWNED, "Drafts").length >= 1 && world.server.mailbox(OWNED, "Sent").length >= 2
                ? true
                : undefined,
        );
        const mails = await scan(world);
        const { jobs } = (await world.invoke("jobs.list", {})) as { jobs: JobView[] };
        assert.equal(jobs.length, 4);
        const whole = mails.map(wholeOf);
        const recipientsOf = () => world.server.received().map((mail) => mail.envelope.to.join(","));
        assert.deepEqual(
            recipientsOf().filter((to) => to === OPS).length,
            3,
            "a question and two notices to the notice address",
        );
        assert.deepEqual(
            recipientsOf().filter((to) => to === ANA).length,
            4,
            "a question, the result reply and two sends",
        );
        const kinds = (pattern: RegExp) => mails.filter((mail) => pattern.test(mail.subject)).length;
        assert.ok(kinds(/^Email held back/) >= 1, "a held-back notice was sent");
        assert.ok(kinds(/^Email refused/) >= 1, "a refused-mail notice was sent");

        // AC-1: nothing written for the team, no title.
        for (const secret of [EMAIL_QUESTION_REASON, NOTICE_QUESTION_REASON, JUSTIFICATION, CLI_TITLE, SEND_TITLE]) {
            mails.forEach((mail, index) => {
                assert.ok(!(whole[index] as string).includes(secret), `${mail.where} holds "${secret}"`);
            });
        }

        // AC-2: every header is a standard one.
        const allowed = new Set(MAIL_HEADERS.map((name) => name.toLowerCase()));
        for (const mail of mails) {
            for (const header of mail.headers) {
                assert.ok(allowed.has(header.name.toLowerCase()), `${mail.where} has the header ${header.name}`);
            }
        }

        // AC-3: no number, ID, name or path of the daemon's in anything it wrote.
        const internals = [
            ...jobs.map((job) => job.number),
            SORTER,
            ...SENDING_TOOLS,
            ...LEAD_TOOLS,
            ...["call-block-email", "call-mark", "call-define", "call-complete", "call-block-notice"],
            ...["call-held", "call-refused", "call-plain", "call-draft"],
            world.ctx.dirs.mailDir,
            "message.eml",
        ];
        // A conversation's ID is a short number, so it is looked for as a whole word and outside the Date, a clock reading.
        const conversations = new Set([cliJob.leadConversation, sendJob.leadConversation]);
        mails.forEach((mail, index) => {
            const text = whole[index] as string;
            const undated = wholeOf({ ...mail, headers: mail.headers.filter((header) => header.name !== "Date") });
            for (const id of conversations) {
                assert.doesNotMatch(
                    undated,
                    new RegExp(`(?<![\\w.-])${id}(?![\\w.-])`),
                    `${mail.where} holds conversation ${id}`,
                );
            }
            assert.doesNotMatch(text, /\b[A-Z]{1,3}-\d+\b/, `${mail.where} holds a short number`);
            for (const internal of internals) {
                assert.ok(!text.includes(internal), `${mail.where} holds "${internal}"`);
            }
        });
    });
});
