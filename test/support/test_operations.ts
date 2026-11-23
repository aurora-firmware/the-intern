/**
 * Control operations that exist only for the process-level tests (`test/support/daemon_child.ts` adds them to the
 * daemon). They are not part of the product's catalogue.
 */
import type { ServiceContext } from "../../src/daemon/daemon.ts";
import { createConversationOnce } from "../../src/host/idempotency.ts";
import { defineOperation, type Operation } from "../../src/service/operations.ts";

const CONVERSATION_SCOPE = "test";

export type StorageSwitch = { isFailing: boolean };

export type TestOperationsOptions = {
    storageSwitch: StorageSwitch;
    /** The model new conversations use; read when the operation runs, since the models exist only after startup. */
    modelFor(ctx: ServiceContext): string;
};

type CreateConversationInput = { key: string; cwd: string };

function parseCreateConversation(raw: unknown): CreateConversationInput {
    const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
    const { key, cwd } = record;
    if (typeof key !== "string" || key === "") throw new Error("key must be a non-empty string");
    if (typeof cwd !== "string" || cwd === "") throw new Error("cwd must be a non-empty string");
    return { key, cwd };
}

// biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
export function createTestOperations(options: TestOperationsOptions): Operation<ServiceContext, any, any>[] {
    const createConversation = defineOperation<
        ServiceContext,
        CreateConversationInput,
        { conversationId: string; created: boolean }
    >({
        name: "test.createConversation",
        kind: "control",
        parse: parseCreateConversation,
        run: (ctx, { key, cwd }) =>
            createConversationOnce(ctx.host, {
                scope: CONVERSATION_SCOPE,
                key,
                agent: { model: options.modelFor(ctx), cwd },
            }),
    });
    const failStorage = defineOperation<ServiceContext, Record<string, never>, Record<string, never>>({
        name: "test.failStorage",
        kind: "control",
        parse: () => ({}),
        async run() {
            options.storageSwitch.isFailing = true;
            return {};
        },
    });
    return [createConversation, failStorage];
}
