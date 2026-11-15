/**
 * The instructions operations: `instructions.list` (S-008 REQ-009) names the files an agent's prompt is built from, in
 * the order the prompt reads them, with whether each ships with the product, was edited and is missing. It returns no
 * file text. `instructions.restore` (REQ-003) copies the installed common prompt or a shipped role's instructions back.
 */

import { access } from "node:fs/promises";
import type { ServiceContext } from "../daemon/daemon.ts";
import { type ConversationMeta, readConversationMeta } from "../host/seating.ts";
import { readPromptParts } from "../prompt/prompt_sources.ts";
import { SHIPPED_ROLE_NAMES } from "../roles/shipped_roles.ts";
import {
    commonPromptPath,
    NotShippedError,
    restoreShippedFile,
    roleInstructionPath,
    type ShippedFileState,
    shippedFileStates,
} from "../skills/internal_folder.ts";
import type { SkillsComponent } from "../skills/skills_component.ts";
import { roleWorkspacePath } from "../workspaces/workspace_folder.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

type ListInput = { role: string } | { conversation: string };

type InstructionFile = {
    kind: "common" | "role" | "workspace";
    path: string;
    shipped: boolean;
    edited: boolean;
    missing: boolean;
};

type RestoreInput = { name: string };

function parseRestore(raw: unknown): RestoreInput {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    const { name } = raw as Record<string, unknown>;
    if (typeof name !== "string" || name === "") throw new Error("name must be a non-empty string");
    return { name };
}

function parseList(raw: unknown): ListInput {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    const { role, conversation } = raw as Record<string, unknown>;
    if ((role === undefined) === (conversation === undefined)) {
        throw new Error("give exactly one of role or conversation");
    }
    if (role !== undefined) {
        if (typeof role !== "string" || role === "") throw new Error("role must be a non-empty string");
        return { role };
    }
    if (typeof conversation !== "string" || conversation === "") {
        throw new Error("conversation must be a non-empty string");
    }
    return { conversation };
}

async function exists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

/** The shipped instruction file a restore name stands for, or undefined when no shipped file has that name. */
function shippedInstruction(name: string): { kind: "common" | "role"; shippedName: string } | undefined {
    if (name === "common") return { kind: "common", shippedName: "instructions/common.md" };
    if ((SHIPPED_ROLE_NAMES as readonly string[]).includes(name)) {
        return { kind: "role", shippedName: `instructions/roles/${name}.md` };
    }
    return undefined;
}

/** One instruction file as `instructions.list` shows it. */
async function internalFile(
    kind: "common" | "role",
    path: string,
    state: ShippedFileState | undefined,
): Promise<InstructionFile> {
    return {
        kind,
        path,
        shipped: state !== undefined,
        edited: state?.edited ?? false,
        missing: !(await exists(path)),
    };
}

export function instructionOperations(component: SkillsComponent) {
    /** The seat's role and workspace, as the prompt reads them. */
    const seatOf = async ({ host }: ServiceContext, input: ListInput): Promise<ConversationMeta["seat"]> => {
        if ("conversation" in input) {
            const meta = await readConversationMeta(host, input.conversation);
            if (meta === undefined) {
                throw new ServiceError("not_found", `There is no seated conversation ${input.conversation}`);
            }
            return meta.seat;
        }
        const found = component.agentsRuntime().catalog.get(input.role);
        if (found === undefined) throw new ServiceError("not_found", `There is no role ${input.role}`);
        return {
            role: input.role,
            workspace: found.workspace ?? roleWorkspacePath(component.dataDir(), input.role),
        } as ConversationMeta["seat"];
    };

    const listOperation = defineOperation<ServiceContext, ListInput, { files: InstructionFile[] }>({
        name: "instructions.list",
        kind: "read",
        parse: parseList,
        async run(ctx, input) {
            const seat = await seatOf(ctx, input);
            const dataDir = component.dataDir();
            const states = await shippedFileStates({ dataDir, shippedRoot: component.shippedRoot });
            // The prompt's own read decides which context files it holds; its other parts are not used here.
            const { contextFiles } = await readPromptParts({
                meta: { seat, isLead: false } as ConversationMeta,
                dataDir,
                searchPaths: [],
                defaultsOf: () => new Set(),
                diagnostics: { report: () => {} },
                shippedRoot: component.shippedRoot,
            });
            return {
                files: [
                    await internalFile("common", commonPromptPath(dataDir), states["instructions/common.md"]),
                    await internalFile(
                        "role",
                        roleInstructionPath(dataDir, seat.role),
                        states[`instructions/roles/${seat.role}.md`],
                    ),
                    ...contextFiles.map(
                        ({ path }): InstructionFile => ({
                            kind: "workspace",
                            path,
                            shipped: false,
                            edited: false,
                            missing: false,
                        }),
                    ),
                ],
            };
        },
    });

    const restoreOperation = defineOperation<ServiceContext, RestoreInput, InstructionFile>({
        name: "instructions.restore",
        kind: "control",
        parse: parseRestore,
        async run(_ctx, { name }) {
            const shipped = shippedInstruction(name);
            if (shipped === undefined) {
                throw new ServiceError("not_found", `${name} is neither the common prompt nor a shipped role`);
            }
            const dataDir = component.dataDir();
            try {
                await restoreShippedFile({
                    dataDir,
                    shippedRoot: component.shippedRoot,
                    store: component.fileStore,
                    relativePath: shipped.shippedName,
                    announce: shipped.kind,
                });
            } catch (error) {
                if (error instanceof NotShippedError) throw new ServiceError("not_found", error.message);
                throw error;
            }
            const path = shipped.kind === "common" ? commonPromptPath(dataDir) : roleInstructionPath(dataDir, name);
            const states = await shippedFileStates({ dataDir, shippedRoot: component.shippedRoot });
            return internalFile(shipped.kind, path, states[shipped.shippedName]);
        },
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [listOperation, restoreOperation];
    return operations;
}
