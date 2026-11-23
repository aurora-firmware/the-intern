/**
 * The Board's decision logic (S-006 REQ-002): which column a job sits in, how an instance feed delta moves or changes
 * a card, and how older Done jobs join the column. It imports nothing, so Node tests it without a DOM.
 */

export type BoardStatus = "to_do" | "in_progress" | "blocked" | "done";

/** The part of a job the Board holds. */
export type BoardJob = {
    number: string;
    title: string;
    status: BoardStatus;
    description?: string;
    definitionOfDone?: string;
    blockedReason?: string;
};

export type BoardColumn = { status: BoardStatus; jobs: BoardJob[] };

/** The four columns, in the order the Board shows them. */
export type BoardState = BoardColumn[];

/** How a job ended, as the feed's `job_done` delta carries it. */
export type BoardResolution = { kind: "completed" | "cancelled"; justification: string };

/** The job deltas of the instance feed. Declared here so the Board imports no daemon type. */
export type JobDelta =
    | { type: "job_created"; job: BoardJob }
    | {
          type: "job_changed";
          number: string;
          fields: Partial<Pick<BoardJob, "title" | "description" | "definitionOfDone">>;
      }
    | { type: "job_status_changed"; number: string; old: BoardStatus; new: BoardStatus; blockedReason?: string }
    | { type: "job_done"; number: string; resolution: BoardResolution }
    | { type: "job_related_changed"; numbers: [string, string] };

const COLUMN_ORDER: readonly BoardStatus[] = ["to_do", "in_progress", "blocked", "done"];

const BLOCKED_TEXT_LIMIT = 120;

/** Sorts jobs into the four columns, keeping the order they came in. */
export const boardColumns = (jobs: readonly BoardJob[]): BoardState =>
    COLUMN_ORDER.map((status) => ({ status, jobs: jobs.filter((entry) => entry.status === status) }));

const findJob = (state: BoardState, number: string): BoardJob | undefined =>
    state.flatMap((column) => column.jobs).find((entry) => entry.number === number);

const withoutJob = (state: BoardState, number: string): BoardState =>
    state.map((column) => ({ status: column.status, jobs: column.jobs.filter((entry) => entry.number !== number) }));

/** Puts a job in the column of its status: the front of Done, the end of any other. */
const placeJob = (state: BoardState, placed: BoardJob): BoardState =>
    state.map((column) => {
        if (column.status !== placed.status) {
            return column;
        }
        return {
            status: column.status,
            jobs: placed.status === "done" ? [placed, ...column.jobs] : [...column.jobs, placed],
        };
    });

const moveJob = (state: BoardState, number: string, change: Partial<BoardJob>): BoardState => {
    const held = findJob(state, number);
    if (held === undefined) {
        return state;
    }
    const { blockedReason: _dropped, ...rest } = held;
    return placeJob(withoutJob(state, number), { ...rest, ...change });
};

const changeJob = (state: BoardState, number: string, change: Partial<BoardJob>): BoardState =>
    state.map((column) => ({
        status: column.status,
        jobs: column.jobs.map((entry) => (entry.number === number ? { ...entry, ...change } : entry)),
    }));

/** Applies one instance feed delta. A job the board doesn't hold is ignored, and nothing is read. */
export const applyJobDelta = (state: BoardState, delta: JobDelta): BoardState => {
    switch (delta.type) {
        case "job_created":
            return findJob(state, delta.job.number) === undefined ? placeJob(state, delta.job) : state;
        case "job_changed":
            return changeJob(state, delta.number, delta.fields);
        case "job_status_changed": {
            const reason =
                delta.new === "blocked" && delta.blockedReason !== undefined
                    ? { blockedReason: delta.blockedReason }
                    : {};
            return moveJob(state, delta.number, { status: delta.new, ...reason });
        }
        case "job_done":
            return moveJob(state, delta.number, { status: "done" });
        case "job_related_changed":
            return state;
    }
};

/** Adds older Done jobs after the ones held, each short number once. */
export const addDoneJobs = (state: BoardState, older: readonly BoardJob[]): BoardState =>
    state.map((column) => {
        if (column.status !== "done") {
            return column;
        }
        const held = new Set(column.jobs.map((entry) => entry.number));
        const added: BoardJob[] = [];
        for (const entry of older) {
            if (!held.has(entry.number)) {
                held.add(entry.number);
                added.push({ ...entry, status: "done" });
            }
        }
        return { status: column.status, jobs: [...column.jobs, ...added] };
    });

/** The Blocked reason, or the start of it when it is long. */
export const blockedText = (blocked: BoardJob): string => {
    const reason = blocked.blockedReason ?? "";
    return reason.length <= BLOCKED_TEXT_LIMIT ? reason : `${reason.slice(0, BLOCKED_TEXT_LIMIT)}…`;
};
