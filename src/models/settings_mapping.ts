/**
 * Maps pi agent's `settings.json` onto the settings pi-durable's Harness reads (S-002 R-19). pi agent's file does not
 * reach the harness by itself, so only the settings listed in `MAPPED_PI_SETTINGS` take effect; every other pi agent
 * setting is ignored. Pure core: no pi-durable import and no I/O.
 */

type Json = Record<string, unknown>;
type QueueMode = "all" | "one-at-a-time";
type Transport = "auto" | "sse" | "websocket" | "websocket-cached";

/** The part of pi-durable's `HarnessSettings` that pi agent's settings map to, with the same field names. */
export type HarnessSettingsMapping = {
    stream?: { transport?: Transport; timeoutMs?: number; maxRetries?: number; maxRetryDelayMs?: number };
    retry?: { enabled?: boolean; maxRetries?: number; baseDelayMs?: number; maxAgentDelayMs?: number };
    compaction?: { enabled?: boolean; reserveTokens?: number; keepRecentTokens?: number };
    steeringMode?: QueueMode;
    followUpMode?: QueueMode;
};

type Mapping = { piKey: string; harnessField: string; isValid: (value: unknown) => boolean };

const TRANSPORTS: readonly unknown[] = ["auto", "sse", "websocket", "websocket-cached"];
const QUEUE_MODES: readonly unknown[] = ["all", "one-at-a-time"];

const isBoolean = (value: unknown): boolean => typeof value === "boolean";
const isCount = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isTransport = (value: unknown): boolean => TRANSPORTS.includes(value);
const isQueueMode = (value: unknown): boolean => QUEUE_MODES.includes(value);

const MAPPINGS: readonly Mapping[] = [
    { piKey: "transport", harnessField: "stream.transport", isValid: isTransport },
    { piKey: "retry.provider.timeoutMs", harnessField: "stream.timeoutMs", isValid: isCount },
    { piKey: "retry.provider.maxRetries", harnessField: "stream.maxRetries", isValid: isCount },
    { piKey: "retry.provider.maxRetryDelayMs", harnessField: "stream.maxRetryDelayMs", isValid: isCount },
    { piKey: "retry.enabled", harnessField: "retry.enabled", isValid: isBoolean },
    { piKey: "retry.maxRetries", harnessField: "retry.maxRetries", isValid: isCount },
    { piKey: "retry.baseDelayMs", harnessField: "retry.baseDelayMs", isValid: isCount },
    { piKey: "retry.maxAgentDelayMs", harnessField: "retry.maxAgentDelayMs", isValid: isCount },
    { piKey: "steeringMode", harnessField: "steeringMode", isValid: isQueueMode },
    { piKey: "followUpMode", harnessField: "followUpMode", isValid: isQueueMode },
    { piKey: "compaction.enabled", harnessField: "compaction.enabled", isValid: isBoolean },
    { piKey: "compaction.reserveTokens", harnessField: "compaction.reserveTokens", isValid: isCount },
    { piKey: "compaction.keepRecentTokens", harnessField: "compaction.keepRecentTokens", isValid: isCount },
];

/** Every mapped pi agent setting and the harness field it feeds, in dotted-path form. The manual shows this list. */
export const MAPPED_PI_SETTINGS: readonly { piKey: string; harnessField: string }[] = MAPPINGS.map(
    ({ piKey, harnessField }) => ({ piKey, harnessField }),
);

function isObject(value: unknown): value is Json {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readPath(source: unknown, path: string): unknown {
    let current = source;
    for (const segment of path.split(".")) {
        if (!isObject(current)) return undefined;
        current = current[segment];
    }
    return current;
}

function writePath(target: Json, path: string, value: unknown): void {
    const segments = path.split(".");
    const leaf = segments.pop() as string;
    let current = target;
    for (const segment of segments) {
        current[segment] ??= {};
        current = current[segment] as Json;
    }
    current[leaf] = value;
}

/** Returns the harness settings for the mapped settings that are present and valid; anything else is left out. */
export function mapPiSettings(piSettings: unknown): HarnessSettingsMapping {
    const mapping: Json = {};
    for (const { piKey, harnessField, isValid } of MAPPINGS) {
        const value = readPath(piSettings, piKey);
        if (isValid(value)) writePath(mapping, harnessField, value);
    }
    return mapping as HarnessSettingsMapping;
}
