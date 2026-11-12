/**
 * The front desk's schedule tools (S-001 REQ-022, S-007 REQ-013): it lists schedule entries and reads their history,
 * and creates, changes, removes and runs an entry as a team member does with `bob schedules`. Each tool acts through
 * the `schedules.*` operation of the catalogue, so the desk component doesn't import the schedules component.
 *
 * Only the two reads declare `replay: "safe"`: pi-durable never reruns another tool after a crash, so a call cut short
 * settles as an error result. A repeated call id acts once: the operations that take a key record their result under
 * it, and the two that don't are wrapped in `settingsResultOnce`.
 */
import { type Static, Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { settingsResultOnce } from "../host/idempotency.ts";
import { type Caller, ServiceError } from "../service/operations.ts";
import { jsonResult, textResult } from "./desk_state_tools.ts";
import { type DeskToolsOptions, latestWayIn } from "./desk_tools_extension.ts";

const NAME_FIELD = Type.String({ description: "The name of the schedule entry." });
const CLEARABLE = (description: string) => Type.Optional(Type.Union([Type.String(), Type.Null()], { description }));

const entryFields = {
    cron: Type.String({ description: "When it is due, as five cron fields in the daemon's local time." }),
    request: Type.String({ description: "The request of each job the entry starts." }),
};

const createParameters = Type.Object({
    name: NAME_FIELD,
    ...entryFields,
    role: Type.Optional(Type.String({ description: "The role of the job's lead, instead of the default." })),
    model: Type.Optional(Type.String({ description: "The model of the job's lead." })),
    thinkingLevel: Type.Optional(Type.String({ description: "The thinking level of the job's lead." })),
    workspace: Type.Optional(Type.String({ description: "The absolute path of the job's workspace folder." })),
});

const changeParameters = Type.Object({
    name: NAME_FIELD,
    cron: Type.Optional(entryFields.cron),
    request: Type.Optional(entryFields.request),
    role: CLEARABLE("The new role, or null to use the default."),
    model: CLEARABLE("The new model, or null to use the default."),
    thinkingLevel: CLEARABLE("The new thinking level, or null to use the default."),
    workspace: CLEARABLE("The new workspace folder, or null to use the default."),
});

const runsParameters = Type.Object({
    name: NAME_FIELD,
    limit: Type.Optional(Type.Integer({ description: "The most items to return." })),
    cursor: Type.Optional(Type.String({ description: "The cursor of the previous page." })),
});

// A refused call is an error result for the agent and its run goes on; anything else is a real failure.
async function refusable(tool: string, action: () => Promise<unknown>): Promise<ToolExecutionResult> {
    try {
        return jsonResult(await action());
    } catch (error) {
        if (error instanceof ServiceError) return textResult(`${tool} was refused: ${error.message}`, true);
        throw error;
    }
}

const agentCaller = (api: ToolExecutionApi): Caller => ({
    actor: { kind: "agent", conversationId: String(api.conversationId) },
});

type Acting = (caller: Caller, key: string) => Promise<unknown>;

// The tools that act answer for the team member the front desk is answering, and the key names the call.
async function acting(
    options: DeskToolsOptions,
    tool: string,
    api: ToolExecutionApi,
    action: Acting,
): Promise<ToolExecutionResult> {
    const conversationId = String(api.conversationId);
    const wayIn = await latestWayIn(options.host(), conversationId);
    if (wayIn === undefined) return textResult(`${tool} was refused: no team member has written to you.`, true);
    const caller: Caller = { actor: { kind: "front_desk", conversationId, wayIn } };
    return refusable(tool, () => action(caller, `${tool}:${conversationId}:${api.callId}`));
}

const listSchedulesTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "list_schedules",
        description: "List the schedule entries with each one's next due time and its latest scheduled run.",
        parameters: Type.Object({}),
        replay: "safe",
        execute: (_args, api) =>
            refusable("list_schedules", () => options.catalogue().invoke("schedules.list", {}, agentCaller(api))),
    });

const readScheduleRunsTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "read_schedule_runs",
        description:
            "Read the history of a schedule entry, newest first: the jobs it started and the due times it skipped. " +
            "A page ends with a cursor when more follow; pass it back to read the next page.",
        parameters: runsParameters,
        replay: "safe",
        execute: (args, api) =>
            refusable("read_schedule_runs", () => options.catalogue().invoke("schedules.runs", args, agentCaller(api))),
    });

const createScheduleTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "create_schedule",
        description:
            "Create a schedule entry for the request of the team member you are answering. Repeating the same call " +
            "returns the same entry.",
        parameters: createParameters,
        execute: (args, api) =>
            acting(options, "create_schedule", api, (caller, idempotencyKey) =>
                options.catalogue().invoke("schedules.create", { ...args, idempotencyKey }, caller),
            ),
    });

const changeScheduleTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "change_schedule",
        description:
            "Change a schedule entry: name only what changes. A value of null clears role, model, thinkingLevel or " +
            "workspace. A job the entry already started keeps the values it started with. Repeating the same call " +
            "returns the first result.",
        parameters: changeParameters,
        execute: (args: Static<typeof changeParameters>, api) =>
            acting(options, "change_schedule", api, (caller, key) =>
                settingsResultOnce(options.host(), { scope: "desk.change_schedule", key }, () =>
                    options.catalogue().invoke("schedules.change", args, caller),
                ),
            ),
    });

const removeScheduleTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "remove_schedule",
        description:
            "Remove a schedule entry. A job it already started goes on. Repeating the same call returns the first " +
            "result.",
        parameters: Type.Object({ name: NAME_FIELD }),
        execute: (args, api) =>
            acting(options, "remove_schedule", api, (caller, key) =>
                settingsResultOnce(options.host(), { scope: "desk.remove_schedule", key }, () =>
                    options.catalogue().invoke("schedules.remove", args, caller),
                ),
            ),
    });

const runScheduleTool = (options: DeskToolsOptions) =>
    defineTool({
        name: "run_schedule",
        description:
            "Run a schedule entry now: start its job as a run on demand, apart from the entry's due times. " +
            "Repeating the same call returns the original job.",
        parameters: Type.Object({ name: NAME_FIELD }),
        execute: (args, api) =>
            acting(options, "run_schedule", api, (caller, idempotencyKey) =>
                options.catalogue().invoke("schedules.run", { ...args, idempotencyKey }, caller),
            ),
    });

export function deskScheduleTools(options: DeskToolsOptions) {
    return [
        listSchedulesTool(options),
        readScheduleRunsTool(options),
        createScheduleTool(options),
        changeScheduleTool(options),
        removeScheduleTool(options),
        runScheduleTool(options),
    ];
}
