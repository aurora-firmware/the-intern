/**
 * The workspace operations (S-002 R-12, R-22): list the registered workspaces, and register and unregister one. Each
 * change is validated by the workspace registry, written to the configuration file first and applied at once.
 */
import type { AgentsComponent } from "../agents/agents_component.ts";
import { ConfigChangeRefused } from "../config/config_writer.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { HostInvalidKeyError, settingsResultOnce } from "../host/idempotency.ts";
import { WorkspaceFolderError } from "../workspaces/workspace_folder.ts";
import { type WorkspaceListing, WorkspaceRefusedError } from "../workspaces/workspace_registry.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

type RegisterInput = { path: string; idempotencyKey?: string };
type PathInput = { path: string };

const REGISTER_SCOPE = "workspaces.register";

function asRecord(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    return raw as Record<string, unknown>;
}

function requirePath(record: Record<string, unknown>): string {
    const { path } = record;
    if (typeof path !== "string" || path === "") throw new Error("path must be a non-empty string");
    return path;
}

function parseRegister(raw: unknown): RegisterInput {
    const record = asRecord(raw);
    const path = requirePath(record);
    const { idempotencyKey } = record;
    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
        throw new Error("idempotencyKey must be a string");
    }
    return idempotencyKey === undefined ? { path } : { path, idempotencyKey };
}

const parsePath = (raw: unknown): PathInput => ({ path: requirePath(asRecord(raw)) });

async function mappingRefusals<T>(action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        if (error instanceof WorkspaceFolderError) throw new ServiceError("invalid_input", error.message);
        if (error instanceof WorkspaceRefusedError) throw new ServiceError("conflict", error.message);
        if (error instanceof ConfigChangeRefused) {
            const codes = { invalid: "invalid_input", conflict: "conflict", write_failed: "internal" } as const;
            throw new ServiceError(codes[error.kind], error.message);
        }
        if (error instanceof HostInvalidKeyError) throw new ServiceError("invalid_input", error.message);
        throw error;
    }
}

export function workspaceOperations(component: AgentsComponent) {
    const registry = () => component.runtime().workspaces;

    const listOperation = defineOperation<ServiceContext, Record<string, never>, { workspaces: WorkspaceListing[] }>({
        name: "workspaces.list",
        kind: "read",
        parse: () => ({}),
        run: async () => ({ workspaces: registry().list() }),
    });

    // Registering is idempotent by path, so a repeat after a crash between the file write and the key writes nothing.
    const register = async (path: string): Promise<{ path: string }> => {
        await registry().register(path);
        return { path };
    };

    const registerOperation = defineOperation<ServiceContext, RegisterInput, { path: string }>({
        name: "workspaces.register",
        kind: "control",
        parse: parseRegister,
        run: ({ host }, { path, idempotencyKey }) =>
            mappingRefusals(() =>
                idempotencyKey === undefined
                    ? register(path)
                    : settingsResultOnce(host, { scope: REGISTER_SCOPE, key: idempotencyKey }, () => register(path)),
            ),
    });

    const unregisterOperation = defineOperation<ServiceContext, PathInput, Record<string, never>>({
        name: "workspaces.unregister",
        kind: "control",
        parse: parsePath,
        run: (_ctx, { path }) =>
            mappingRefusals(async () => {
                await registry().unregister(path);
                return {};
            }),
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [listOperation, registerOperation, unregisterOperation];
    return operations;
}
