/**
 * The Job page (S-006 REQ-003, REQ-005). A tab asks the worker for deltas first, reads the job, its history and its
 * worklog, and applies the worklog entries that came in meanwhile. Any other delta of the job reads the job and its
 * history again: `job_done` carries no justification and history has no delta. The live activity is `JobActivity`.
 */
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ClientError } from "../client/client.ts";
import { AnswerBox } from "../components/answer_box.ts";
import { JobActivity } from "../components/job_activity.ts";
import {
    Entries,
    EntryItem,
    type HistoryEntry,
    historyText,
    JobFields,
    type JobRecord,
    Missing,
    type WorklogEntry,
} from "../components/job_record.ts";
import { refusalText } from "../components/refusal.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";

type JobDeltaLike = { type: string; number?: string; numbers?: string[]; entry?: WorklogEntry };

type JobView = {
    phase: "loading" | "found" | "missing";
    record?: JobRecord;
    worklog: WorklogEntry[];
    history: HistoryEntry[];
    failure?: string;
};

const RECORD_DELTA_TYPES: readonly string[] = ["job_changed", "job_status_changed", "job_done", "job_related_changed"];
const PAGE_SIZE = 500;
const EMPTY_VIEW: JobView = { phase: "loading", worklog: [], history: [] };
const isNotFound = (error: unknown) => error instanceof ClientError && error.code === "not_found";

const readRecord = async (number: string) => (await pageClient().invoke("jobs.get", { job: number })) as JobRecord;
const allEntries = async <T>(operation: string, number: string): Promise<T[]> => {
    const entries: T[] = [];
    let cursor: string | undefined;
    do {
        const page = (await pageClient().invoke(operation, {
            job: number,
            limit: PAGE_SIZE,
            ...(cursor !== undefined && { cursor }),
        })) as { entries: T[]; cursor?: string };
        entries.push(...page.entries);
        cursor = page.cursor;
    } while (cursor !== undefined);
    return entries;
};

/** The view without its earlier failure, and with this one when it is worth telling. */
const withFailure = (view: JobView, error: unknown): JobView => {
    const { failure: _cleared, ...rest } = view;
    const text = error === undefined ? undefined : refusalText(error);
    return { ...rest, ...(text !== undefined && { failure: text }) };
};

const withEntries = (worklog: WorklogEntry[], added: readonly WorklogEntry[]): WorklogEntry[] => {
    const entries = [...worklog];
    const keys = new Set(entries.map((entry) => JSON.stringify(entry)));
    for (const entry of added) if (!keys.has(JSON.stringify(entry))) entries.push(entry);
    return entries;
};

type JobController = {
    reload(): Promise<void>;
    onDelta(delta: JobDeltaLike): void;
};

const createJobController = (number: string, publish: (view: JobView) => void): JobController => {
    let view = EMPTY_VIEW;
    let fullGeneration = 0;
    let recordGeneration = 0;
    let buffered: WorklogEntry[] | undefined;
    let isRefreshWaiting = false;
    const show = (next: JobView) => {
        view = next;
        publish(view);
    };
    const readAgain = async () => {
        const mine = ++recordGeneration;
        const full = fullGeneration;
        try {
            const [record, history] = await Promise.all([
                readRecord(number),
                allEntries<HistoryEntry>("jobs.history.list", number),
            ]);
            if (mine !== recordGeneration || full !== fullGeneration) return;
            show({ ...withFailure(view, undefined), record, history });
        } catch (error) {
            if (mine !== recordGeneration || full !== fullGeneration) return;
            show(withFailure(view, error));
        }
    };
    return {
        async reload() {
            const mine = ++fullGeneration;
            recordGeneration++;
            buffered = [];
            isRefreshWaiting = false;
            try {
                const [record, history, worklog] = await Promise.all([
                    readRecord(number),
                    allEntries<HistoryEntry>("jobs.history.list", number),
                    allEntries<WorklogEntry>("jobs.worklog.list", number),
                ]);
                if (mine !== fullGeneration) return;
                const missed = buffered ?? [];
                buffered = undefined;
                show({ phase: "found", record, history, worklog: withEntries(worklog, missed) });
                if (isRefreshWaiting) void readAgain();
            } catch (error) {
                if (mine !== fullGeneration) return;
                buffered = undefined;
                show(isNotFound(error) ? { ...EMPTY_VIEW, phase: "missing" } : withFailure(view, error));
            }
        },
        onDelta(delta) {
            const mentioned = delta.numbers ?? [delta.number];
            if (!mentioned.some((held) => held?.toLowerCase() === number.toLowerCase())) return;
            if (delta.type === "job_worklog_added" && delta.entry !== undefined) {
                if (buffered !== undefined) buffered.push(delta.entry);
                else if (view.phase === "found") show({ ...view, worklog: withEntries(view.worklog, [delta.entry]) });
            } else if (RECORD_DELTA_TYPES.includes(delta.type)) {
                if (buffered !== undefined) isRefreshWaiting = true;
                else if (view.phase === "found") void readAgain();
            }
        },
    };
};

// A feed connection has no way to remove a listener, so it gets one pair of listeners that speak to the mounted page.
let mountedJob: JobController | undefined;
const attachedFeeds = new WeakSet<FeedConnection>();

const attachFeed = (feed: FeedConnection) => {
    if (attachedFeeds.has(feed)) return;
    attachedFeeds.add(feed);
    feed.onEvent((event) => {
        if (event.type === "instance-delta") mountedJob?.onDelta(event.delta as JobDeltaLike);
    });
    feed.onInstanceSnapshot(() => void mountedJob?.reload());
};

/** The Job page's record: the job's fields, worklog and history, kept current by the instance feed. */
export const JobPage = ({ feed, number }: { feed: FeedConnection | null | undefined; number: string }) => {
    const [view, setView] = useState<JobView>(EMPTY_VIEW);

    useEffect(() => {
        // `undefined` means the tab is still connecting: asking the worker for deltas comes before the read.
        if (feed === undefined) return;
        const controller = createJobController(number, setView);
        mountedJob = controller;
        if (feed !== null) attachFeed(feed);
        void controller.reload();
        return () => {
            if (mountedJob === controller) mountedJob = undefined;
        };
    }, [feed, number]);

    return h(
        "div",
        { class: "job" },
        view.failure !== undefined ? h("div", { class: "error", role: "alert" }, view.failure) : null,
        view.phase === "missing" ? h(Missing, { number }) : null,
        view.phase === "found" && view.record !== undefined
            ? [
                  h(JobFields, { record: view.record }),
                  h(AnswerBox, { number, isBlocked: view.record.status === "blocked" }),
                  h(JobActivity, { feed, jobId: view.record.id, leadConversation: view.record.leadConversation }),
                  h(Entries, {
                      name: "worklog",
                      title: "Worklog",
                      items: view.worklog.map((entry, index) => h(EntryItem, { entry, text: entry.text, key: index })),
                  }),
                  h(Entries, {
                      name: "history",
                      title: "History",
                      items: view.history.map((entry, index) =>
                          h(EntryItem, { entry, text: historyText(entry), key: index }),
                      ),
                  }),
              ]
            : null,
    );
};
