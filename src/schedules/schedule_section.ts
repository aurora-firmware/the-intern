import { ConfigValueError, defineConfigSection } from "../config/config_file.ts";
import { type ScheduleEntry, validateEntry } from "./schedule_model.ts";

const FILE_KEYS: Record<string, string> = { thinkingLevel: "thinking_level" };
const CODE_KEYS: Record<string, string> = { thinking_level: "thinkingLevel" };

const fileKey = (key: string): string => FILE_KEYS[key] ?? key;

const isTable = (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const toCodeKeys = (table: Record<string, unknown>): Record<string, unknown> =>
    Object.fromEntries(Object.entries(table).map(([key, value]) => [CODE_KEYS[key] ?? key, value]));

// A key written in code style (`thinkingLevel`) is no key of the file, so it stays unknown.
const refuseCodeKeys = (table: Record<string, unknown>, label: string): void => {
    const wrong = Object.keys(table).find((key) => key in FILE_KEYS);
    if (wrong !== undefined) throw new ConfigValueError(`${label}.${wrong}`, "is not a schedule setting");
};

const parseEntry = (raw: unknown, position: number, seen: Set<string>): ScheduleEntry => {
    if (!isTable(raw)) throw new ConfigValueError(String(position), "must be a table");
    const label = typeof raw.name === "string" && raw.name !== "" ? raw.name : String(position);
    refuseCodeKeys(raw, label);
    const entry = validateEntry(toCodeKeys(raw), label, fileKey);
    if (seen.has(entry.name)) throw new ConfigValueError(`${entry.name}.name`, "is used by another entry");
    seen.add(entry.name);
    return entry;
};

const serializeEntry = (entry: ScheduleEntry): Record<string, unknown> => {
    const table: Record<string, unknown> = { name: entry.name, cron: entry.cron, request: entry.request };
    if (entry.role !== undefined) table.role = entry.role;
    if (entry.model !== undefined) table.model = entry.model;
    if (entry.thinkingLevel !== undefined) table.thinking_level = entry.thinkingLevel;
    if (entry.workspace !== undefined) table.workspace = entry.workspace;
    return table;
};

export const scheduleSection = defineConfigSection<ScheduleEntry[]>({
    name: "schedule",
    defaults: () => [],
    parse(table) {
        if (!Array.isArray(table)) throw new ConfigValueError("schedule", "must be a list of [[schedule]] tables");
        const seen = new Set<string>();
        return table.map((raw, index) => parseEntry(raw, index + 1, seen));
    },
    serialize: (entries) => entries.map(serializeEntry),
});
