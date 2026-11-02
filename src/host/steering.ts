/**
 * Steering (S-001 REQ-020, REQ-017): a team member or an agent injects a message into a conversation, and the
 * transcript records who steered. A running conversation picks the message up after its current tool round (steer) or
 * after its run ends (follow-up); an idle one takes it as input; one parked for reports holds it in its
 * `intern.conversation` document, so the message survives a restart, and `continueParked` delivers it.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineEntry } from "@earendil-works/pi-durable";
import { HostNotFoundError, notifyInputSubmitted, submissionIdFor } from "./conversation_control.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import { continueParked } from "./invocation.ts";
import { conversationMetaDoc, type HeldMessage, readConversationMeta, type SeatActor } from "./seating.ts";

export const STEER_RECORD_KIND = "intern.steer";

export type SteerMode = HeldMessage["mode"];
export type SteerInput = { content: string; mode: SteerMode; actor: SeatActor; requestId: string };
export type SteerRecord = { actor: SeatActor; mode: SteerMode };

const context = BACKGROUND_CONTEXT;
const steerRecordEntry = defineEntry<SteerRecord>(STEER_RECORD_KIND);

// Stored values are JSON: this drops the undefined fields an optional property can carry.
const toStoredJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function requireConversation(host: HarnessHost, targetId: string) {
    const numericId = /^\d+$/.test(targetId) ? (Number(targetId) as ConversationId) : undefined;
    const conversation =
        numericId === undefined ? undefined : await internalHarness(host).conversation(numericId, context);
    if (conversation === undefined) throw new HostNotFoundError(`Conversation "${targetId}" does not exist.`);
    return conversation;
}

// Only a conversation parked for reports holds a message; one parked for an answer continues with it instead.
// The check and the hold are one commit, so a conversation that continues in between is never left holding a message.
// A repeated request id holds nothing twice and writes no second record.
async function holdIfParked(host: HarnessHost, conversationId: ConversationId, input: SteerInput): Promise<boolean> {
    return internalHarness(host).commit(async (tx) => {
        const meta = await tx.doc(conversationMetaDoc, conversationId);
        if (meta.parked?.waitingFor !== "reports") return false;
        if (meta.held.some((message) => message.requestId === input.requestId)) return true;
        meta.held.push(toStoredJson({ ...input }));
        const record: SteerRecord = { actor: input.actor, mode: input.mode };
        await tx.appendEntry(steerRecordEntry, conversationId, { data: toStoredJson(record) as never });
        return true;
    }, context);
}

/**
 * Holds the message when the target conversation is parked for reports, whatever busy mode the caller chose. Returns
 * `false` and writes nothing when the target is not parked for reports, so the caller submits the message as input.
 */
export async function holdForParked(host: HarnessHost, targetId: string, input: SteerInput): Promise<boolean> {
    const conversation = await requireConversation(host, targetId);
    return holdIfParked(host, conversation.id, input);
}

/**
 * Steers the target conversation. Returns `held: true` when the target is parked and the message waits for it to
 * continue, with no submission. A target parked for an answer (its job is Blocked) continues with the message.
 * Otherwise the message is submitted as input. Either way it is placed as the `intern.steer` entry itself (its data
 * names the actor and keeps the text), so the record and the message are one commit.
 */
export async function steerConversation(
    host: HarnessHost,
    targetId: string,
    input: SteerInput,
): Promise<{ held: boolean; submissionId?: string }> {
    const conversation = await requireConversation(host, targetId);
    if (await holdIfParked(host, conversation.id, input)) return { held: true };
    const placed: SteerRecord & { content: string } = { actor: input.actor, mode: input.mode, content: input.content };
    const entry = { kind: STEER_RECORD_KIND, data: toStoredJson(placed) as never };
    if ((await readConversationMeta(host, String(conversation.id)))?.parked?.waitingFor === "answer") {
        return { held: false, ...(await continueParked(host, String(conversation.id), { ...input, entry })) };
    }
    // A repeated request id places nothing, so no input listener hears of it.
    const isRepeat = (await submissionIdFor(host, String(conversation.id), input.requestId)) !== undefined;
    const submission = await conversation.submit(
        {
            type: "input",
            content: input.content,
            requestId: input.requestId,
            whenBusy: input.mode,
            entry,
        },
        context,
    );
    if (!isRepeat) {
        await notifyInputSubmitted(host, { conversationId: String(conversation.id), requestId: input.requestId });
    }
    return { held: false, submissionId: String(submission.id) };
}
