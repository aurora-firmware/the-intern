/**
 * The subscribe operation (S-002 REQ-012, REQ-014): it returns the in-process subscription to the instance feed or to
 * one conversation's feed. S-003's listeners carry the subscription to clients.
 */
import type { InstanceFeed } from "../feed/instance_feed.ts";
import type { ObservationFeed, Subscription } from "../feed/observation_feed.ts";
import { HostNotFoundError } from "../host/conversation_control.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

type FeedContext = { feed: ObservationFeed; instanceFeed: InstanceFeed; host: HarnessHost };
type SubscribeInput = { scope: "instance" } | { scope: "conversation"; conversationId: string };

function parseSubscribe(raw: unknown): SubscribeInput {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    const { scope, conversationId } = raw as Record<string, unknown>;
    if (scope === "instance") return { scope };
    if (scope !== "conversation") throw new Error('scope must be "instance" or "conversation"');
    if (typeof conversationId !== "string" || conversationId === "")
        throw new Error("conversationId must be a non-empty string");
    return { scope, conversationId };
}

const subscribeOperation = defineOperation<FeedContext, SubscribeInput, Subscription<unknown, unknown>>({
    name: "feed.subscribe",
    kind: "read",
    parse: parseSubscribe,
    async run({ feed, instanceFeed }, input) {
        if (input.scope === "instance") return instanceFeed.subscribe();
        try {
            return await feed.subscribeConversation(input.conversationId);
        } catch (error) {
            if (error instanceof HostNotFoundError) throw new ServiceError("not_found", error.message);
            throw error;
        }
    },
});

// biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
export const feedOperations: readonly Operation<FeedContext, any, any>[] = [subscribeOperation];
