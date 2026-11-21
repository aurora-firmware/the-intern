/**
 * Live check of S-009 AC-008.2 and AC-016.2: the shipped `triage` role on one real model over the pi agent login of the
 * account running this script, against the fake mail server. A request, a newsletter and an out-of-office reply arrive
 * at an owned account: the request must be marked and handed off with a rewritten definition of done, the other two
 * completed with a justification, and only the request answered, after its job is completed. Then a request that asks
 * for a question first is worked, blocked, answered and completed, and its agent writes with the send tool; no email
 * the daemon or the agent sent may name a short number or an internal name. They make real model requests, so
 * `npm test` never runs them; run `npm run test:live:mail -- --model <provider/id>` by hand. The pi agent folder is the
 * account's own: nothing here writes to it.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import type { HistoryEntry } from "../../src/jobs/job_store.ts";
import { parseMessage } from "../../src/mail/mime.ts";
import { resolvePiAgentDir } from "../../src/models/model_runtime.ts";
import type { JobView } from "../../src/service/job_operations.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import type { HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_MODE = 0o700;
const POLL_INTERVAL_MS = 500;
const WAIT_BOUND_MS = 600_000;
const STOP_BOUND_MS = 30_000;
const OWNED = "team@example.test";
const PASSWORD = "pw";
const SENDER = "ana@example.com";
const REQUEST = {
    subject: "Ready file",
    text: "Hello, please write the word ready into a file named ready.txt in your workspace. Thank you, Ana",
};
const NEWSLETTER = {
    subject: "Your weekly gardening digest",
    text: "This week: ten tips for tomatoes. You receive this newsletter because you subscribed. Unsubscribe any time.",
    headers: ["List-Unsubscribe: <mailto:unsubscribe@example.com>", "Precedence: bulk"],
};
const OUT_OF_OFFICE = {
    subject: "Automatic reply: Holiday plans",
    text: "I am out of the office until the 3rd and will answer when I am back. This is an automatic reply.",
    headers: ["Auto-Submitted: auto-replied"],
};
const QUESTION_FIRST = {
    subject: "Project summary",
    text:
        "Hello, please write a one-line summary of my project into a file named summary.txt in your workspace. I have " +
        "not said which project I mean: ask me which one in one email before you do anything else. When I answer, " +
        "send me a short note with your mail send tool saying you have started, then do the work and finish. Ana",
};
const ANSWER_TEXT = "It is the Falcon project, a small tool that counts the words in a text. Thanks, Ana";
const SHORT_NUMBER = /\b[A-Z]{1,2}-\d+\b/;
const SAVED_MAIL_PATH = /\.eml\b|\/mail\/|\/state\/|\/data\//;
const INTERNAL_NAME =
    /\b(triage|gp|desk|bob|mail_[a-z_]+|complete_job|block_job|mark_request|update_job|handoff|invoke)\b/i;

type Mail = { subject: string; text: string; headers?: string[] };

async function createLiveEnv(): Promise<HermeticEnv> {
    // A short path under the system temp folder: a socket path over 107 bytes fails in a deep worktree.
    const root = join(tmpdir(), `bob-live-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`);
    const directories = ["config", "state", "data", "runtime"].map((name) => join(root, name));
    await mkdir(root, { recursive: true, mode: OWNER_ONLY_MODE });
    await chmod(root, OWNER_ONLY_MODE);
    for (const directory of directories) {
        await mkdir(directory, { mode: OWNER_ONLY_MODE });
        await chmod(directory, OWNER_ONLY_MODE);
    }
    const piAgentDir = resolvePiAgentDir(process.env);
    const [configDir, stateDir, dataDir, runtimeDir] = directories;
    return {
        root,
        configDir,
        stateDir,
        dataDir,
        runtimeDir,
        piAgentDir,
        env: { ...process.env, HOME: process.env.HOME, PI_CODING_AGENT_DIR: piAgentDir },
        dispose: () => rm(root, { recursive: true, force: true }),
    };
}

function accountToml(server: FakeMailServer): string {
    return `[[mail_account]]
name = "work"
kind = "owned"
address = "${OWNED}"
imap_host = "127.0.0.1"
imap_port = ${server.imapPort}
imap_security = "none"
smtp_host = "127.0.0.1"
smtp_port = ${server.smtpPort}
smtp_security = "none"
allow = ["@example.com"]
auth = "password_command"
password_command = ["printf", "%s", "${PASSWORD}"]
`;
}

const rawMail = (mail: Mail, extra: string[] = []): string =>
    [
        `From: ${SENDER}`,
        `To: ${OWNED}`,
        `Subject: ${mail.subject}`,
        `Message-ID: <${mail.subject.replaceAll(" ", "-")}@example.com>`,
        ...(mail.headers ?? []),
        ...extra,
        "",
        mail.text,
        "",
    ].join("\r\n");

/** Polls until the attempt returns a value, and fails with the description when the bound passes. */
async function until<T>(description: string, attempt: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        assert.ok(Date.now() < deadline, `Timed out waiting for ${description}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

type World = { daemon: DaemonProcess; server: FakeMailServer };

const jobOf = async (world: World, ref: string) => (await world.daemon.invoke("jobs.get", { job: ref })) as JobView;

async function jobsAbout(world: World, subject: string): Promise<JobView | undefined> {
    const { jobs } = (await world.daemon.invoke("jobs.list", {})) as { jobs: { number: string }[] };
    for (const { number } of jobs) {
        const job = await jobOf(world, number);
        if (job.request.text.includes(subject)) return job;
    }
    return undefined;
}

async function historyOf(world: World, job: JobView): Promise<HistoryEntry[]> {
    const { entries } = (await world.daemon.invoke("jobs.history.list", { job: job.number, limit: 500 })) as {
        entries: HistoryEntry[];
    };
    return entries;
}

function print(label: string, job: JobView): void {
    console.log(`  ${label}: job ${job.number}, status ${job.status}, request mark ${job.requestMark}`);
    console.log(`    definition of done: ${JSON.stringify(job.definitionOfDone)}`);
    console.log(`    resolution: ${job.resolution ? JSON.stringify(job.resolution) : "none"}`);
    if (job.blockedReason) console.log(`    blocked reason: ${JSON.stringify(job.blockedReason)}`);
}

async function untilJobEnds(world: World, subject: string, statuses: string[]): Promise<JobView> {
    const found = await until(`the job of "${subject}" to be ${statuses.join(" or ")}`, async () => {
        const job = await jobsAbout(world, subject);
        return job && statuses.includes(job.status) ? job : undefined;
    });
    return found;
}

async function assertLeadWroteDefinition(world: World, job: JobView): Promise<void> {
    const writes = (await historyOf(world, job)).filter((entry) => entry.field === "definitionOfDone");
    assert.ok(
        writes.some((entry) => entry.author.kind === "agent"),
        `job ${job.number}: no definition of done was written by its lead`,
    );
}

async function checkTriage(world: World): Promise<void> {
    for (const mail of [REQUEST, NEWSLETTER, OUT_OF_OFFICE]) world.server.deliver(OWNED, rawMail(mail));
    const request = await untilJobEnds(world, REQUEST.subject, ["done", "blocked"]);
    const newsletter = await untilJobEnds(world, NEWSLETTER.subject, ["done", "blocked"]);
    const outOfOffice = await untilJobEnds(world, OUT_OF_OFFICE.subject, ["done", "blocked"]);
    print("request", request);
    print("newsletter", newsletter);
    print("out-of-office reply", outOfOffice);

    for (const job of [request, newsletter, outOfOffice]) {
        assert.equal(job.status, "done", `job ${job.number} ended ${job.status}, not done`);
        assert.equal(job.resolution?.kind, "completed");
        assert.ok(job.resolution.justification.trim(), `job ${job.number} has no justification`);
        await assertLeadWroteDefinition(world, job);
    }
    assert.equal(request.requestMark, "true", "the request is not marked");
    for (const job of [newsletter, outOfOffice])
        assert.notEqual(job.requestMark, "true", `job ${job.number} is marked`);
    const requestDefinitions = (await historyOf(world, request)).filter((entry) => entry.field === "definitionOfDone");
    assert.ok(requestDefinitions.length >= 2, "the request's definition of done was not rewritten");
    assert.ok(await hasAcceptedHandoff(world, request), "the request was not handed off: no handoff tool result");

    const replies = await until("the reply to the request", () =>
        world.server.received().length > 0 ? world.server.received() : undefined,
    );
    assert.equal(replies.length, 1, `${replies.length} emails were sent, not one`);
    assert.deepEqual(replies[0]?.envelope.to, [SENDER], "the reply did not go to the request's sender");
    const sentAt = Date.parse((await parseMessage(replies[0]?.raw as Buffer)).date ?? "");
    const doneAt = Date.parse(request.doneAt ?? "");
    assert.ok(sentAt >= Math.floor(doneAt / 1000) * 1000, "the reply was sent before the request job was completed");
    console.log("  one reply, to the request's sender, after its job was completed");
}

type ConversationEntry = {
    kind: string;
    data: { messages?: { role?: string; toolName?: string; isError?: boolean }[] };
};

/** True when the lead conversation holds the result of a handoff call the product accepted. */
async function hasAcceptedHandoff(world: World, job: JobView): Promise<boolean> {
    assert.ok(job.leadConversation, `job ${job.number} has no lead conversation`);
    const { entries } = (await world.daemon.invoke("conversations.entries", {
        conversationId: job.leadConversation,
        limit: 500,
    })) as { entries: ConversationEntry[] };
    return entries.some(
        (entry) =>
            entry.kind === "pi.tool-result" &&
            entry.data.messages?.some((message) => message.toolName === "handoff" && message.isError !== true),
    );
}

async function conversationText(world: World, job: JobView): Promise<string> {
    assert.ok(job.leadConversation, `job ${job.number} has no lead conversation`);
    const { entries } = (await world.daemon.invoke("conversations.entries", {
        conversationId: job.leadConversation,
        limit: 500,
    })) as { entries: unknown[] };
    return JSON.stringify(entries);
}

async function checkQuestionAndSendTool(world: World): Promise<void> {
    const before = world.server.received().length;
    world.server.deliver(OWNED, rawMail(QUESTION_FIRST));
    const blocked = await untilJobEnds(world, QUESTION_FIRST.subject, ["blocked", "done"]);
    print("request with a question", blocked);
    assert.equal(blocked.status, "blocked", `the job ended ${blocked.status}, not blocked with a question`);
    const question = await until("the question to be mailed", () => world.server.received()[before]);
    const asked = await parseMessage(question.raw);
    assert.ok(asked.messageId, "the question has no Message-ID");
    world.server.deliver(
        OWNED,
        rawMail({ subject: `Re: ${asked.subject}`, text: ANSWER_TEXT }, [`In-Reply-To: ${asked.messageId}`]),
    );
    const done = await untilJobEnds(world, QUESTION_FIRST.subject, ["done"]);
    print("after the answer", done);
    assert.equal(done.resolution?.kind, "completed");
    assert.match(await conversationText(world, done), /mail_send/, "the agent did not use the send tool");
    await scanSentMail(world);
}

async function scanSentMail(world: World): Promise<void> {
    const sent = world.server.received();
    // Every job has ended by now, so a reply to the newsletter or the out-of-office reply would have been sent.
    for (const mail of sent) {
        const { subject } = await parseMessage(mail.raw);
        for (const ignored of [NEWSLETTER, OUT_OF_OFFICE])
            assert.ok(!subject?.includes(ignored.subject), `a reply was sent to "${ignored.subject}"`);
    }
    assert.ok(sent.length >= 3, `${sent.length} emails were sent, fewer than the reply, the question and a note`);
    for (const mail of sent) {
        const { subject, text } = await parseMessage(mail.raw);
        for (const [what, pattern] of [
            ["a short number", SHORT_NUMBER],
            ["a saved-mail path", SAVED_MAIL_PATH],
            ["an internal name", INTERNAL_NAME],
        ] as const) {
            const hit = pattern.exec(`${subject}\n${text}`)?.[0];
            assert.equal(hit, undefined, `an email to ${mail.envelope.to.join(", ")} names ${what}: ${hit}`);
        }
        console.log(
            `  sent to ${mail.envelope.to.join(", ")}: ${JSON.stringify(subject)} ${JSON.stringify(text.trim())}`,
        );
    }
    console.log(`  scan of ${sent.length} sent emails: no short number, saved-mail path or internal name`);
}

/** Waits for the daemon to exit after SIGTERM; a daemon that does not exit in time fails the run, never hangs it. */
async function expectCleanExit(daemon: DaemonProcess): Promise<void> {
    const outcome = await Promise.race([daemon.exited, sleep(STOP_BOUND_MS).then(() => "timeout" as const)]);
    if (outcome === "timeout") {
        daemon.kill9();
        assert.fail(`the daemon did not exit within ${STOP_BOUND_MS} ms of SIGTERM: ${daemon.stderr()}`);
    }
    assert.equal(outcome.code, 0, `the daemon did not stop cleanly: ${daemon.stderr()}`);
}

async function run(model: string): Promise<void> {
    const env = await createLiveEnv();
    const server = await startFakeMailServer();
    server.addAccount({ address: OWNED, login: OWNED, password: PASSWORD });
    await writeFile(join(env.configDir, "config.toml"), accountToml(server));
    const daemon = startDaemon({ hermetic: env, realModels: true, model, turnEndRule: true });
    const world = { daemon, server };
    try {
        await daemon.ready;
        await until("the account to be ready", async () => {
            const status = (await daemon.invoke("daemon.status", {})) as { mailAccounts: { status: string }[] };
            return status.mailAccounts[0]?.status === "ready" ? true : undefined;
        });
        // Intake takes only mail that arrives after its first check; wait for it before delivering any.
        await until("intake of the account to watch the inbox", () =>
            /mail intake watching.*account=work/.test(daemon.stderr()) ? true : undefined,
        );
        await checkTriage(world);
        await checkQuestionAndSendTool(world);
        daemon.signal("SIGTERM");
        await expectCleanExit(daemon);
    } finally {
        daemon.kill9();
        await daemon.exited;
        await server.stop();
        await env.dispose();
    }
}

async function main(): Promise<void> {
    const { values } = parseArgs({ options: { model: { type: "string" } } });
    if (!values.model) throw new Error("Pass the model as --model <provider/id>");
    try {
        await run(values.model);
        console.log("PASS triage decisions, one reply, and mail without internals");
        process.exit(0);
    } catch (error) {
        console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
        process.exit(1);
    }
}

await main();
