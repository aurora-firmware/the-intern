/**
 * Seating (S-001 R-4, R-5, R-7, R-12, R-17): the only path that changes a conversation's seat. The seat goes into the
 * conversation's pi-durable agent, a snapshot of it and the job links into the `intern.conversation` document, and a
 * seat record into the transcript, all in one commit, so a seat is never applied without its record.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type ConversationId,
    configure,
    defineDoc,
    defineEntry,
    InboxDoc,
    LiveDoc,
    ResetEntry,
    type ToolRegistration,
    type Tx,
} from "@earendil-works/pi-durable";
import type { Seat } from "../roles/role_model.ts";
import { type HarnessHost, internalHarness, toAgentSpec } from "./harness_host.ts";
import { createConversationOnce } from "./idempotency.ts";

export const CONVERSATION_META_KIND = "intern.conversation";
export const SEAT_RECORD_KIND = "intern.seat";

export type SeatActor =
    | { kind: "team_member"; wayIn: string }
    | { kind: "agent"; conversationId: string; role: string }
    | { kind: "job_source"; source: string };

export type Origin =
    | { kind: "request"; wayIn: string }
    | { kind: "schedule"; entry: string; fireTime: string }
    | { kind: "trigger"; trigger: string; event: string }
    | { kind: "follow_up"; conversationId: string }
    | { kind: "invocation"; conversationId: string };

export type ContextMode = "full" | "compact" | "clean";
export type ParkedState = { waitingFor: "reports" | "answer"; continueOn: "each" | "all" };
// A held message without `kind` is a steer or follow-up; a held report names its kind.
export type HeldMessage = {
    content: string;
    mode: "steer" | "followUp";
    actor: SeatActor;
    requestId: string;
    kind?: "intern.report";
};
export type SeatSummary = { role: string; model: string; thinkingLevel?: string; workspace: string };
export type SeatRecord = {
    previous: SeatSummary | null;
    next: SeatSummary;
    actor: SeatActor;
    contextMode?: ContextMode;
    note?: string;
};
export type JobLinks = { jobId: string; isLead: boolean; origin: Origin; depth: number; invokedBy?: string };
export type ConversationMeta = JobLinks & {
    seat: Seat;
    awaiting: string[];
    parked: ParkedState | null;
    held: HeldMessage[];
    aborted: boolean;
};
export type SeatChange = { seat: Seat; actor: SeatActor; contextMode?: ContextMode; note?: string };

const context = BACKGROUND_CONTEXT;

// A document that was never written reads as this placeholder, which has no job id; no committed conversation keeps it.
const unsetMeta = (): ConversationMeta => ({
    jobId: "",
    isLead: false,
    origin: { kind: "request", wayIn: "" },
    depth: 0,
    seat: { role: "", model: "", workspace: "", instructions: "", tools: [], skills: [] },
    awaiting: [],
    parked: null,
    held: [],
    aborted: false,
});

// Latest-only: only the current value is read, and the transcript's seat records are the history. A fork starts from
// the initial value: pi-durable rejects writes to a fork source's current-policy documents in the fork commit, which
// the invoker's `awaiting` and `parked` need, and a fork must not inherit the invoker's job links.
export const conversationMetaDoc = defineDoc<ConversationMeta>({
    kind: CONVERSATION_META_KIND,
    version: 1,
    scope: "conversation",
    history: "latest",
    fork: "initial",
    initial: unsetMeta,
    checkpointWhen: () => false,
});

const seatRecordEntry = defineEntry<SeatRecord>(SEAT_RECORD_KIND);

export class SeatingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SeatingError";
    }
}

// Stored values are JSON: this drops the undefined fields an optional property can carry.
function toStoredJson<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function summarize(seat: Seat): SeatSummary {
    return {
        role: seat.role,
        model: seat.model,
        ...(seat.thinkingLevel !== undefined && { thinkingLevel: seat.thinkingLevel }),
        workspace: seat.workspace,
    };
}

function toNumericId(conversationId: string): ConversationId {
    return Number(conversationId) as ConversationId;
}

// pi-durable stores a tool selection by name and reads only `name` from each registration, so a name is enough.
function toToolSelection(names: readonly string[]): ToolRegistration[] {
    return names.map((name) => ({ name }) as ToolRegistration);
}

async function writeSeat(
    tx: Tx,
    conversationId: string,
    change: SeatChange,
    meta: ConversationMeta,
    previous: Seat | null,
): Promise<void> {
    const { seat } = change;
    const id = toNumericId(conversationId);
    await configure(tx, id, {
        ...toAgentSpec({ model: seat.model, cwd: seat.workspace }),
        thinkingLevel: (seat.thinkingLevel ?? null) as never,
        tools: toToolSelection(seat.tools),
    });
    meta.seat = toStoredJson(seat);
    const record: SeatRecord = {
        previous: previous === null ? null : summarize(previous),
        next: summarize(seat),
        actor: change.actor,
        ...(change.contextMode !== undefined && { contextMode: change.contextMode }),
        ...(change.note !== undefined && { note: change.note }),
    };
    await tx.appendEntry(seatRecordEntry, id, { data: toStoredJson(record) as never });
}

/** Makes the writes of a seat change in the caller's transaction: agent, document seat and seat record. */
export async function seatWrites(tx: Tx, conversationId: string, change: SeatChange): Promise<void> {
    const meta = await tx.doc(conversationMetaDoc, toNumericId(conversationId));
    if (meta.jobId === "") {
        throw new SeatingError(`Conversation "${conversationId}" was not created by createSeatedConversation.`);
    }
    // A conversation whose document still holds the unset placeholder seat has no earlier seat to record.
    const previous = meta.seat.model === "" ? null : (meta.seat as Seat);
    await writeSeat(tx, conversationId, change, meta as ConversationMeta, previous);
}

/** Creates the conversation for `scope` and `key` once, seated, with its job links and first seat record. */
export async function createSeatedConversation(
    host: HarnessHost,
    input: { scope: string; key: string; job: JobLinks; seat: Seat; actor: SeatActor },
): Promise<{ conversationId: string; created: boolean }> {
    const { scope, key, job, seat, actor } = input;
    return createConversationOnce(host, {
        scope,
        key,
        agent: {
            model: seat.model,
            ...(seat.thinkingLevel !== undefined && { thinkingLevel: seat.thinkingLevel }),
            cwd: seat.workspace,
        },
        init: async (tx, conversationId) => {
            const meta = await tx.doc(conversationMetaDoc, toNumericId(conversationId));
            Object.assign(meta, toStoredJson(job));
            await writeSeat(tx, conversationId, { seat, actor }, meta as ConversationMeta, null);
        },
    });
}

/** Changes the conversation's seat in one commit. A model turn that is running finishes with the old seat. */
export async function changeSeat(host: HarnessHost, conversationId: string, change: SeatChange): Promise<void> {
    await internalHarness(host).commit((tx) => seatWrites(tx, conversationId, change), context);
}

/**
 * Resets the conversation's context and changes its seat in one commit, so the new seat and its record never exist
 * without the reset. The reset entry is the one `Conversation.reset` writes, with the note as the start of the new
 * context; the earlier entries stay in the transcript. While a model turn is running the reset is queued in the
 * inbox, as pi-durable's admission does, so it lands at the turn boundary and the turn's answer stays before it.
 */
export async function resetWithSeat(
    host: HarnessHost,
    conversationId: string,
    input: { note?: string; change: SeatChange },
): Promise<void> {
    const { note, change } = input;
    const id = toNumericId(conversationId);
    await internalHarness(host).commit(async (tx) => {
        // The live state is read before any table write, as pi-durable's admission does.
        const isBusy = (await tx.doc(LiveDoc, id)).run !== undefined;
        await seatWrites(tx, conversationId, change);
        const model = note === undefined ? {} : { model: [{ role: "user", content: note, timestamp: Date.now() }] };
        const draft = { head: "self", ...model };
        if (!isBusy) {
            await tx.appendEntry(ResetEntry, id, draft as never);
            return;
        }
        const submission = await tx.createSubmission({ conversationId: id, type: "write", status: "queued" });
        (await tx.doc(InboxDoc, id)).items.push({
            id: submission.id,
            mode: "write",
            entry: { kind: ResetEntry.kind, ...draft },
        } as never);
    }, context);
}

export async function readConversationMeta(
    host: HarnessHost,
    conversationId: string,
): Promise<ConversationMeta | undefined> {
    const stored = await internalHarness(host).snapshot(conversationMetaDoc, toNumericId(conversationId), context);
    return stored === undefined || stored.jobId === "" ? undefined : (stored as ConversationMeta);
}
