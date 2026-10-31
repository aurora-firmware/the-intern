/**
 * Idempotency keys for operations that create a conversation (S-002 R-13). The key is recorded in the session-wide
 * document `intern.idempotency`, in the same commit that creates the conversation, so a crash leaves neither or both.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc, type Tx } from "@earendil-works/pi-durable";
import { type AgentChoice, type HarnessHost, internalHarness, toAgentSpec } from "./harness_host.ts";

const context = BACKGROUND_CONTEXT;
const MAX_KEY_LENGTH = 200;

export class HostInvalidKeyError extends Error {
    constructor(scope: string, length: number) {
        super(`The idempotency key for "${scope}" has ${length} characters; it must have 1 to ${MAX_KEY_LENGTH}.`);
        this.name = "HostInvalidKeyError";
    }
}

// Maps a scope and key (as a JSON pair, so no separator can make two pairs collide) to the conversation it created.
const idempotencyDocument = defineDoc<{ conversations: Record<string, string> }>({
    kind: "intern.idempotency",
    version: 1,
    scope: "session",
    initial: () => ({ conversations: {} }),
    checkpointWhen: () => false,
});

// One lookup-then-create at a time per host, so concurrent calls with one key can't both miss the lookup.
const pendingCreates = new WeakMap<HarnessHost, Promise<unknown>>();

async function lookupOrCreate(
    host: HarnessHost,
    entryKey: string,
    agent: AgentChoice,
    init: ConversationInit | undefined,
): Promise<{ conversationId: string; created: boolean }> {
    const harness = internalHarness(host);
    const stored = (await harness.snapshot(idempotencyDocument, context))?.conversations[entryKey];
    if (stored !== undefined) return { conversationId: stored, created: false };

    const conversation = await harness.createConversation(
        {
            ownership: { kind: "ownerless" },
            agent: toAgentSpec(agent),
            init: async (tx, conversationId) => {
                const draft = await tx.doc(idempotencyDocument);
                draft.conversations[entryKey] = String(conversationId);
                await init?.(tx, String(conversationId));
            },
        },
        context,
    );
    return { conversationId: String(conversation.id), created: true };
}

/** Runs in the commit that creates the conversation, so its writes exist exactly when the conversation does. */
export type ConversationInit = (tx: Tx, conversationId: string) => Promise<void>;

/**
 * Creates the conversation for `scope` and `key` once; a repeated call returns the original with `created: false`.
 * The optional `init` runs only for a new conversation, in the same commit.
 */
export async function createConversationOnce(
    host: HarnessHost,
    input: { scope: string; key: string; agent: AgentChoice; init?: ConversationInit },
): Promise<{ conversationId: string; created: boolean }> {
    const { scope, key, agent, init } = input;
    if (key.length < 1 || key.length > MAX_KEY_LENGTH) throw new HostInvalidKeyError(scope, key.length);

    const previous = pendingCreates.get(host) ?? Promise.resolve();
    const result = previous.then(() => lookupOrCreate(host, JSON.stringify([scope, key]), agent, init));
    pendingCreates.set(
        host,
        result.catch(() => undefined),
    );
    return result;
}
