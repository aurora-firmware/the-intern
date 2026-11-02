/**
 * A daemon for the process-level tests. `startDaemon` (daemon_process.ts) runs it as a child process: argv[2] holds the
 * test-only switches as JSON, the rest are the four directory flags. It answers `{ id, op, input }` messages on Node's
 * IPC channel with `{ id, result }` or `{ id, error: { code, message } }`, posts `{ ready: true }` once the daemon is
 * ready, and stops on SIGTERM as `src/cli/bob.ts` does. It opens the local socket as `bob serve` does, so a client can
 * reach it over `bob.sock` too.
 */
import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import type { Models, Storage } from "../../src/host/harness_host.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import type { InternModels } from "../../src/models/model_runtime.ts";
import { type Caller, ServiceError, type ServiceErrorCode } from "../../src/service/operations.ts";
import type { StartDaemonOptions } from "./daemon_process.ts";
import { createFakeModel, type FakeReply, type FakeTranscript } from "./fake_model.ts";
import { createTestOperations, type StorageSwitch } from "./test_operations.ts";

const TEAM_MEMBER: Caller = { actor: { kind: "team_member" } };
const READY_POLL_INTERVAL_MS = 10;
const DEFAULT_SLOW_DELAY_MS = 1_000;
const DEFAULT_SLEEP_SECONDS = "1";
const FAILURE_EXIT_STATUS = 1;

type Switches = Omit<StartDaemonOptions, "hermetic">;

type Request = { id: number; op: string; input: unknown };

function lastUserText(transcript: FakeTranscript): string {
    return transcript.findLast((turn) => turn.role === "user")?.text ?? "";
}

function hasToolResult(transcript: FakeTranscript): boolean {
    return transcript.some((turn) => turn.role === "toolResult");
}

const HANDOFF_NOTE = "CLEAN-NOTE";
const INVOKED_JOB_PROMPT_PREFIX = "job";
const HANDOFF_CALL = { name: "handoff", arguments: { role: "gp", contextMode: "clean", note: HANDOFF_NOTE } };
const PARKED_INVOKE_CALL = {
    name: "invoke",
    arguments: {
        agents: [
            { role: "gp", contextMode: "clean", jobPrompt: `${INVOKED_JOB_PROMPT_PREFIX} A` },
            { role: "gp", contextMode: "clean", jobPrompt: `${INVOKED_JOB_PROMPT_PREFIX} B` },
        ],
        // biome-ignore lint/suspicious/noThenProperty: `then` is the invoke tool's parameter name
        then: "parked",
    },
};

type Script = NonNullable<Switches["script"]>;

/** `bash-sleep` takes its duration in seconds from the input, so a test sets how long the tool runs. */
function replyFor(script: Script, transcript: FakeTranscript): FakeReply {
    const lastText = lastUserText(transcript);
    const echo = `echo: ${lastText}`;
    if (script === "handoff-clean") {
        return lastText === HANDOFF_NOTE || hasToolResult(transcript) ? echo : { toolCall: HANDOFF_CALL };
    }
    if (script === "invoke-parked" || script === "invoke-parked-slow-lead") {
        const isInvokedAgent = lastText.startsWith(INVOKED_JOB_PROMPT_PREFIX);
        return isInvokedAgent || hasToolResult(transcript) ? echo : { toolCall: PARKED_INVOKE_CALL };
    }
    if (script !== "bash-sleep") return echo;
    if (hasToolResult(transcript)) return "slept";
    const seconds = /^\d+(\.\d+)?$/.test(lastText) ? lastText : DEFAULT_SLEEP_SECONDS;
    return { toolCall: { name: "bash", arguments: { command: `sleep ${seconds}` } } };
}

/**
 * Holds back the answers a kill is meant to interrupt: all of `slow`, the lead's answers to reports for
 * `invoke-parked-slow-lead`, and the answers after the call of the others.
 */
function delayFor(switches: Switches, transcript: FakeTranscript): number {
    const delayMs = switches.delayMs ?? DEFAULT_SLOW_DELAY_MS;
    const lastText = lastUserText(transcript);
    if (switches.script === "slow") return delayMs;
    if (switches.script === "handoff-clean") return lastText === HANDOFF_NOTE ? delayMs : 0;
    if (switches.script === "invoke-parked") return lastText.startsWith(INVOKED_JOB_PROMPT_PREFIX) ? delayMs : 0;
    if (switches.script === "invoke-parked-slow-lead")
        return lastText.includes(`echo: ${INVOKED_JOB_PROMPT_PREFIX}`) ? delayMs : 0;
    return 0;
}

// A stand-in for pi-durable's bash tool that only waits for its command, and ends it when the call is aborted.
function createBashExtension() {
    const bash = defineTool({
        name: "bash",
        description: "Runs a shell command",
        parameters: Type.Object({ command: Type.String() }),
        execute: async ({ command }, _api, toolContext) => {
            const shell = spawn("bash", ["-c", command], { stdio: "ignore", signal: toolContext.abortSignal });
            await new Promise<void>((resolve) => {
                shell.on("error", () => resolve());
                shell.on("close", () => resolve());
            });
            return { output: [{ type: "text", text: `ran: ${command}` }] };
        },
    });
    return defineExtension({ name: "bash", tools: [bash] });
}

function modelsWithFake(runtime: InternModels, fake: ReturnType<typeof createFakeModel>): Models {
    const implementation = getApiProvider(fake.api);
    if (!implementation) throw new Error("The fake model's api is not registered");
    runtime.models.registerNativeProvider(
        createProvider({
            id: fake.getModel().provider,
            auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
            models: fake.models,
            api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
        }),
    );
    return runtime.models;
}

/** The fake model wins; then the `model` switch, which the registry must accept; then the pi agent folder's default. */
function modelFor(ctx: ServiceContext, fakeModelId: string | undefined, requestedModel: string | undefined): string {
    if (fakeModelId) return fakeModelId;
    if (requestedModel !== undefined) {
        const check = ctx.models.checkModelChoice({ model: requestedModel });
        if (!check.ok) throw new Error(check.reason);
        return requestedModel;
    }
    const defaultModel = ctx.models.defaultChoice()?.model;
    if (!defaultModel) throw new Error("No model to create a conversation with: the pi agent folder has no default");
    return defaultModel;
}

function failingOnDemand(storage: Storage, storageSwitch: StorageSwitch): Storage {
    return new Proxy(storage, {
        get(target, property, receiver) {
            const value = Reflect.get(target, property, receiver);
            if (typeof value !== "function") return value;
            if (property === "commit" && storageSwitch.isFailing) {
                return () => Promise.reject(new Error("storage commit refused"));
            }
            return value.bind(target);
        },
    });
}

function createComponents(switches: Switches, release: Promise<void>): DaemonComponent[] {
    const components: DaemonComponent[] = [];
    if (switches.script === "bash-sleep") {
        components.push({ name: "bash", extensions: [createBashExtension()] });
    }
    const { checkModel } = switches;
    if (checkModel !== undefined) {
        components.push({
            name: "check-model",
            async checkModels(ctx: ServiceContext) {
                const check = ctx.models.checkModelChoice({ model: checkModel });
                if (!check.ok) throw new Error(check.reason);
            },
        });
    }
    if (switches.holdStart) components.push({ name: "hold-start", start: () => release });
    return components;
}

function errorFields(error: unknown): { code: ServiceErrorCode; message: string } {
    if (error instanceof ServiceError) return { code: error.code, message: error.message };
    return { code: "internal", message: error instanceof Error ? error.message : String(error) };
}

function parseFlags(args: readonly string[]) {
    const { values } = parseArgs({
        args: [...args],
        options: {
            "config-dir": { type: "string" },
            "state-dir": { type: "string" },
            "data-dir": { type: "string" },
            "runtime-dir": { type: "string" },
        },
    });
    return {
        configDir: values["config-dir"],
        stateDir: values["state-dir"],
        dataDir: values["data-dir"],
        runtimeDir: values["runtime-dir"],
    };
}

async function main(): Promise<void> {
    const switches = JSON.parse(process.argv[2] ?? "{}") as Switches;
    const send = process.send?.bind(process);
    if (!send) throw new Error("daemon_child.ts must be started with an IPC channel");

    const fake = switches.realModels
        ? undefined
        : createFakeModel((transcript) => replyFor(switches.script ?? "echo", transcript), {
              delayMs: (transcript) => delayFor(switches, transcript),
          });
    const fakeModelId = fake ? `${fake.getModel().provider}/${fake.getModel().id}` : undefined;
    const storageSwitch: StorageSwitch = { isFailing: false };
    const hold = Promise.withResolvers<void>();

    const logger = createLogger({ verbose: false });
    const agents = await createAgentsComponent({ logger });
    const daemon = runDaemon({
        flags: parseFlags(process.argv.slice(3)),
        env: process.env,
        homeDir: process.env.HOME ?? "",
        logger,
        sections: agents.sections,
        // The local socket follows the agents component, as in `src/cli/bob.ts`, so it opens once the agents are ready.
        components: [agents.component, createLocalSocketComponent(), ...createComponents(switches, hold.promise)],
        operations: [
            ...agents.operations,
            ...createTestOperations({
                storageSwitch,
                modelFor: (ctx) => modelFor(ctx, fakeModelId, switches.model),
            }),
        ],
        ...(switches.workerThreads !== undefined && { workerThreadCount: switches.workerThreads }),
        ...(fake && { prepareModels: (runtime: InternModels) => modelsWithFake(runtime, fake) }),
        openStorage: async (database) => failingOnDemand(await SqliteStorage.open(database), storageSwitch),
    });

    process.on("message", async (message: Request | { release: true }) => {
        if ("release" in message) return hold.resolve();
        const { id, op, input } = message;
        try {
            send({ id, result: await daemon.catalogue.invoke(op, input, TEAM_MEMBER) });
        } catch (error) {
            send({ id, error: errorFields(error) });
        }
    });

    let isStopping = false;
    const requestStop = () => {
        if (isStopping) return;
        isStopping = true;
        void daemon.stop();
    };
    process.on("SIGTERM", requestStop);
    process.on("SIGINT", requestStop);

    const readyPoll = setInterval(() => {
        if (daemon.phase() !== "ready") return;
        clearInterval(readyPoll);
        send({ ready: true });
    }, READY_POLL_INTERVAL_MS);

    daemon.exited.then(
        (status) => process.exit(status),
        () => process.exit(FAILURE_EXIT_STATUS),
    );
}

await main();
