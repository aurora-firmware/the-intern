/**
 * The Job page (S-006 REQ-003, REQ-005). A tab asks the worker for deltas first, reads the job, its history and its
 * worklog, and applies the worklog entries that came in meanwhile. Any other delta of the job reads the job and its
 * history again: `job_done` carries no justification and history has no delta. The live activity is `JobActivity`.
 */
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { ClientError, UnreachableError } from "../client/client.ts";
import { JobActivity } from "../components/activity.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";

type Observed = { remoteAddress?: string; remotePort?: number };
type Author =
    | { kind: "agent"; conversationId: string; role: string }
    | { kind: "team_member"; wayIn: string; observed?: Observed }
    | { kind: "daemon" };
type Origin =
    | { kind: "request"; wayIn: string; observed?: Observed }
    | { kind: "schedule"; entry: string }
    | { kind: "trigger"; trigger: string }
    | { kind: "follow_up"; jobId: string };
type JobRecord = {
    id: string;
    leadConversation?: string;
    number: string;
    title: string;
    description: string;
    definitionOfDone: string;
    status: string;
    blockedReason?: string;
    request: { origin: Origin };
    resolution?: { kind: string; justification: string };
};
type WorklogEntry = { at: string; author: Author; text: string };
type HistoryEntry = { at: string; author: Author; field: string; old: unknown; new: unknown };
type JobDeltaLike = { type: string; number?: string; numbers?: string[]; entry?: WorklogEntry };

type JobView = {
    phase: "loading" | "found" | "missing";
    record?: JobRecord;
    worklog: WorklogEntry[];
    history: HistoryEntry[];
    failure?: string;
};

const STATUS_LABELS: Record<string, string> = {
    to_do: "To do",
    in_progress: "In progress",
    blocked: "Blocked",
    done: "Done",
};
const RECORD_DELTA_TYPES: readonly string[] = ["job_changed", "job_status_changed", "job_done", "job_related_changed"];
const PAGE_SIZE = 500;
const EMPTY_VIEW: JobView = { phase: "loading", worklog: [], history: [] };
const isNotFound = (error: unknown) => error instanceof ClientError && error.code === "not_found";
const TEXT_STYLE = "margin: 0; overflow-wrap: anywhere; white-space: pre-wrap;";
const LIST_STYLE = "display: flex; flex-direction: column; gap: 0.5rem; margin: 0; padding: 0; list-style: none;";

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

/** A refusal or failure worth telling the team member; a service that can't be reached shows the banner instead. */
const failureText = (error: unknown): string | undefined => {
    if (error instanceof UnreachableError || (error instanceof ClientError && error.code === "unavailable")) {
        return undefined;
    }
    return error instanceof Error ? error.message : String(error);
};

/** The view without its earlier failure, and with this one when it is worth telling. */
const withFailure = (view: JobView, error: unknown): JobView => {
    const { failure: _cleared, ...rest } = view;
    const text = error === undefined ? undefined : failureText(error);
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

const addressOf = (observed?: Observed): string =>
    observed?.remoteAddress === undefined
        ? ""
        : ` from ${observed.remoteAddress}${observed.remotePort === undefined ? "" : `:${observed.remotePort}`}`;

const originText = (origin: Origin): string => {
    switch (origin.kind) {
        case "request":
            return `Request by ${origin.wayIn}${addressOf(origin.observed)}`;
        case "schedule":
            return `Schedule ${origin.entry}`;
        case "trigger":
            return `Trigger ${origin.trigger}`;
        case "follow_up":
            return `Follow-up of job ${origin.jobId}`;
    }
};

const authorText = (author: Author): string => {
    switch (author.kind) {
        case "agent":
            return `${author.role} agent`;
        case "team_member":
            return `Team member by ${author.wayIn}${addressOf(author.observed)}`;
        case "daemon":
            return "The daemon";
    }
};

const valueText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
const historyText = (entry: HistoryEntry): string =>
    `${entry.field}: ${valueText(entry.old)} → ${valueText(entry.new)}`;

const Field = ({ name, label, value }: { name: string; label: string; value: string }) =>
    h(
        "div",
        { class: "job-field", "data-field": name },
        h("h3", null, label),
        h("p", { class: "job-value", style: TEXT_STYLE }, value),
    );

const JobFields = ({ record }: { record: JobRecord }) => {
    const { resolution } = record;
    return h(
        "section",
        { class: "job-record" },
        h("h3", { class: "job-number" }, record.number),
        h(Field, { name: "title", label: "Title", value: record.title }),
        h(Field, { name: "description", label: "Description", value: record.description }),
        h(Field, { name: "definition-of-done", label: "Definition of done", value: record.definitionOfDone }),
        h(Field, { name: "status", label: "Status", value: STATUS_LABELS[record.status] ?? record.status }),
        record.status === "blocked"
            ? h(Field, { name: "blocked-reason", label: "Blocked reason", value: record.blockedReason ?? "" })
            : null,
        h(Field, { name: "origin", label: "Origin", value: originText(record.request.origin) }),
        record.status === "done" && resolution !== undefined
            ? [
                  h(Field, { name: "resolution", label: "Resolution", value: resolution.kind }),
                  h(Field, { name: "justification", label: "Justification", value: resolution.justification }),
              ]
            : null,
    );
};

const Entries = ({ name, title, items }: { name: string; title: string; items: ReturnType<typeof h>[] }) =>
    h(
        "section",
        { class: `job-${name}`, "data-section": name },
        h("h3", null, title),
        h("ul", { style: LIST_STYLE }, ...items),
    );

const EntryItem = ({ entry, text }: { entry: WorklogEntry | HistoryEntry; text: string }) =>
    h(
        "li",
        { class: "card job-entry" },
        h("span", { class: "caption" }, `${entry.at} ${authorText(entry.author)}`),
        h("p", { style: TEXT_STYLE }, text),
    );

const Missing = ({ number }: { number: string }) =>
    h("p", { class: "job-missing" }, `The job ${number} doesn't exist. `, h("a", { href: "#/" }, "Back to the Board"));

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
