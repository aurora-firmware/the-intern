/**
 * The role operations (S-002 REQ-012, REQ-013, REQ-022): list roles, and create, change, restore and remove one. Each
 * change is validated by the role catalog, written to the configuration file first and applied at once.
 */
import { isDeepStrictEqual } from "node:util";
import type { AgentsComponent } from "../agents/agents_component.ts";
import { ConfigChangeRefused } from "../config/config_writer.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { HostInvalidKeyError, settingsResultOnce } from "../host/idempotency.ts";
import { type CatalogRole, RoleRefusedError } from "../roles/role_catalog.ts";
import type { RoleChange, RoleDefinition } from "../roles/role_model.ts";
import { FileRefusedError } from "../skills/file_store.ts";
import { roleInstructionPath } from "../skills/internal_folder.ts";
import type { ConversationListing } from "./conversation_read_operations.ts";
import { type Caller, defineOperation, type Operation, ServiceError } from "./operations.ts";

type CreateInput = { role: RoleDefinition; instructions: string; idempotencyKey?: string };
type ChangeInput = { name: string; change: RoleChange; instructions?: string; instructionsVersion?: string };
type ListedRole = CatalogRole & {
    instructions?: string;
    instructionsVersion?: string;
    instructionsMissing?: true;
};
type NameInput = { name: string };

const CREATE_SCOPE = "roles.create";
const OPTIONAL_STRING_FIELDS = ["model", "thinkingLevel", "workspace"] as const;

function asRecord(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    return raw as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
    const value = record[field];
    if (typeof value !== "string" || value === "") throw new Error(`${field} must be a non-empty string`);
    return value;
}

function stringList(record: Record<string, unknown>, field: string): string[] | undefined {
    const value = record[field];
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
        throw new Error(`${field} must be a list of strings`);
    }
    return value;
}

// The fields of a role other than its name and instructions, each present only when the input names it.
function parseRoleFields(record: Record<string, unknown>): RoleChange {
    const fields: RoleChange = {};
    const tools = stringList(record, "tools");
    if (tools !== undefined) fields.tools = tools;
    const skills = stringList(record, "skills");
    if (skills !== undefined) fields.skills = skills;
    for (const field of OPTIONAL_STRING_FIELDS) {
        if (record[field] !== undefined) fields[field] = requireString(record, field);
    }
    return fields;
}

function parseCreate(raw: unknown): CreateInput {
    const record = asRecord(raw);
    const fields = parseRoleFields(record);
    const instructions = requireString(record, "instructions");
    const role: RoleDefinition = {
        ...fields,
        name: requireString(record, "name"),
        tools: fields.tools ?? [],
        skills: fields.skills ?? [],
    };
    const { idempotencyKey } = record;
    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
        throw new Error("idempotencyKey must be a string");
    }
    return idempotencyKey === undefined ? { role, instructions } : { role, instructions, idempotencyKey };
}

function parseChange(raw: unknown): ChangeInput {
    const record = asRecord(raw);
    const input: ChangeInput = { name: requireString(record, "name"), change: parseRoleFields(record) };
    if (record.instructions !== undefined) input.instructions = requireString(record, "instructions");
    if (record.instructionsVersion !== undefined) {
        input.instructionsVersion = requireString(record, "instructionsVersion");
    }
    return input;
}

const parseName = (raw: unknown): NameInput => ({ name: requireString(asRecord(raw), "name") });

async function mappingRefusals<T>(action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        if (error instanceof RoleRefusedError) {
            const codes = { not_found: "not_found", invalid: "invalid_input", conflict: "conflict" } as const;
            throw new ServiceError(codes[error.kind], error.message);
        }
        if (error instanceof ConfigChangeRefused) {
            const codes = { invalid: "invalid_input", conflict: "conflict", write_failed: "internal" } as const;
            throw new ServiceError(codes[error.kind], error.message);
        }
        if (error instanceof FileRefusedError) {
            const codes = { not_found: "not_found", invalid: "invalid_input", conflict: "conflict" } as const;
            throw new ServiceError(codes[error.kind], error.message);
        }
        if (error instanceof HostInvalidKeyError) throw new ServiceError("invalid_input", error.message);
        throw error;
    }
}

// Compared through JSON, as the catalog's role and the parsed input may differ in absent versus undefined fields.
const sameDefinition = (existing: ListedRole, role: RoleDefinition, instructions: string): boolean => {
    const { shipped, changed, instructions: existingText, instructionsVersion, ...definition } = existing;
    return (
        !shipped &&
        existingText === instructions &&
        isDeepStrictEqual(JSON.parse(JSON.stringify(definition)), JSON.parse(JSON.stringify(role)))
    );
};

// An open conversation holds the role its agent is seated with; a closed one doesn't.
async function refuseWhileSeated(ctx: ServiceContext, role: string, caller: Caller): Promise<void> {
    const listings = (await ctx.catalogue.invoke("conversations.list", {}, caller)) as ConversationListing[];
    const holding = listings.filter((listing) => listing.status !== "closed" && listing.seat?.role === role);
    if (holding.length === 0) return;
    const ids = holding.map((listing) => listing.id).join(", ");
    throw new ServiceError(
        "conflict",
        `Role "${role}" can't be removed: an open conversation is seated with it (${ids}); close or reseat it first`,
    );
}

export function roleOperations(component: AgentsComponent) {
    const catalog = () => component.runtime().catalog;

    // A role without a readable file is listed with no text; the file store refuses any other failure on it.
    const withInstructions = async (role: CatalogRole): Promise<ListedRole> => {
        try {
            const { text, version } = await component.skills.fileStore.read(
                roleInstructionPath(component.skills.dataDir(), role.name),
            );
            return { ...role, instructions: text, instructionsVersion: version };
        } catch (error) {
            if (error instanceof FileRefusedError && error.kind === "not_found") {
                return { ...role, instructionsMissing: true };
            }
            throw error;
        }
    };

    // A missing file is a hand change: the service never writes it again, so it names the remedy instead.
    // A token from before the deletion is a stale token, so it is a conflict; no token is invalid input.
    const refuseMissingFile = async (role: CatalogRole, hasToken: boolean): Promise<void> => {
        if (!(await withInstructions(role)).instructionsMissing) return;
        const { name } = role;
        const file = roleInstructionPath(component.skills.dataDir(), name);
        const remedy = role.shipped
            ? `run "bob instructions restore ${name}"`
            : "create the file again by hand, or remove the role and create it again";
        throw new ServiceError(
            hasToken ? "conflict" : "invalid_input",
            `Role "${name}" has no instruction file ${file}; ${remedy}`,
        );
    };

    const listOperation = defineOperation<ServiceContext, Record<string, never>, { roles: ListedRole[] }>({
        name: "roles.list",
        kind: "read",
        parse: () => ({}),
        run: async () => ({ roles: await Promise.all(catalog().list().map(withInstructions)) }),
    });

    // A crash between the file write and the recorded key leaves the role in place; the repeat then returns it.
    const createRole = async (input: CreateInput): Promise<{ role: ListedRole }> => {
        const { role, instructions } = input;
        const existing = catalog().get(role.name);
        if (existing !== undefined) {
            const listed = await withInstructions(existing);
            if (sameDefinition(listed, role, instructions)) return { role: listed };
        }
        return createNew(input);
    };

    const createNew = async ({ role, instructions }: CreateInput): Promise<{ role: ListedRole }> => ({
        role: await withInstructions(await catalog().create(role, { instructions })),
    });

    const createOperation = defineOperation<ServiceContext, CreateInput, { role: ListedRole }>({
        name: "roles.create",
        kind: "control",
        parse: parseCreate,
        run: ({ host }, input) =>
            mappingRefusals(() =>
                input.idempotencyKey === undefined
                    ? createNew(input)
                    : settingsResultOnce(host, { scope: CREATE_SCOPE, key: input.idempotencyKey }, () =>
                          createRole(input),
                      ),
            ),
    });

    const changeOperation = defineOperation<ServiceContext, ChangeInput, { role: ListedRole }>({
        name: "roles.change",
        kind: "control",
        parse: parseChange,
        run: (_ctx, { name, change, instructions, instructionsVersion }) =>
            mappingRefusals(async () => {
                // An unknown role is left to the catalog, which refuses it not_found.
                const existing = catalog().get(name);
                if (instructions !== undefined && existing)
                    await refuseMissingFile(existing, instructionsVersion !== undefined);
                if (instructions !== undefined && instructionsVersion === undefined && existing) {
                    throw new ServiceError(
                        "invalid_input",
                        `Role "${name}" instructions need instructionsVersion, the token roles.list returned with them`,
                    );
                }
                const changed = await catalog().change(name, change, { instructions, instructionsVersion });
                return { role: await withInstructions(changed) };
            }),
    });

    const restoreOperation = defineOperation<ServiceContext, NameInput, { role: ListedRole }>({
        name: "roles.restore",
        kind: "control",
        parse: parseName,
        run: (_ctx, { name }) =>
            mappingRefusals(async () => ({ role: await withInstructions(await catalog().restore(name)) })),
    });

    const removeOperation = defineOperation<ServiceContext, NameInput, Record<string, never>>({
        name: "roles.remove",
        kind: "control",
        parse: parseName,
        run: (ctx, { name }, caller) =>
            mappingRefusals(async () => {
                await refuseWhileSeated(ctx, name, caller);
                await catalog().remove(name);
                return {};
            }),
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [
        listOperation,
        createOperation,
        changeOperation,
        restoreOperation,
        removeOperation,
    ];
    return operations;
}
