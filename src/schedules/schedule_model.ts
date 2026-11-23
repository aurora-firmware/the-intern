// The schedule entry and the rules of S-007 REQ-001 that need no other component. Pure: no clock, no I/O.
import { isAbsolute } from "node:path";
import { ConfigValueError } from "../config/config_file.ts";
import { CronError, parseCron } from "./schedule_time.ts";

export type ScheduleEntry = {
    name: string;
    cron: string;
    request: string;
    role?: string;
    model?: string;
    thinkingLevel?: string;
    workspace?: string;
};

// pi-ai's main entry doesn't export its list of levels; a unit test checks that the registered models stay within it.
export const THINKING_LEVELS: readonly string[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
const ENTRY_KEYS = ["name", "cron", "request", "role", "model", "thinkingLevel", "workspace"];
const OPTIONAL_TEXT_KEYS = ["role", "model"] as const;

type Table = Record<string, unknown>;

/** How a key is written in a message: the file's name for it, or the code's. */
export type KeyNamer = (key: string) => string;

const isTable = (value: unknown): value is Table =>
    typeof value === "object" && value !== null && !Array.isArray(value);

const readNonEmptyText = (table: Table, label: string, key: string, keyOf: KeyNamer): string => {
    const value = table[key];
    if (value === undefined) throw new ConfigValueError(`${label}.${keyOf(key)}`, "is required");
    if (typeof value !== "string") throw new ConfigValueError(`${label}.${keyOf(key)}`, "must be text");
    if (value.trim() === "") throw new ConfigValueError(`${label}.${keyOf(key)}`, "must not be empty");
    return value;
};

const checkCron = (cron: string, label: string, keyOf: KeyNamer): void => {
    try {
        parseCron(cron);
    } catch (error) {
        if (error instanceof CronError) throw new ConfigValueError(`${label}.${keyOf("cron")}`, error.message);
        throw error;
    }
};

const checkOptional = (table: Table, label: string, keyOf: KeyNamer): void => {
    for (const key of [...OPTIONAL_TEXT_KEYS, "thinkingLevel", "workspace"]) {
        const value = table[key];
        if (value === undefined) continue;
        const at = `${label}.${keyOf(key)}`;
        if (typeof value !== "string") throw new ConfigValueError(at, "must be text");
        if (key === "thinkingLevel" && !THINKING_LEVELS.includes(value)) {
            throw new ConfigValueError(at, `"${value}" is not a thinking level (${THINKING_LEVELS.join(", ")})`);
        }
        if (key === "workspace" && !isAbsolute(value)) {
            throw new ConfigValueError(at, `workspace path "${value}" is not absolute`);
        }
        if (value === "" && key !== "workspace") throw new ConfigValueError(at, "must not be empty");
    }
};

/**
 * Checks one entry against the rules that need no other component. `label` stands for the entry in a message: its
 * name, or its position when it has none. The errors name keys as `keyOf` writes them.
 */
export const validateEntry = (raw: unknown, label: string, keyOf: KeyNamer = (key) => key): ScheduleEntry => {
    if (!isTable(raw)) throw new ConfigValueError(label, "must be a table");
    const unknown = Object.keys(raw).find((key) => !ENTRY_KEYS.includes(key));
    if (unknown !== undefined) throw new ConfigValueError(`${label}.${unknown}`, "is not a schedule setting");
    const name = raw.name;
    if (name === undefined) throw new ConfigValueError(`${label}.${keyOf("name")}`, "is required");
    if (typeof name !== "string" || !NAME_PATTERN.test(name)) {
        throw new ConfigValueError(
            `${label}.${keyOf("name")}`,
            "must be 1 to 64 letters, digits and hyphens, starting with a letter or digit",
        );
    }
    const cron = readNonEmptyText(raw, label, "cron", keyOf);
    checkCron(cron, label, keyOf);
    const request = readNonEmptyText(raw, label, "request", keyOf);
    checkOptional(raw, label, keyOf);
    const entry: ScheduleEntry = { name, cron, request };
    for (const key of [...OPTIONAL_TEXT_KEYS, "thinkingLevel", "workspace"] as const) {
        if (raw[key] !== undefined) entry[key] = raw[key] as string;
    }
    return entry;
};

/** The check `schedules.create` and `schedules.change` share with the file, so both refuse the same values. */
export const checkEntry = (raw: unknown): ScheduleEntry => {
    const label = isTable(raw) && typeof raw.name === "string" ? raw.name : "entry";
    return validateEntry(raw, label);
};

/** The key of a fire: one per entry and due time, so a repeat of the same fire is recognised. */
export const fireKey = (entry: string, dueTime: string): string => `schedule:${entry}:${dueTime}`;
