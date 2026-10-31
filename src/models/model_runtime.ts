/**
 * The model runtime (S-002 component 4): models and credentials come from the service account's pi agent folder and
 * are used in place (R-18, ADR-002 decision 5). The folder is only read here, except that pi's own credential store
 * writes an OAuth refresh back to `auth.json` under its own lock. No pi-durable import.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { getSupportedThinkingLevels, InMemoryModelsStore } from "@earendil-works/pi-ai";
import { closeOpenAICodexWebSocketSessions } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { type HarnessSettingsMapping, mapPiSettings } from "./settings_mapping.ts";

export type ModelChoice = { model: string; thinkingLevel?: string };
export type ModelChoiceCheck = { ok: true } | { ok: false; reason: string };

export type InternModels = {
    models: ModelRuntime;
    harnessSettings: HarnessSettingsMapping;
    listModels(): { model: string; thinkingLevels: string[] }[];
    checkModelChoice(choice: ModelChoice): ModelChoiceCheck;
    defaultChoice(): ModelChoice | undefined;
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

/** Opens the pi agent folder's model registry and settings. A missing `auth.json` leaves the registry without logins. */
export async function createModelRuntime(options: { piAgentDir: string }): Promise<InternModels> {
    const { piAgentDir } = options;
    const models = await ModelRuntime.create({
        authPath: join(piAgentDir, "auth.json"),
        modelsPath: join(piAgentDir, "models.json"),
        allowModelNetwork: false,
        // The catalog cache would add a models-store.json to the folder, and nothing refreshes a catalog offline.
        modelsStore: new InMemoryModelsStore(),
    });
    const piSettings = await readPiSettings(join(piAgentDir, "settings.json"));
    return {
        models,
        harnessSettings: mapPiSettings(piSettings),
        listModels: () =>
            models.getModels().map((model) => ({
                model: `${model.provider}/${model.id}`,
                thinkingLevels: getSupportedThinkingLevels(model),
            })),
        checkModelChoice: (choice) => checkChoice(models, choice),
        defaultChoice: () => readDefaultChoice(piSettings),
        close: async () => closeOpenAICodexWebSocketSessions(),
    };
}
