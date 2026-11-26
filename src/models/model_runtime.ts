/**
 * The model runtime (S-002 Model runtime): models and credentials come from the service account's pi agent folder and
 * are used in place (S-002 REQ-018, ADR-002 decision 5). The folder is only read here, except that pi's own credential
 * store writes an OAuth refresh back to `auth.json` under its own lock. Every 10 seconds the folder is read again
 * (ADR-014 decision 6). No pi-durable import.
 */
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { type CredentialStore, getSupportedThinkingLevels, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type HarnessSettingsMapping, mapPiSettings } from "./settings_mapping.ts";

export type ModelChoice = { model: string; thinkingLevel?: string };
export type ModelChoiceCheck = { ok: true } | { ok: false; reason: string };

/** How often the pi agent folder is read again. */
const REREAD_PERIOD_MS = 10_000;

export type InternModels = {
    /** The current pi `ModelRuntime`: a new one replaces it when the folder's files change. */
    readonly models: ModelRuntime;
    /** The current pi `ModelRuntime`, for the harness's `models` function. */
    current(): ModelRuntime;
    harnessSettings: HarnessSettingsMapping;
    listModels(): { model: string; thinkingLevels: string[] }[];
    checkModelChoice(choice: ModelChoice): ModelChoiceCheck;
    defaultChoice(): ModelChoice | undefined;
    /** True while the settings name no default model. */
    noDefaultModel(): boolean;
    /** Calls `listener` once each time the settings come to name a default model; returns the way to remove it. */
    onDefaultAppeared(listener: () => void): () => void;
    close(): Promise<void>;
};

/** Returns `PI_CODING_AGENT_DIR` when it is set, and pi's own agent folder otherwise. */
export function resolvePiAgentDir(env: NodeJS.ProcessEnv): string {
    const configured = env.PI_CODING_AGENT_DIR;
    return configured ? configured : getAgentDir();
}

async function readPiSettings(settingsPath: string): Promise<Record<string, unknown>> {
    let text: string;
    try {
        text = await readFile(settingsPath, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw new Error(`Cannot read pi agent settings at ${settingsPath}: ${(error as Error).message}`);
    }
    try {
        const parsed: unknown = JSON.parse(text);
        return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : {};
    } catch (error) {
        throw new Error(`pi agent settings at ${settingsPath} are not valid JSON: ${(error as Error).message}`);
    }
}

function readDefaultChoice(piSettings: Record<string, unknown>): ModelChoice | undefined {
    const { defaultProvider, defaultModel, defaultThinkingLevel } = piSettings;
    if (typeof defaultProvider !== "string" || typeof defaultModel !== "string") return undefined;
    const choice: ModelChoice = { model: `${defaultProvider}/${defaultModel}` };
    if (typeof defaultThinkingLevel === "string") choice.thinkingLevel = defaultThinkingLevel;
    return choice;
}

function checkChoice(models: ModelRuntime, choice: ModelChoice): ModelChoiceCheck {
    const separator = choice.model.indexOf("/");
    const model =
        separator > 0
            ? models.getModel(choice.model.slice(0, separator), choice.model.slice(separator + 1))
            : undefined;
    if (!model) {
        return { ok: false, reason: `Model "${choice.model}" is not in the model registry (expected provider/id).` };
    }
    if (choice.thinkingLevel === undefined) return { ok: true };
    const supported: string[] = getSupportedThinkingLevels(model);
    if (supported.includes(choice.thinkingLevel)) return { ok: true };
    return {
        ok: false,
        reason: `Thinking level "${choice.thinkingLevel}" is not supported by model "${choice.model}" (supported: ${supported.join(", ")}).`,
    };
}

/**
 * Stands in for pi's credential store while the folder has no `auth.json`: pi's own store would create the file. It
 * holds no logins and refuses to store one, so a login made with pi afterwards takes effect when the daemon restarts.
 */
function createNoLoginStore(authPath: string): CredentialStore {
    return {
        read: async () => undefined,
        list: async () => [],
        modify: async (providerId, fn) => {
            if ((await fn(undefined)) === undefined) return undefined;
            throw new Error(`No pi login at ${authPath}: log in to "${providerId}" with pi, then restart the daemon.`);
        },
        delete: async () => {},
    };
}

/** Calls `tick` every `periodMs` and returns the function that stops it. The timer never keeps the process alive. */
export type Schedule = (tick: () => Promise<void>, periodMs: number) => () => void;

const intervalSchedule: Schedule = (tick, periodMs) => {
    const timer = setInterval(() => void tick(), periodMs);
    timer.unref();
    return () => clearInterval(timer);
};

/** The file's size and modification time, or `absent`. */
async function fileStamp(path: string): Promise<string> {
    try {
        const { size, mtimeMs } = await stat(path);
        return `${size}:${mtimeMs}`;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return "absent";
        throw error;
    }
}

type FolderState = { settings: Record<string, unknown>; stamp: string };

async function readFolder(piAgentDir: string): Promise<FolderState> {
    const settings = await readPiSettings(join(piAgentDir, "settings.json"));
    const [auth, models] = await Promise.all([
        fileStamp(join(piAgentDir, "auth.json")),
        fileStamp(join(piAgentDir, "models.json")),
    ]);
    return { settings, stamp: JSON.stringify([settings, auth, models]) };
}

/** Opens a pi `ModelRuntime` on the folder. Without an `auth.json` it has no logins and never creates the file. */
async function openRuntime(piAgentDir: string): Promise<ModelRuntime> {
    const authPath = join(piAgentDir, "auth.json");
    const hasAuth = (await fileStamp(authPath)) !== "absent";
    return ModelRuntime.create({
        authPath,
        ...(!hasAuth && { credentials: createNoLoginStore(authPath) }),
        modelsPath: join(piAgentDir, "models.json"),
        allowModelNetwork: false,
        // The catalog cache would add a models-store.json to the folder, and nothing refreshes a catalog offline.
        modelsStore: new InMemoryModelsStore(),
    });
}

export type ModelRuntimeOptions = {
    piAgentDir: string;
    /** Replaces the timer of the re-read, so a test fires it by hand. */
    schedule?: Schedule;
    /** Receives the error of a re-read that failed; the state stays as it was. */
    onReadError?: (error: Error) => void;
};

/**
 * Opens the pi agent folder's model registry and settings, and reads the folder again every 10 seconds. A missing
 * `auth.json` leaves the registry without logins until the file appears.
 */
export async function createModelRuntime(options: ModelRuntimeOptions): Promise<InternModels> {
    const { piAgentDir, schedule = intervalSchedule, onReadError } = options;
    let runtime = await openRuntime(piAgentDir);
    let state = await readFolder(piAgentDir);
    const harnessSettings = mapPiSettings(state.settings);
    const listeners = new Set<() => void>();
    let isClosed = false;

    const reportError = (error: unknown) => onReadError?.(error instanceof Error ? error : new Error(String(error)));

    async function reread(): Promise<void> {
        if (isClosed) return;
        let next: FolderState;
        let nextRuntime: ModelRuntime;
        try {
            next = await readFolder(piAgentDir);
            if (next.stamp === state.stamp) return;
            nextRuntime = await openRuntime(piAgentDir);
        } catch (error) {
            reportError(error);
            return;
        }
        if (isClosed) return;
        const hadDefault = readDefaultChoice(state.settings) !== undefined;
        runtime = nextRuntime;
        state = next;
        if (hadDefault || readDefaultChoice(state.settings) === undefined) return;
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (error) {
                reportError(error);
            }
        }
    }

    const stopTimer = schedule(reread, REREAD_PERIOD_MS);
    return {
        get models() {
            return runtime;
        },
        current: () => runtime,
        harnessSettings,
        listModels: () =>
            runtime.getModels().map((model) => ({
                model: `${model.provider}/${model.id}`,
                thinkingLevels: getSupportedThinkingLevels(model),
            })),
        checkModelChoice: (choice) => checkChoice(runtime, choice),
        defaultChoice: () => readDefaultChoice(state.settings),
        noDefaultModel: () => readDefaultChoice(state.settings) === undefined,
        onDefaultAppeared: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        close: async () => {
            isClosed = true;
            stopTimer();
            closeOpenAICodexWebSocketSessions();
        },
    };
}
