/**
 * The `bob roles`, `bob workspaces` and `bob models` groups (S-005 REQ-012): each command calls the role, workspace or
 * model operation of S-002 with the arguments given and prints the answer. The service validates every name and path,
 * so a refusal is printed as the service gives it; `roles show` is the one refusal `bob` makes itself, since no
 * operation reads one role. Imports no daemon code.
 */
import type { Client } from "../client/client.ts";
import type { CatalogRole } from "../roles/role_catalog.ts";
import type { WorkspaceListing } from "../workspaces/workspace_registry.ts";
import type { CommandInput, CommandSpec, OptionSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { withClient } from "./connection.ts";
import { writeError, writeJson, writeLine } from "./output.ts";
import { block, flat } from "./terminal_text.ts";

type ModelSummary = { model: string; thinkingLevels: string[] };

const NOTHING = "(none)";
const namePositional = { name: "name", required: true };

const ROLE_FIELD_OPTIONS: Record<string, OptionSpec> = {
    instructions: { type: "string", description: "The role's instructions." },
    tool: { type: "string", multiple: true, description: "A tool the role may use; repeat for several." },
    skill: { type: "string", multiple: true, description: "The absolute path of a skill; repeat for several." },
    model: { type: "string", description: "The role's model." },
    thinking: { type: "string", description: "The role's thinking level." },
    workspace: { type: "string", description: "The role's default workspace." },
};

function serviceCommand(
    group: string,
    spec: Pick<CommandSpec, "verb" | "summary" | "positionals"> & { options?: Record<string, OptionSpec> },
    action: (client: Client, input: CommandInput) => Promise<number>,
): CommandSpec {
    return {
        group,
        options: {},
        ...spec,
        isData: true,
        callsService: true,
        run: (input) => withClient(input, (client) => action(client, input)),
    };
}

// Prints the answer as JSON, or the one line of text for a command whose answer carries nothing to show.
function printAnswer(input: CommandInput, answer: unknown, text: string): number {
    if (input.json) writeJson(input.io, answer);
    else writeLine(input.io, text);
    return EXIT_CODES.ok;
}

function listOf(input: CommandInput, name: string): string[] | undefined {
    const value = input.options[name];
    return Array.isArray(value) ? value : undefined;
}

function textOf(input: CommandInput, name: string): string | undefined {
    const value = input.options[name];
    return typeof value === "string" ? value : undefined;
}

// The role fields the team member named, under the operation's input names; an unnamed field is left out.
function roleFieldsOf(input: CommandInput): Record<string, unknown> {
    const fields: Record<string, unknown> = {
        instructions: textOf(input, "instructions"),
        tools: listOf(input, "tool"),
        skills: listOf(input, "skill"),
        model: textOf(input, "model"),
        thinkingLevel: textOf(input, "thinking"),
        workspace: textOf(input, "workspace"),
    };
    for (const [field, value] of Object.entries(fields)) if (value === undefined) delete fields[field];
    return fields;
}

function formatRoleLine(role: CatalogRole): string {
    const origin = role.shipped ? (role.changed ? "shipped, changed" : "shipped") : "team";
    return `${flat(role.name)}  ${origin}  ${flat(role.model ?? "default model")}`;
}

function formatRole(role: CatalogRole): string[] {
    return [
        formatRoleLine(role),
        `  Thinking: ${flat(role.thinkingLevel ?? "default")}`,
        `  Workspace: ${flat(role.workspace ?? "role default")}`,
        `  Tools: ${flat(role.tools.join(", ")) || NOTHING}`,
        `  Skills: ${flat(role.skills.join(", ")) || NOTHING}`,
        "  Instructions:",
        // Every line of the instructions is indented, so none reads as a field of this listing.
        ...block(role.instructions)
            .split("\n")
            .map((line) => `    ${line}`),
    ];
}

async function listedRoles(client: Client): Promise<CatalogRole[]> {
    return ((await client.invoke("roles.list", {})) as { roles: CatalogRole[] }).roles;
}

const rolesList = serviceCommand(
    "roles",
    { verb: "list", summary: "List roles.", positionals: [] },
    async (c, input) => {
        const answer = await c.invoke("roles.list", {});
        if (input.json) writeJson(input.io, answer);
        else for (const role of (answer as { roles: CatalogRole[] }).roles) writeLine(input.io, formatRoleLine(role));
        return EXIT_CODES.ok;
    },
);

const rolesShow = serviceCommand(
    "roles",
    { verb: "show", summary: "Show one role.", positionals: [namePositional] },
    async (client, input) => {
        const [name] = input.positionals;
        const role = (await listedRoles(client)).find((candidate) => candidate.name === name);
        if (role === undefined) {
            writeError(input.io, `There is no role named "${name}".`);
            return EXIT_CODES.refused;
        }
        if (input.json) writeJson(input.io, role);
        else for (const line of formatRole(role)) writeLine(input.io, line);
        return EXIT_CODES.ok;
    },
);

const rolesCreate = serviceCommand(
    "roles",
    { verb: "create", summary: "Create a role.", positionals: [namePositional], options: ROLE_FIELD_OPTIONS },
    async (client, input) => {
        const [name] = input.positionals;
        const answer = await client.invoke("roles.create", { name, ...roleFieldsOf(input) });
        return printAnswer(input, answer, `${name} created`);
    },
);

const rolesChange = serviceCommand(
    "roles",
    { verb: "change", summary: "Change a role.", positionals: [namePositional], options: ROLE_FIELD_OPTIONS },
    async (client, input) => {
        const [name] = input.positionals;
        const answer = await client.invoke("roles.change", { name, ...roleFieldsOf(input) });
        return printAnswer(input, answer, `${name} changed`);
    },
);

function roleNameCommand(verb: "remove" | "restore", summary: string, done: string): CommandSpec {
    return serviceCommand("roles", { verb, summary, positionals: [namePositional] }, async (client, input) => {
        const [name] = input.positionals;
        const answer = await client.invoke(`roles.${verb}`, { name });
        return printAnswer(input, answer, `${name} ${done}`);
    });
}

function formatWorkspaceLine(workspace: WorkspaceListing): string {
    return workspace.kind === "role_default"
        ? `${flat(workspace.path)}  default of ${flat(workspace.role ?? "")}`
        : `${flat(workspace.path)}  registered`;
}

const pathPositional = { name: "path", required: true };

const workspacesList = serviceCommand(
    "workspaces",
    { verb: "list", summary: "List workspaces.", positionals: [] },
    async (client, input) => {
        const answer = await client.invoke("workspaces.list", {});
        if (input.json) writeJson(input.io, answer);
        else
            for (const item of (answer as { workspaces: WorkspaceListing[] }).workspaces) {
                writeLine(input.io, formatWorkspaceLine(item));
            }
        return EXIT_CODES.ok;
    },
);

function workspacePathCommand(verb: "register" | "unregister", summary: string, done: string): CommandSpec {
    return serviceCommand("workspaces", { verb, summary, positionals: [pathPositional] }, async (client, input) => {
        const [path] = input.positionals;
        const answer = await client.invoke(`workspaces.${verb}`, { path });
        return printAnswer(input, answer, `${path} ${done}`);
    });
}

const modelsList = serviceCommand(
    "models",
    { verb: "list", summary: "List models and their thinking levels.", positionals: [] },
    async (client, input) => {
        const models = (await client.invoke("models.list", {})) as ModelSummary[];
        if (input.json) writeJson(input.io, models);
        else
            for (const { model, thinkingLevels } of models)
                writeLine(input.io, `${flat(model)}  ${flat(thinkingLevels.join(", "))}`);
        return EXIT_CODES.ok;
    },
);

export const ROLES_COMMANDS: readonly CommandSpec[] = [
    rolesList,
    rolesShow,
    rolesCreate,
    rolesChange,
    roleNameCommand("remove", "Remove a role.", "removed"),
    roleNameCommand("restore", "Restore a shipped role to its shipped definition.", "restored"),
    workspacesList,
    workspacePathCommand("register", "Register a folder as a workspace.", "registered"),
    workspacePathCommand("unregister", "Unregister a workspace.", "unregistered"),
    modelsList,
];
