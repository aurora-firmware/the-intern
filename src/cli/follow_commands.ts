/**
 * `bob follow` (S-005 REQ-007, REQ-015) prints the instance feed until Ctrl-C. `bob jobs follow` (REQ-006) prints one
 * job's changes and the activity of its conversations until the job is Done. Both follow through `followFeed`, so they
 * keep going across daemon restarts and lag. Imports the client library only, never the daemon.
 */
import { type Client, createClient } from "../client/client.ts";
import { nodeTransport } from "../client/node_transport.ts";
import type { JobStatus } from "../jobs/job_model.ts";
import type { Job } from "../jobs/job_store.ts";
import type { CommandInput, CommandSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { socketPathFor, withClient } from "./connection.ts";
import { createEntryTracker, followFeed } from "./feed_follower.ts";
import { conversationEntryLine, doneLine, instanceEventLine, jobEventLine } from "./feed_text.ts";
import { statusLabel } from "./job_text.ts";
import { writeError, writeJson, writeLine } from "./output.ts";

async function follow(input: CommandInput): Promise<number> {
    const { io, json } = input;
    // `withClient` maps a missing daemon to exit 3, a refusal to exit 1 and a bad runtime directory to exit 2.
    return withClient(input, async () => {
        const socketPath = socketPathFor(input);
        const stop = new AbortController();
        const requestStop = () => stop.abort();
        process.once("SIGINT", requestStop);
        try {
            await followFeed({
                connect: () => createClient(nodeTransport({ socketPath })),
                scope: { scope: "instance" },
                signal: stop.signal,
                isUnreachableFatalAtStart: true,
                onNotice: (text) => writeError(io, text),
                async onSnapshot(snapshot) {
                    if (json) writeJson(io, snapshot);
                },
                async onDelta(delta) {
                    if (json) {
                        writeJson(io, delta);
                        return;
                    }
                    const line = instanceEventLine(delta);
                    if (line !== undefined) writeLine(io, line);
                },
            });
        } finally {
            process.off("SIGINT", requestStop);
        }
        return EXIT_CODES.ok;
    });
}

export const followCommand: CommandSpec = {
    verb: "follow",
    summary: "Print the instance feed until Ctrl-C.",
    positionals: [],
    options: {},
    isData: true,
    callsService: true,
    run: follow,
};

const HISTORY_PAGE_SIZE = 500;

type JobSnapshot = { jobs: { number: string }[] };
type ConversationRef = { id: string; jobId: string | null };

/** What one run of `bob jobs follow` shares between the instance feed and the feeds of the job's conversations. */
type JobFollow = {
    input: CommandInput;
    socketPath: string;
    job: Job;
    stop: AbortController;
    /** Resolves once the job is Done and everything it did has been printed. */
    finished: PromiseWithResolvers<void>;
};

function isAbout(delta: Record<string, unknown>, number: string, conversationIds: ReadonlySet<string>): boolean {
    const created = delta.job as { number?: string } | undefined;
    return (
        delta.number === number ||
        created?.number === number ||
        (typeof delta.conversationId === "string" && conversationIds.has(delta.conversationId))
    );
}

/**
 * Follows one conversation: each snapshot and delta of its feed triggers a catch-up of the entries not printed yet,
 * so a restart or a lagging feed loses nothing. Catch-ups of one conversation run one at a time.
 */
function followConversation(follow: JobFollow, conversationId: string) {
    const { input, socketPath, stop } = follow;
    const tracker = createEntryTracker(conversationId);
    let tail: Promise<void> = Promise.resolve();
    let isCatchUpQueued = false;
    let feedClient: Client | undefined;

    async function printMissed(client: Client): Promise<void> {
        isCatchUpQueued = false;
        for (const entry of await tracker.catchUp(client)) {
            const line = conversationEntryLine(entry);
            if (line !== undefined) writeLine(input.io, line.replaceAll(/^/gm, `[${conversationId}] `));
        }
    }

    function catchUp(client: Client | undefined = feedClient): Promise<void> {
        if (client === undefined || isCatchUpQueued) return tail;
        isCatchUpQueued = true;
        tail = tail.then(() => printMissed(client));
        return tail;
    }

    const feed = followFeed({
        connect: () => createClient(nodeTransport({ socketPath })),
        scope: { scope: "conversation", conversationId },
        signal: stop.signal,
        // The instance feed's follow reports an outage once for all the feeds.
        onNotice: () => {},
        async onSnapshot(snapshot, client) {
            feedClient = client;
            if (input.json) writeJson(input.io, snapshot);
            else await catchUp(client);
        },
        async onDelta(delta) {
            if (input.json) writeJson(input.io, delta);
            else await catchUp();
        },
    });
    return { feed, catchUp };
}

type StatusChange = { old: JobStatus; new: JobStatus };
type HistoryPage = { entries: { field: string; old: JobStatus; new: JobStatus }[]; cursor?: string };

/** Every status change in the job's history, oldest first. */
async function statusChangesOf(client: Client, job: string): Promise<StatusChange[]> {
    const changes: StatusChange[] = [];
    let cursor: string | undefined;
    do {
        const page = (await client.invoke("jobs.history.list", {
            job,
            limit: HISTORY_PAGE_SIZE,
            ...(cursor !== undefined && { cursor }),
        })) as HistoryPage;
        for (const entry of page.entries)
            if (entry.field === "status") changes.push({ old: entry.old, new: entry.new });
        cursor = page.cursor;
    } while (cursor !== undefined);
    return changes;
}

/** How a job that is Done reads: with its resolution when it has one. */
function endLine(job: Job): string {
    return job.resolution === undefined ? `${job.number} done` : doneLine(job.number, job.resolution);
}

async function followJob(follow: JobFollow, client: Client): Promise<void> {
    const { input, socketPath, job, stop, finished } = follow;
    stop.signal.addEventListener("abort", () => finished.resolve(), { once: true });
    const knownChangeCount = (await statusChangesOf(client, job.id)).length;
    const printedChanges: StatusChange[] = [];
    const conversations = new Map<string, ReturnType<typeof followConversation>>();
    const feeds: Promise<void>[] = [];

    function followNew(conversation: ConversationRef): void {
        if (conversation.jobId !== job.id || conversations.has(conversation.id)) return;
        const followed = followConversation(follow, conversation.id);
        conversations.set(conversation.id, followed);
        feeds.push(followed.feed);
    }

    // The feed has no replay, so a change made while it was down is read from the history; the changes printed
    // live are matched to the history in order and skipped.
    async function printMissedChanges(): Promise<void> {
        const changes = (await statusChangesOf(client, job.id)).slice(knownChangeCount);
        let printedCount = 0;
        for (const change of changes) {
            const printed = printedChanges[printedCount];
            if (printed?.old === change.old && printed.new === change.new) {
                printedCount += 1;
                continue;
            }
            const line = jobEventLine({ type: "job_status_changed", number: job.number, ...change });
            if (line !== undefined) writeLine(input.io, line);
        }
    }

    async function finish(resolutionLine: string | undefined): Promise<void> {
        if (!input.json) {
            await Promise.all([...conversations.values()].map((followed) => followed.catchUp(client)));
            await printMissedChanges();
            if (resolutionLine !== undefined) writeLine(input.io, resolutionLine);
        }
        finished.resolve();
    }

    async function finishIfDone(): Promise<void> {
        const current = (await client.invoke("jobs.get", { job: job.id })) as Job;
        if (current.status === "done") await finish(endLine(current));
    }

    const instance = followFeed({
        connect: () => createClient(nodeTransport({ socketPath })),
        scope: { scope: "instance" },
        signal: stop.signal,
        onNotice: (text) => writeError(input.io, text),
        async onSnapshot(snapshot) {
            if (input.json) writeJson(input.io, snapshot);
            const listed = (await client.invoke("conversations.list", { jobId: job.id })) as ConversationRef[];
            for (const conversation of listed) followNew(conversation);
            // A Done job is not in the snapshot: it may have ended while the feed was down.
            if (!(snapshot as JobSnapshot).jobs.some(({ number }) => number === job.number)) await finishIfDone();
        },
        async onDelta(delta) {
            const event = delta as Record<string, unknown> & { type: string; conversationId?: string };
            if (event.type === "conversation_created" && event.conversationId !== undefined) {
                const created = (await client.invoke("conversations.get", {
                    conversationId: event.conversationId,
                })) as ConversationRef;
                followNew(created);
            }
            if (!isAbout(event, job.number, new Set(conversations.keys()))) return;
            if (input.json) writeJson(input.io, delta);
            if (event.type === "job_done") {
                await finish(input.json ? undefined : jobEventLine(delta));
                return;
            }
            if (event.type === "job_status_changed") printedChanges.push(event as unknown as StatusChange);
            const line = input.json ? undefined : jobEventLine(delta);
            if (line !== undefined) writeLine(input.io, line);
        },
    });
    await finished.promise;
    stop.abort();
    await Promise.all([instance, ...feeds]);
}

async function jobsFollow(input: CommandInput): Promise<number> {
    return withClient(input, async (client) => {
        const { io, json } = input;
        const job = (await client.invoke("jobs.get", { job: input.positionals[0] })) as Job;
        if (json) writeJson(io, job);
        if (job.status === "done") {
            if (!json) writeLine(io, endLine(job));
            return EXIT_CODES.ok;
        }
        if (!json) writeLine(io, `${job.number} ${statusLabel(job)}`);
        const stop = new AbortController();
        const requestStop = () => stop.abort();
        process.once("SIGINT", requestStop);
        try {
            const finished = Promise.withResolvers<void>();
            await followJob({ input, socketPath: socketPathFor(input), job, stop, finished }, client);
        } finally {
            process.off("SIGINT", requestStop);
        }
        return EXIT_CODES.ok;
    });
}

export const jobsFollowCommand: CommandSpec = {
    group: "jobs",
    verb: "follow",
    summary: "Print a job's changes and its conversations' activity until the job is Done.",
    positionals: [{ name: "job", required: true }],
    options: {},
    isData: true,
    callsService: true,
    run: jobsFollow,
};
