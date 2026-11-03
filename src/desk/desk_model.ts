export const FRONT_DESK_EXTENSION_NAME = "intern.desk";

// The default extensions whose tools reuse job tool names, so the front desk leaves them out. Held here because
// `seating.ts` cannot import their modules: `job_tools_extension.ts` imports `seating.ts`.
export const JOB_CONVERSATION_EXTENSION_NAMES = ["intern.coordination", "intern.jobs"] as const;

export const FRONT_DESK_TOOL_NAMES = [
    "read_job",
    "list_jobs",
    "create_job",
    "update_job",
    "add_worklog",
    "relate_jobs",
    "read_conversation",
    "read_entries",
    "read_invocations",
    "read_status",
    "read_usage",
    "send_to_conversation",
    "stop_conversation",
] as const;

// The creation key of the front desk's conversation (ADR-001 decision 4).
export const FRONT_DESK_CREATION = { scope: "intern.desk", key: "front-desk" } as const;

export type SeatPlace = "job" | "front_desk";
