/**
 * Steering (S-001 R-10a, R-17): a team member or an agent injects a message into a conversation, and the transcript
 * records who steered. A running conversation picks the message up after its current tool round (steer) or after its
 * run ends (follow-up); an idle one takes it as input; a parked one holds it in its `intern.conversation` document, so
 * the message survives a restart, and `continueParked` delivers it.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type ConversationId, defineEntry } from "@earendil-works/pi-durable";
import { HostNotFoundError } from "./conversation_control.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import { conversationMetaDoc, type HeldMessage, type SeatActor } from "./seating.ts";

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

// The check and the hold are one commit, so a conversation that continues in between is never left holding a message.
// A repeated request id holds nothing twice and writes no second record.
async function holdIfParked(host: HarnessHost, conversationId: ConversationId, input: SteerInput): Promise<boolean> {
    return internalHarness(host).commit(async (tx) => {
        const meta = await tx.doc(conversationMetaDoc, conversationId);
        if (meta.parked === null) return false;
        if (meta.held.some((message) => message.requestId === input.requestId)) return true;
        meta.held.push(toStoredJson({ ...input }));
        const record: SteerRecord = { actor: input.actor, mode: input.mode };
        await tx.appendEntry(steerRecordEntry, conversationId, { data: toStoredJson(record) as never });
        return true;
    }, context);
}

/**
 * Steers the target conversation. Returns `held: true` when the target is parked and the message waits for it to
 * continue, with no submission. Otherwise an `intern.steer` entry naming the actor is written first, then the message
 * is submitted as input. pi-durable cannot write both in one commit, so each carries a request id derived from the
 * message's own: a repeated call after a crash between them adds neither twice.
 */
export async function steerConversation(
    host: HarnessHost,
    targetId: string,
    input: SteerInput,
): Promise<{ held: boolean; submissionId?: string }> {
    const conversation = await requireConversation(host, targetId);
    if (await holdIfParked(host, conversation.id, input)) return { held: true };
    const record: SteerRecord = { actor: input.actor, mode: input.mode };
    await conversation.submit(
        {
            type: "write",
            entry: { kind: STEER_RECORD_KIND, data: toStoredJson(record) as never },
            requestId: `${input.requestId}:steer`,
        },
        context,
    );
    const submission = await conversation.submit(
        { type: "input", content: input.content, requestId: input.requestId, whenBusy: input.mode },
        context,
    );
    return { held: false, submissionId: String(submission.id) };
}
