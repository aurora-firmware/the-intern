/**
 * Intake (S-009 REQ-006, REQ-007, REQ-009, REQ-021, REQ-023; ADR-001 decision 4): each `ready` owned account holds one
 * IMAP connection with INBOX selected. A check runs when the server announces new mail and at every check interval,
 * and takes each email after the account's starting point into a job, or into the open job of its thread.
 */

import type { AccountClock } from "../accounts/account_status.ts";
import type { Credential } from "../accounts/providers.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import { ConversationClosedError, JobDoneError } from "../host/job_section.ts";
import { steerConversation } from "../host/steering.ts";
import type { JobsComponentOptions } from "../jobs/jobs_component.ts";
import { createJob, leadConversationOf } from "../service/job_operations.ts";
import type { Caller } from "../service/operations.ts";
import { type ImapConnection, ImapFailure, openImap } from "./imap_client.ts";
import { type MailAccount, type MailRoute, requestText, routeFor, threadParentOf } from "./mail_model.ts";
import type { MailMessageRow } from "./mail_store.ts";
import { type ParsedMessage, parseMessage } from "./mime.ts";
import { savedCopyPaths, writeSavedCopy } from "./saved_copy.ts";

export type IntakePoint = "mail-saved" | "mail-routed";

export type IntakeDeps = {
    context(): ServiceContext;
    jobs: JobsComponentOptions;
    credential(account: MailAccount): Promise<Credential>;
    clock: AccountClock;
    logger: Logger;
    /** The account's connection broke: it turns `failing` and is connected again at its next check. */
    fail(name: string, message: string): void;
    /** Sets the account's last error and leaves it `ready`. */
    noteError(name: string, message: string): void;
    afterWrite?: (point: IntakePoint) => Promise<void>;
};

export type Intake = {
    start(account: MailAccount): void;
    /** Ends the account's intake; settles once its loop has ended. */
    stop(name: string): Promise<void>;
    stopAll(): Promise<void>;
};

type Session = { account: MailAccount; deps: IntakeDeps; imap: ImapConnection; ctx: ServiceContext };

const ORIGIN_WAY_IN = "email";
const SERVER_LOST_TRACK =
    "the server could no longer tell old mail from new, so the mail in the inbox at that moment was left alone";

const identityOf = (account: MailAccount): string => JSON.stringify([account.imapHost, account.login, account.address]);

/** The route of an email from the job its thread names: the newest `Message-ID` of `In-Reply-To`, then `References`. */
async function routeOf(ctx: ServiceContext, parsed: ParsedMessage): Promise<{ route: MailRoute; job: string | null }> {
    const ids = [parsed.inReplyTo, ...parsed.references].filter((id): id is string => id !== null);
    const known = await ctx.jobStore.readMail((tx) => tx.jobsOfMessageIds(ids));
    const parent = threadParentOf(
        { ...(parsed.inReplyTo !== null && { inReplyTo: parsed.inReplyTo }), references: parsed.references },
        (id) => known.has(id),
    );
    if (parent === undefined) return { route: "new", job: null };
    const job = known.get(parent) as string;
    return { route: routeFor((await ctx.jobStore.getJob(job)).status), job };
}

async function save(session: Session, uid: number, uidvalidity: number, raw: Uint8Array, parsed: ParsedMessage) {
    const { ctx, account } = session;
    const { route, job } = await routeOf(ctx, parsed);
    return ctx.jobStore.writeMail((tx) =>
        tx.saveMessage({
            account: account.name,
            uidvalidity,
            uid,
            messageId: parsed.messageId,
            inReplyTo: parsed.inReplyTo,
            references: parsed.references.length === 0 ? null : parsed.references.join(" "),
            sender: parsed.from,
            subject: parsed.subject,
            date: parsed.date,
            raw,
            size: raw.length,
            attachments: parsed.attachments.map(({ filename, contentType, size }) => ({ filename, contentType, size })),
            route,
            job,
        }),
    );
}

function requestTextOf(session: Session, saved: MailMessageRow, parsed: ParsedMessage): string {
    const paths = savedCopyPaths(
        session.ctx.dirs.mailDir,
        saved.id,
        parsed.attachments.map((attachment) => attachment.filename),
    );
    return requestText({
        sender: parsed.from ?? "",
        subject: parsed.subject,
        date: parsed.date ?? "",
        text: parsed.text,
        messagePath: paths.message,
        attachmentPaths: paths.attachments,
    });
}

const callerOf = (account: MailAccount, parsed: ParsedMessage): Caller => ({
    actor: {
        kind: "team_member",
        wayIn: ORIGIN_WAY_IN,
        observed: {
            account: account.name,
            ...(parsed.messageId !== null && { messageId: parsed.messageId }),
            ...(parsed.from !== null && { sender: parsed.from }),
        },
    },
});

/** Routes the email: a new or related job, or input to the open job's lead. Returns the route taken and the job. */
async function route(session: Session, saved: MailMessageRow, parsed: ParsedMessage) {
    const { ctx, account, deps } = session;
    const text = requestTextOf(session, saved, parsed);
    const requestId = `mail:${saved.id}`;
    let current: MailRoute = saved.route ?? "new";
    for (;;) {
        try {
            if (current === "input") {
                const lead = await leadConversationOf(ctx.host, saved.job as string);
                if (lead === undefined) throw new Error(`Job ${saved.job} has no lead conversation to take input`);
                const actor = { kind: "team_member", wayIn: ORIGIN_WAY_IN } as const;
                await steerConversation(ctx.host, lead, { content: text, mode: "followUp", actor, requestId });
                return { route: current, job: saved.job as string };
            }
            const created = await createJob(
                ctx,
                deps.jobs,
                {
                    text,
                    idempotencyKey: requestId,
                    ...(account.triageRole !== undefined && { role: account.triageRole }),
                    email: {
                        account: account.name,
                        savedId: saved.id,
                        ...(parsed.messageId !== null && { messageId: parsed.messageId }),
                    },
                    ...(current === "related" && saved.job !== null && { relatedTo: saved.job }),
                },
                callerOf(account, parsed),
            );
            return { route: current, job: created.id };
        } catch (error) {
            if (current !== "input" || !(error instanceof ConversationClosedError || error instanceof JobDoneError)) {
                throw error;
            }
            current = "related";
        }
    }
}

/** The email's bytes, or undefined for a UID the inbox no longer holds: moved or deleted before intake got to it. */
async function fetchRaw(session: Session, uid: number): Promise<Uint8Array | undefined> {
    try {
        return await session.imap.fetchRaw(uid);
    } catch (error) {
        // `fetchRaw` words the failure for a UID the server has no message for; any other failure is the connection's.
        if (
            error instanceof ImapFailure &&
            error.kind === "protocol" &&
            error.message.startsWith("no message with UID")
        ) {
            return undefined;
        }
        throw error;
    }
}

/** Takes in one email by the four steps of the architecture: save, copy, route, record. */
async function takeIn(session: Session, uid: number, uidvalidity: number): Promise<void> {
    const { account, deps, ctx } = session;
    const raw = await fetchRaw(session, uid);
    if (raw === undefined) {
        const next = { uidvalidity, nextUid: uid + 1, identity: identityOf(account) };
        return ctx.jobStore.writeMail((tx) => tx.writeIntake(account.name, next));
    }
    const parsed = await parseMessage(raw);
    const saved = await save(session, uid, uidvalidity, raw, parsed);
    await deps.afterWrite?.("mail-saved");
    await writeSavedCopy(ctx.dirs.mailDir, saved.id, raw);
    const routed = await route(session, saved, parsed);
    await deps.afterWrite?.("mail-routed");
    const author = { kind: "team_member", wayIn: ORIGIN_WAY_IN } as const;
    await ctx.jobStore.writeMail(async (tx) => {
        await tx.recordIntakeOutcome(saved.id, {
            outcome: routed.route === "input" ? "input_delivered" : "job_created",
            route: routed.route,
            job: routed.job,
        });
        const entry = {
            mail: "received" as const,
            from: parsed.from ?? "",
            to: [account.address],
            subject: parsed.subject,
        };
        await tx.addMailHistory(routed.job, entry, author);
        if (routed.route === "input" && parsed.messageId !== null) {
            await tx.addThread({ messageId: parsed.messageId, job: routed.job, direction: "in" });
        }
        await tx.writeIntake(account.name, { uidvalidity, nextUid: uid + 1, identity: identityOf(account) });
    });
}

/** One check: records the starting point, or takes in each UID from the next one on, in ascending order. */
async function check(session: Session): Promise<void> {
    const { account, deps, ctx } = session;
    const { uidValidity, uidNext } = await session.imap.inboxState();
    const identity = identityOf(account);
    const record = await ctx.jobStore.readMail((tx) => tx.readIntake(account.name));
    const startAt = (nextUid: number) =>
        ctx.jobStore.writeMail((tx) => tx.writeIntake(account.name, { uidvalidity: uidValidity, nextUid, identity }));
    if (record === undefined || record.identity !== identity) return startAt(uidNext);
    if (record.uidvalidity !== uidValidity) {
        await startAt(uidNext);
        deps.noteError(account.name, SERVER_LOST_TRACK);
        return;
    }
    for (let uid = record.nextUid; uid < uidNext; uid++) await takeIn(session, uid, uidValidity);
}

/** Connects, then checks at once, on each announcement of new mail, and at every check interval. */
async function watch(account: MailAccount, deps: IntakeDeps, signal: AbortSignal): Promise<void> {
    const imap = await openImap({
        host: account.imapHost,
        port: account.imapPort,
        security: account.imapSecurity,
        credential: await deps.credential(account),
        idleSeconds: account.checkIntervalSeconds,
        signal,
    });
    try {
        const session: Session = { account, deps, imap, ctx: deps.context() };
        let isWoken = false;
        let hasChecked = false;
        let pause: AbortController | undefined;
        imap.onNewMail(() => {
            isWoken = true;
            pause?.abort();
        });
        while (!signal.aborted) {
            isWoken = false;
            await check(session);
            if (!hasChecked) deps.logger.info("mail intake watching", { account: account.name });
            hasChecked = true;
            if (isWoken) continue;
            pause = new AbortController();
            const stop = () => pause?.abort();
            signal.addEventListener("abort", stop, { once: true });
            const until = new Date(deps.clock.now().getTime() + account.checkIntervalSeconds * 1000);
            await deps.clock.wait(until, pause.signal);
            signal.removeEventListener("abort", stop);
        }
    } finally {
        await imap.logout();
    }
}

export function createIntake(deps: IntakeDeps): Intake {
    const running = new Map<string, { controller: AbortController; done: Promise<void> }>();

    const stop = async (name: string): Promise<void> => {
        const entry = running.get(name);
        if (entry === undefined) return;
        running.delete(name);
        entry.controller.abort();
        await entry.done;
    };

    return {
        start(account) {
            void stop(account.name);
            const controller = new AbortController();
            const done = watch(account, deps, controller.signal).catch((error: unknown) => {
                if (controller.signal.aborted) return;
                running.delete(account.name);
                deps.fail(account.name, error instanceof Error ? error.message : "the inbox connection failed");
            });
            running.set(account.name, { controller, done });
        },
        stop,
        stopAll: async () => {
            await Promise.all([...running.keys()].map(stop));
        },
    };
}
