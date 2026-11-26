import { readFileSync } from "node:fs";
import type { ConfigStore } from "../config/config_writer.ts";
import type { SeatPlace } from "../desk/desk_model.ts";
import { JOB_TOOL_NAMES } from "../jobs/job_model.ts";
import type { InternModels } from "../models/model_runtime.ts";
import { FileRefusedError, type FileStore } from "../skills/file_store.ts";
import { DEFAULT_SHIPPED_ROOT, restoreShippedFile } from "../skills/internal_folder.ts";
import { roleWorkspacePath } from "../workspaces/workspace_folder.ts";
import type { WorkspaceRegistry } from "../workspaces/workspace_registry.ts";
import {
    applyRoleChange,
    COORDINATION_TOOL_NAMES,
    isSkillName,
    MAIL_TOOL_SET_ENTRY,
    type RoleChange,
    type RoleDefinition,
    RoleInvalidError,
    resolveSeat,
    type Seat,
    type SeatOverrides,
    SHIPPED_TOOL_NAMES,
    validateRoleDefinition,
} from "./role_model.ts";
import { type RolesConfig, rolesSection } from "./roles_section.ts";

export type CatalogRole = RoleDefinition & { shipped: boolean; changed: boolean };

export type RoleReferenceSource = { name: string; referrersOf(role: string): string[] };

export type InstructionText = { instructions: string };

/** The instructions of a change, with the version token of the file they replace when the caller guards it. */
export type InstructionChange = Partial<InstructionText> & { instructionsVersion?: string };

export type RoleCatalog = {
    list(): CatalogRole[];
    get(name: string): CatalogRole | undefined;
    create(role: RoleDefinition, text: InstructionText): Promise<CatalogRole>;
    change(name: string, change: RoleChange, text?: InstructionChange): Promise<CatalogRole>;
    restore(name: string): Promise<CatalogRole>;
    remove(name: string): Promise<void>;
    addReferenceSource(source: RoleReferenceSource): void;
    seatFor(name: string, overrides?: SeatOverrides, place?: SeatPlace): Seat;
    defaultWorkspaceUsers(path: string): string[];
    checkConfigured(): void;
};

export type RoleCatalogOptions = {
    config: ConfigStore;
    shipped: RoleDefinition[];
    workspaces: WorkspaceRegistry;
    models: Pick<InternModels, "checkModelChoice" | "defaultChoice">;
    dataDir: string;
    instructionPath(role: string): string;
    fileStore: FileStore;
    /** The folder the shipped instruction files are restored from; the package's own unless a test names another. */
    shippedRoot?: string;
};

export type RoleRefusalKind = "not_found" | "invalid" | "conflict";

export class RoleRefusedError extends Error {
    kind: RoleRefusalKind;
    role: string;
    field?: string;
    value?: string;
    reason: string;

    constructor(kind: RoleRefusalKind, role: string, reason: string, field?: string, value?: string) {
        super(
            field === undefined
                ? `Role "${role}": ${reason}`
                : `Role "${role}" ${field}${value === undefined ? "" : ` "${value}"`}: ${reason}`,
        );
        this.name = "RoleRefusedError";
        this.kind = kind;
        this.role = role;
        this.field = field;
        this.value = value;
        this.reason = reason;
    }
}

const describeValue = (value: unknown): string | undefined => {
    if (value === undefined) return undefined;
    return Array.isArray(value) ? value.join(", ") : String(value);
};

const KNOWN_TOOLS: readonly string[] = [
    ...SHIPPED_TOOL_NAMES,
    MAIL_TOOL_SET_ENTRY,
    ...COORDINATION_TOOL_NAMES,
    ...JOB_TOOL_NAMES,
];

// For a list field the value is the offending entry, so the refusal names what to fix.
const offendingValue = (role: RoleDefinition, field: string): string | undefined => {
    if (field === "tools") return role.tools.find((tool) => !KNOWN_TOOLS.includes(tool));
    if (field === "skills") return role.skills.find((skill) => !isSkillName(skill));
    return describeValue(role[field as keyof RoleDefinition]);
};

export function createRoleCatalog(options: RoleCatalogOptions): RoleCatalog {
    const { config, shipped, workspaces, models, dataDir, instructionPath, fileStore } = options;
    const shippedRoot = options.shippedRoot ?? DEFAULT_SHIPPED_ROOT;
    const referenceSources: RoleReferenceSource[] = [];

    const current = (): RolesConfig => config.current(rolesSection);

    const effective = (name: string): CatalogRole | undefined => {
        const base = shipped.find((role) => role.name === name);
        if (base !== undefined) {
            const change = current().shippedChanges[name];
            return { ...applyRoleChange(base, change ?? {}), shipped: true, changed: change !== undefined };
        }
        const team = current().teamRoles[name];
        return team === undefined ? undefined : { ...team, shipped: false, changed: false };
    };

    const list = (): CatalogRole[] => [
        ...shipped.map((role) => effective(role.name) as CatalogRole),
        ...Object.keys(current().teamRoles).map((name) => effective(name) as CatalogRole),
    ];

    const requireRole = (name: string): CatalogRole => {
        const role = effective(name);
        if (role === undefined) throw new RoleRefusedError("not_found", name, "there is no such role");
        return role;
    };

    const refuseField = (role: string, field: string, value: unknown, reason: string): never => {
        throw new RoleRefusedError("invalid", role, reason, field, describeValue(value));
    };

    const checkModelAndLevel = (role: string, model: string | undefined, thinkingLevel: string | undefined): void => {
        if (model === undefined) return;
        const modelCheck = models.checkModelChoice({ model });
        if (!modelCheck.ok) refuseField(role, "model", model, modelCheck.reason);
        if (thinkingLevel === undefined) return;
        const levelCheck = models.checkModelChoice({ model, thinkingLevel });
        if (!levelCheck.ok) refuseField(role, "thinkingLevel", thinkingLevel, levelCheck.reason);
    };

    const checkWorkspace = (role: string, workspace: string | undefined): void => {
        if (workspace !== undefined && !workspaces.isRegistered(workspace)) {
            refuseField(role, "workspace", workspace, "the workspace is not registered");
        }
    };

    // A thinking level without a model of its own is checked against pi agent's default model.
    const checkChoices = (role: string, choices: SeatOverrides & { model?: string }): void => {
        const model = choices.model ?? models.defaultChoice()?.model;
        checkModelAndLevel(role, model, choices.thinkingLevel);
        checkWorkspace(role, choices.workspace);
    };

    const checkDefinition = (role: RoleDefinition): void => {
        try {
            validateRoleDefinition(role);
        } catch (error) {
            if (!(error instanceof RoleInvalidError)) throw error;
            throw new RoleRefusedError(
                "invalid",
                role.name,
                error.reason,
                error.field,
                offendingValue(role, error.field),
            );
        }
        checkChoices(role.name, role);
    };

    const checkInstructions = (role: string, instructions: string | undefined): void => {
        if (instructions !== undefined && instructions.trim() === "") {
            refuseField(role, "instructions", undefined, "instructions are empty");
        }
    };

    // A token makes the write refuse, inside the file store's queue, a file changed since the token was read.
    const writeInstructions = async (role: string, instructions: string | undefined, version?: string) => {
        if (instructions === undefined) return;
        const options = version === undefined ? { announce: "role" as const } : { announce: "role" as const, version };
        await fileStore.write(instructionPath(role), instructions, options);
    };

    // A shipped role's file that is gone leaves its part out of the prompt; a team role's is refused, naming the file.
    const readInstructions = (role: CatalogRole): string => {
        const path = instructionPath(role.name);
        let text: string;
        try {
            text = readFileSync(path, "utf8");
        } catch (error) {
            if (role.shipped && (error as NodeJS.ErrnoException).code === "ENOENT") return "";
            const reason = `the instruction file ${path} can't be read: ${(error as Error).message}`;
            throw new RoleRefusedError("invalid", role.name, reason, "instructions");
        }
        if (!role.shipped && text.trim() === "") {
            throw new RoleRefusedError("invalid", role.name, `the instruction file ${path} is empty`, "instructions");
        }
        return text;
    };

    // A file already gone is the state a removal wants; any other failure stays.
    const removeInstructions = async (role: string): Promise<void> => {
        try {
            await fileStore.remove(instructionPath(role), { announce: "role" });
        } catch (error) {
            if (!(error instanceof FileRefusedError && error.kind === "not_found")) throw error;
        }
    };

    const saveChange = async (name: string, next: RolesConfig): Promise<CatalogRole> => {
        await config.change(rolesSection, next);
        return requireRole(name);
    };

    return {
        list,
        get: effective,
        async create(role, { instructions }) {
            if (effective(role.name) !== undefined) {
                throw new RoleRefusedError("conflict", role.name, "a role with this name already exists");
            }
            checkDefinition(role);
            checkInstructions(role.name, instructions);
            const definition = { ...role };
            if (definition.workspace === undefined) await workspaces.ensureRoleDefault(role.name);
            await writeInstructions(role.name, instructions);
            return saveChange(role.name, {
                ...current(),
                teamRoles: { ...current().teamRoles, [role.name]: definition },
            });
        },
        async change(name, change, { instructions, instructionsVersion } = {}) {
            const role = requireRole(name);
            const { shipped: _shipped, changed: _changed, ...definition } = role;
            checkDefinition(applyRoleChange(definition, change));
            checkInstructions(name, instructions);
            await writeInstructions(name, instructions, instructionsVersion);
            if (role.shipped) {
                if (Object.keys(change).length === 0) return role;
                const merged = { ...current().shippedChanges[name], ...change };
                return saveChange(name, {
                    ...current(),
                    shippedChanges: { ...current().shippedChanges, [name]: merged },
                });
            }
            const next = applyRoleChange(current().teamRoles[name] as RoleDefinition, change);
            return saveChange(name, { ...current(), teamRoles: { ...current().teamRoles, [name]: next } });
        },
        async restore(name) {
            const role = requireRole(name);
            if (!role.shipped) throw new RoleRefusedError("conflict", name, "it is a team role, not a shipped role");
            // The file comes first: dropping the table's entry is what shows the role as not changed, so a reader
            // that sees it not changed finds the shipped text stored. A failure between them leaves it changed.
            await restoreShippedFile({
                dataDir,
                shippedRoot,
                store: fileStore,
                relativePath: `instructions/roles/${name}.md`,
                announce: "role",
            });
            const { [name]: _dropped, ...remaining } = current().shippedChanges;
            const { [name]: _older, ...olderRemaining } = current().older;
            await config.change(rolesSection, { ...current(), shippedChanges: remaining, older: olderRemaining });
            return requireRole(name);
        },
        async remove(name) {
            const role = requireRole(name);
            if (role.shipped) throw new RoleRefusedError("conflict", name, "a shipped role can't be removed");
            const referrers = referenceSources.flatMap((source) =>
                source.referrersOf(name).map((referrer) => `${source.name}: ${referrer}`),
            );
            if (referrers.length > 0) {
                throw new RoleRefusedError("conflict", name, `it is named by ${referrers.join(", ")}`);
            }
            const { [name]: _removed, ...remaining } = current().teamRoles;
            const { [name]: _older, ...olderRemaining } = current().older;
            await config.change(rolesSection, { ...current(), teamRoles: remaining, older: olderRemaining });
            await removeInstructions(name);
        },
        addReferenceSource(source) {
            referenceSources.push(source);
        },
        seatFor(name, overrides = {}, place = "job") {
            const found = requireRole(name);
            const { shipped: _shipped, changed: _changed, ...definition } = found;
            checkDefinition(definition);
            // The seat carries no text: the file is read here only so a team role without a usable one is refused.
            readInstructions(found);
            const role: RoleDefinition = definition;
            const defaults = models.defaultChoice();
            checkChoices(name, {
                model: overrides.model ?? role.model,
                thinkingLevel: overrides.thinkingLevel ?? role.thinkingLevel,
                workspace: overrides.workspace,
            });
            try {
                return resolveSeat(
                    role,
                    { ...defaults, workspace: roleWorkspacePath(dataDir, name) },
                    overrides,
                    place,
                );
            } catch (error) {
                if (!(error instanceof RoleInvalidError)) throw error;
                throw new RoleRefusedError("invalid", name, error.reason, error.field);
            }
        },
        defaultWorkspaceUsers: (path) =>
            list()
                .filter((role) => role.workspace === path)
                .map((role) => role.name),
        checkConfigured() {
            for (const role of list())
                checkChoices(role.name, { model: role.model, thinkingLevel: role.thinkingLevel });
        },
    };
}
