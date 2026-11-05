/**
 * The per-job serial section and the closed checks (S-001 REQ-026; ADR-001 decision 4, first bounded exception). Every
 * conversation of a job closes when the job is Done. The daemon orders, per job, the job abort's closed-mark commits
 * with every input admission, control operation and creation of a conversation of the job, so none slips in between
 * the abort's listing of the job's conversations and its marks. The section is in-process: one daemon owns the database.
 */
import type { HarnessHost } from "./harness_host.ts";
import { readConversationMeta } from "./seating.ts";

export class ConversationClosedError extends Error {
    readonly conversationId: string;

    constructor(conversationId: string) {
        super(`Conversation "${conversationId}" is closed: its job is Done.`);
        this.name = "ConversationClosedError";
        this.conversationId = conversationId;
    }
}

export class JobDoneError extends Error {
    readonly jobId: string;

    constructor(jobId: string) {
        super(`Job "${jobId}" is Done, so its conversations are closed.`);
        this.name = "JobDoneError";
        this.jobId = jobId;
    }
}

type JobDoneCheck = (jobId: string) => Promise<boolean>;
type SectionHook = (conversationId: string) => void | Promise<void>;

// The last section of each job that still holds or awaits work; a job with none has no entry.
const sectionTails = new WeakMap<HarnessHost, Map<string, Promise<void>>>();
const jobDoneChecks = new WeakMap<HarnessHost, JobDoneCheck>();
const sectionHooks = new WeakMap<HarnessHost, SectionHook>();

function tailsOf(host: HarnessHost): Map<string, Promise<void>> {
    const existing = sectionTails.get(host);
    if (existing !== undefined) return existing;
    const created = new Map<string, Promise<void>>();
    sectionTails.set(host, created);
    return created;
}

/**
 * Runs the work after every earlier section of the job has settled, whether it succeeded or failed. A section's work
 * never enters another section: a nested one would wait for the section that holds it.
 */
export function inJobSection<T>(host: HarnessHost, jobId: string, work: () => Promise<T>): Promise<T> {
    const tails = tailsOf(host);
    const result = (tails.get(jobId) ?? Promise.resolve()).then(work);
    const tail = result.then(
        () => undefined,
        () => undefined,
    );
    tails.set(jobId, tail);
    tail.then(() => {
        if (tails.get(jobId) === tail) tails.delete(jobId);
    });
    return result;
}

/** Registers how the host learns that a job is Done. A new check replaces the old one; with none no job is Done. */
export function setJobDoneCheck(host: HarnessHost, check: JobDoneCheck): () => void {
    jobDoneChecks.set(host, check);
    return () => {
        if (jobDoneChecks.get(host) === check) jobDoneChecks.delete(host);
    };
}

/** Test-only: runs after a closed check passed, still inside the section, so a test can hold the work there. */
export function setSectionHook(host: HarnessHost, hook: SectionHook): () => void {
    sectionHooks.set(host, hook);
    return () => {
        if (sectionHooks.get(host) === hook) sectionHooks.delete(host);
    };
}

async function isJobDone(host: HarnessHost, jobId: string): Promise<boolean> {
    return (await jobDoneChecks.get(host)?.(jobId)) ?? false;
}

/** Throws `JobDoneError` when the registered check reports the job Done. */
export async function refuseIfJobDone(host: HarnessHost, jobId: string): Promise<void> {
    if (await isJobDone(host, jobId)) throw new JobDoneError(jobId);
}

/**
 * Answers whether the conversation is closed: its closed mark is set or its job is Done. The front desk and a
 * conversation without an `intern.conversation` document are never closed.
 */
export async function isConversationClosed(host: HarnessHost, conversationId: string): Promise<boolean> {
    const meta = await readConversationMeta(host, conversationId);
    if (meta === undefined || meta.jobId === null) return false;
    return meta.closed === true || (await isJobDone(host, meta.jobId));
}

/** Throws `ConversationClosedError` when the conversation is closed, then awaits the test hook. Call it in the section. */
export async function refuseIfClosed(host: HarnessHost, conversationId: string): Promise<void> {
    if (await isConversationClosed(host, conversationId)) throw new ConversationClosedError(conversationId);
    await sectionHooks.get(host)?.(conversationId);
}

/**
 * Runs the work in the conversation's job section, after the closed check passes inside it. The front desk and a
 * conversation without an `intern.conversation` document run the work with no section and no check.
 */
export async function inOpenConversation<T>(
    host: HarnessHost,
    conversationId: string,
    work: () => Promise<T>,
): Promise<T> {
    const meta = await readConversationMeta(host, conversationId);
    if (meta === undefined || meta.jobId === null) return work();
    return inJobSection(host, meta.jobId, async () => {
        await refuseIfClosed(host, conversationId);
        return work();
    });
}
