/**
 * The Board page (S-006 REQ-002). A tab asks the worker for job deltas first, then reads `jobs.list` per status, and
 * applies the deltas that came in meanwhile, so a read can't hide a change.
 */
import { h } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { ClientError, UnreachableError } from "../client/client.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";
import {
    addDoneJobs,
    applyJobDelta,
    type BoardJob,
    type BoardState,
    type BoardStatus,
    blockedText,
    boardColumns,
    type JobDelta,
} from "../model/board.ts";

const LABELS: Record<BoardStatus, string> = {
    to_do: "To do",
    in_progress: "In progress",
    blocked: "Blocked",
    done: "Done",
};
const DONE_PAGE_SIZE = 50;
const OPEN_PAGE_SIZE = 500;
const JOB_DELTA_TYPES: readonly string[] = [
    "job_created",
    "job_changed",
    "job_status_changed",
    "job_done",
    "job_related_changed",
];

type JobsPage = { jobs: BoardJob[]; cursor?: string };
type BoardView = { columns: BoardState; doneCursor?: string; isLoaded: boolean; failure?: string };
type BoardReading = { jobs: BoardJob[]; doneCursor?: string };

const EMPTY_VIEW: BoardView = { columns: boardColumns([]), isLoaded: false };

const toBoardJob = (job: BoardJob): BoardJob => ({
    number: job.number,
    title: job.title,
    status: job.status,
    ...(job.description !== undefined && { description: job.description }),
    ...(job.definitionOfDone !== undefined && { definitionOfDone: job.definitionOfDone }),
    ...(job.blockedReason !== undefined && { blockedReason: job.blockedReason }),
});

const listJobs = async (status: BoardStatus, limit: number, cursor?: string): Promise<JobsPage> => {
    const page = (await pageClient().invoke("jobs.list", {
        status,
        limit,
        ...(cursor !== undefined && { cursor }),
    })) as JobsPage;
    return { jobs: page.jobs.map(toBoardJob), ...(page.cursor !== undefined && { cursor: page.cursor }) };
};

const allJobs = async (status: BoardStatus): Promise<BoardJob[]> => {
    const jobs: BoardJob[] = [];
    let cursor: string | undefined;
    do {
        const page = await listJobs(status, OPEN_PAGE_SIZE, cursor);
        jobs.push(...page.jobs);
        cursor = page.cursor;
    } while (cursor !== undefined);
    return jobs;
};

/** Every page of To do, In progress and Blocked, and the first page of Done. */
const readBoard = async (): Promise<BoardReading> => {
    const [toDo, inProgress, blocked, done] = await Promise.all([
        allJobs("to_do"),
        allJobs("in_progress"),
        allJobs("blocked"),
        listJobs("done", DONE_PAGE_SIZE),
    ]);
    return {
        jobs: [...toDo, ...inProgress, ...blocked, ...done.jobs],
        ...(done.cursor !== undefined && { doneCursor: done.cursor }),
    };
};

/** A refusal or failure worth telling the team member; a service that can't be reached shows the banner instead. */
const failureText = (error: unknown): string | undefined => {
    if (error instanceof UnreachableError || (error instanceof ClientError && error.code === "unavailable")) {
        return undefined;
    }
    return error instanceof Error ? error.message : String(error);
};

type BoardController = {
    /** Reads the board; deltas that arrive during the read are applied to its result. */
    reload(): Promise<void>;
    onDelta(delta: JobDelta): void;
    loadMoreDone(): Promise<void>;
};

const createBoardController = (publish: (view: BoardView) => void): BoardController => {
    let view = EMPTY_VIEW;
    let generation = 0;
    let buffered: JobDelta[] | undefined;
    let isLoadingMore = false;
    const show = (next: BoardView) => {
        view = next;
        publish(view);
    };
    return {
        async reload() {
            const mine = ++generation;
            buffered = [];
            try {
                const reading = await readBoard();
                if (mine !== generation) return;
                const columns = (buffered ?? []).reduce(applyJobDelta, boardColumns(reading.jobs));
                buffered = undefined;
                show({
                    columns,
                    isLoaded: true,
                    ...(reading.doneCursor !== undefined && { doneCursor: reading.doneCursor }),
                });
            } catch (error) {
                if (mine !== generation) return;
                buffered = undefined;
                const { failure: _cleared, ...rest } = view;
                const text = failureText(error);
                show({ ...rest, ...(text !== undefined && { failure: text }) });
            }
        },
        onDelta(delta) {
            if (buffered !== undefined) {
                buffered.push(delta);
            } else if (view.isLoaded) {
                show({ ...view, columns: applyJobDelta(view.columns, delta) });
            }
        },
        async loadMoreDone() {
            if (view.doneCursor === undefined || isLoadingMore) return;
            isLoadingMore = true;
            try {
                const page = await listJobs("done", DONE_PAGE_SIZE, view.doneCursor);
                const { doneCursor: _used, ...rest } = view;
                show({
                    ...rest,
                    columns: addDoneJobs(view.columns, page.jobs),
                    ...(page.cursor !== undefined && { doneCursor: page.cursor }),
                });
            } catch (error) {
                const text = failureText(error);
                if (text !== undefined) show({ ...view, failure: text });
            } finally {
                isLoadingMore = false;
            }
        },
    };
};

const isJobDelta = (delta: unknown): delta is JobDelta =>
    typeof delta === "object" &&
    delta !== null &&
    JOB_DELTA_TYPES.includes((delta as { type?: unknown }).type as string);

// A feed connection has no way to remove a listener, so it gets one pair of listeners that speak to the mounted page.
let mountedBoard: BoardController | undefined;
const attachedFeeds = new WeakSet<FeedConnection>();

const attachFeed = (feed: FeedConnection) => {
    if (attachedFeeds.has(feed)) return;
    attachedFeeds.add(feed);
    feed.onEvent((event) => {
        if (event.type === "instance-delta" && isJobDelta(event.delta)) mountedBoard?.onDelta(event.delta);
    });
    feed.onInstanceSnapshot(() => void mountedBoard?.reload());
};

const JobCard = ({ job }: { job: BoardJob }) => {
    const isBlocked = job.status === "blocked";
    return h(
        "li",
        { class: isBlocked ? "card card-blocked board-card" : "card board-card" },
        h("a", { href: `#/jobs/${job.number}` }, h("span", { class: "job-number" }, job.number), " ", job.title),
        isBlocked
            ? h(
                  "div",
                  null,
                  h("span", { class: "badge badge-blocked" }, "Blocked"),
                  h("p", { class: "reason" }, blockedText(job)),
              )
            : null,
    );
};

type ColumnProps = { status: BoardStatus; jobs: BoardJob[]; hasMore: boolean; onMore: () => void };

const Column = ({ status, jobs, hasMore, onMore }: ColumnProps) =>
    h(
        "section",
        { class: "board-column", "data-status": status },
        h("h3", null, LABELS[status]),
        h("ul", { class: "list" }, ...jobs.map((job) => h(JobCard, { job, key: job.number }))),
        hasMore
            ? h("button", { type: "button", class: "button button-secondary", onClick: onMore }, "Load more")
            : null,
    );

/** The Board: four columns of job cards, kept current by the instance feed. */
export const BoardPage = ({ feed }: { feed: FeedConnection | null | undefined }) => {
    const [view, setView] = useState<BoardView>(EMPTY_VIEW);
    const controller = useRef<BoardController>(undefined);
    controller.current ??= createBoardController(setView);
    const board = controller.current;

    useEffect(() => {
        // `undefined` means the tab is still connecting: asking the worker for deltas comes before the read.
        if (feed === undefined) return;
        mountedBoard = board;
        if (feed !== null) attachFeed(feed);
        void board.reload();
        return () => {
            if (mountedBoard === board) mountedBoard = undefined;
        };
    }, [feed, board]);

    const isEmpty = view.isLoaded && view.columns.every((column) => column.jobs.length === 0);
    return h(
        "div",
        { class: "board" },
        view.failure !== undefined ? h("div", { class: "error", role: "alert" }, view.failure) : null,
        isEmpty
            ? h("p", null, "No jobs yet. ", h("a", { href: "#/desk" }, "Ask the Front desk"), " to start one.")
            : null,
        h(
            "div",
            { class: "board-columns" },
            ...view.columns.map((column) =>
                h(Column, {
                    key: column.status,
                    status: column.status,
                    jobs: column.jobs,
                    hasMore: column.status === "done" && view.doneCursor !== undefined,
                    onMore: () => void board.loadMoreDone(),
                }),
            ),
        ),
    );
};
