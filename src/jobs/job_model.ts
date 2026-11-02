// Pure core of the job model (S-004): the decisions the store, the operations, the tools and the turn-end rule
// share. It imports neither pi-durable nor any I/O.

export type JobStatus = "to_do" | "in_progress" | "blocked" | "done";
export type JobAction = "start" | "block" | "resume" | "complete" | "cancel";
export type Letter = "C" | "W" | "E" | "S" | "T" | "A";
export type Resolution = { kind: "completed" | "cancelled"; justification: string };

export type ObservedDetails = { remoteAddress?: string; remotePort?: number; messageId?: string; sender?: string };

export type JobAuthor =
    | { kind: "agent"; conversationId: string; role: string }
    | { kind: "team_member"; wayIn: string; observed?: ObservedDetails }
    | { kind: "daemon" };

export type JobOrigin =
    | { kind: "request"; wayIn: string; observed?: ObservedDetails }
    | { kind: "schedule"; entry: string; fireTime: string }
    | { kind: "trigger"; trigger: string; event: string }
    | { kind: "follow_up"; jobId: string; conversationId: string };

const REQUEST_LETTERS: Readonly<Record<string, Letter>> = { "command line": "C", "web interface": "W", email: "E" };
const LETTERS: readonly string[] = ["C", "W", "E", "S", "T", "A"];
const SHORT_NUMBER_PATTERN = /^([A-Za-z])-([1-9][0-9]*)$/;

export const letterFor = (origin: JobOrigin): Letter | undefined => {
    switch (origin.kind) {
        case "request":
            return Object.hasOwn(REQUEST_LETTERS, origin.wayIn) ? REQUEST_LETTERS[origin.wayIn] : undefined;
        case "schedule":
            return "S";
        case "trigger":
            return "T";
        case "follow_up":
            return "A";
    }
};

export const formatNumber = (letter: Letter, n: number): string => `${letter}-${n}`;

export const parseJobRef = (text: string): { letter: Letter; n: number } | { id: string } => {
    const match = SHORT_NUMBER_PATTERN.exec(text);
    const letter = match?.[1]?.toUpperCase();
    if (match && letter && LETTERS.includes(letter)) {
        return { letter: letter as Letter, n: Number(match[2]) };
    }
    return { id: text };
};

export type ActionInput = {
    blockedReason?: string;
    justification?: string;
    definitionOfDone?: string;
    activeInvocation?: string;
    /** The ID of the lead's newest transcript entry when the block is written. */
    blockedAfterEntry?: string;
};

export type JobCheck =
    | { ok: true; to: JobStatus }
    | { ok: false; code: "conflict" | "invalid_input"; field?: string; message: string };

const TRANSITIONS: Readonly<Record<JobAction, Readonly<Partial<Record<JobStatus, JobStatus>>>>> = {
    start: { to_do: "in_progress" },
    block: { in_progress: "blocked" },
    resume: { blocked: "in_progress" },
    complete: { in_progress: "done" },
    cancel: { to_do: "done", in_progress: "done", blocked: "done" },
};

const isEmpty = (value: string | undefined): boolean => value === undefined || value.trim() === "";

const invalid = (field: string, message: string): JobCheck => ({ ok: false, code: "invalid_input", field, message });

const guardFailure = (action: JobAction, input: ActionInput): JobCheck | undefined => {
    if (action === "block") {
        if (isEmpty(input.blockedReason)) return invalid("blockedReason", "block needs a non-empty blockedReason");
        if (input.activeInvocation !== undefined) {
            return invalid(
                "activeInvocation",
                `block refused: invocation ${input.activeInvocation} is still running or awaited`,
            );
        }
    }
    if (action === "complete") {
        if (isEmpty(input.definitionOfDone)) {
            return invalid("definitionOfDone", "complete needs a non-empty definition of done");
        }
        if (isEmpty(input.justification)) return invalid("justification", "complete needs a non-empty justification");
    }
    if (action === "cancel" && isEmpty(input.justification)) {
        return invalid("justification", "cancel needs a non-empty justification");
    }
    return undefined;
};

export const checkAction = (status: JobStatus, action: JobAction, input: ActionInput): JobCheck => {
    if (status === "done") {
        return { ok: false, code: "conflict", message: `${action} refused: the job is Done and Done is final` };
    }
    const to = TRANSITIONS[action][status];
    if (to === undefined) {
        return { ok: false, code: "conflict", message: `${action} is not possible from status ${status}` };
    }
    return guardFailure(action, input) ?? { ok: true, to };
};

export const EDITABLE_FIELDS = ["title", "description", "definitionOfDone"] as const;
export type EditableField = (typeof EDITABLE_FIELDS)[number];

export const checkEdit = (status: JobStatus, names: readonly string[]): JobCheck => {
    if (status === "done") {
        return { ok: false, code: "conflict", message: "edit refused: the job is Done and Done is final" };
    }
    const other = names.find((name) => !(EDITABLE_FIELDS as readonly string[]).includes(name));
    if (other !== undefined) {
        return invalid(other, `${other} is not an editable field (editable: ${EDITABLE_FIELDS.join(", ")})`);
    }
    return { ok: true, to: status };
};

export type TurnEndDecision = { kind: "remind" } | { kind: "block"; reason: string };

export const turnEndDecision = (input: { definitionOfDone: string; isReminderSpent: boolean }): TurnEndDecision => {
    if (isEmpty(input.definitionOfDone)) return { kind: "block", reason: "no definition of done" };
    if (!input.isReminderSpent) return { kind: "remind" };
    return { kind: "block", reason: "the lead stopped without completing or blocking" };
};

export const reminderRequestId = (jobId: string, n: number): string => `reminder:${jobId}:${n}`;
export const resumeRequestId = (jobId: string, n: number): string => `resume:${jobId}:${n}`;

export const blockResumeCount = (history: readonly { field: string; old: unknown; new: unknown }[]): number =>
    history.filter((entry) => entry.field === "status" && (entry.old === "blocked" || entry.new === "blocked")).length;

export const JOB_TOOL_NAMES = [
    "read_job",
    "update_job",
    "add_worklog",
    "create_job",
    "relate_jobs",
    "block_job",
    "complete_job",
] as const;
