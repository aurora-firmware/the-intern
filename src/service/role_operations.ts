/**
 * The role operations (S-002 R-12, R-13, R-22): list roles, and create, change, restore and remove one. Each change
 * is validated by the role catalog, written to the configuration file first and applied at once.
 */
import { isDeepStrictEqual } from "node:util";
import type { AgentsComponent } from "../agents/agents_component.ts";
import { ConfigChangeRefused } from "../config/config_writer.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { HostInvalidKeyError, settingsResultOnce } from "../host/idempotency.ts";
import { type CatalogRole, RoleRefusedError } from "../roles/role_catalog.ts";
import type { RoleChange, RoleDefinition } from "../roles/role_model.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";

type CreateInput = { role: RoleDefinition; idempotencyKey?: string };
type ChangeInput = { name: string; change: RoleChange };
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

// The fields of a role other than its name, each present only when the input names it.
function parseRoleFields(record: Record<string, unknown>): RoleChange {
    const fields: RoleChange = {};
    if (record.instructions !== undefined) fields.instructions = requireString(record, "instructions");
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
    if (fields.instructions === undefined) throw new Error("instructions must be a non-empty string");
    const role: RoleDefinition = {
        ...fields,
        name: requireString(record, "name"),
        instructions: fields.instructions,
        tools: fields.tools ?? [],
        skills: fields.skills ?? [],
    };
    const { idempotencyKey } = record;
    if (idempotencyKey !== undefined && typeof idempotencyKey !== "string") {
        throw new Error("idempotencyKey must be a string");
    }
    return idempotencyKey === undefined ? { role } : { role, idempotencyKey };
}

const parseChange = (raw: unknown): ChangeInput => ({
    name: requireString(asRecord(raw), "name"),
    change: parseRoleFields(asRecord(raw)),
});

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
        if (error instanceof HostInvalidKeyError) throw new ServiceError("invalid_input", error.message);
        throw error;
    }
}

// Compared through JSON, as the catalog's role and the parsed input may differ in absent versus undefined fields.
const sameDefinition = (existing: CatalogRole, role: RoleDefinition): boolean => {
    const { shipped, changed, ...definition } = existing;
    return !shipped && isDeepStrictEqual(JSON.parse(JSON.stringify(definition)), JSON.parse(JSON.stringify(role)));
};

export function roleOperations(component: AgentsComponent) {
    const catalog = () => component.runtime().catalog;

    const listOperation = defineOperation<ServiceContext, Record<string, never>, { roles: CatalogRole[] }>({
        name: "roles.list",
        kind: "read",
        parse: () => ({}),
        run: async () => ({ roles: catalog().list() }),
    });

    // A crash between the file write and the recorded key leaves the role in place; the repeat then returns it.
    const createRole = async (role: RoleDefinition): Promise<{ role: CatalogRole }> => {
        const existing = catalog().get(role.name);
        if (existing !== undefined && sameDefinition(existing, role)) return { role: existing };
        return { role: await catalog().create(role) };
    };

    const createOperation = defineOperation<ServiceContext, CreateInput, { role: CatalogRole }>({
        name: "roles.create",
        kind: "control",
        parse: parseCreate,
        run: ({ host }, { role, idempotencyKey }) =>
            mappingRefusals(() =>
                idempotencyKey === undefined
                    ? catalog()
                          .create(role)
                          .then((created) => ({ role: created }))
                    : settingsResultOnce(host, { scope: CREATE_SCOPE, key: idempotencyKey }, () => createRole(role)),
            ),
    });

    const changeOperation = defineOperation<ServiceContext, ChangeInput, { role: CatalogRole }>({
        name: "roles.change",
        kind: "control",
        parse: parseChange,
        run: (_ctx, { name, change }) => mappingRefusals(async () => ({ role: await catalog().change(name, change) })),
    });

    const restoreOperation = defineOperation<ServiceContext, NameInput, { role: CatalogRole }>({
        name: "roles.restore",
        kind: "control",
        parse: parseName,
        run: (_ctx, { name }) => mappingRefusals(async () => ({ role: await catalog().restore(name) })),
    });

    const removeOperation = defineOperation<ServiceContext, NameInput, Record<string, never>>({
        name: "roles.remove",
        kind: "control",
        parse: parseName,
        run: (_ctx, { name }) =>
            mappingRefusals(async () => {
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
