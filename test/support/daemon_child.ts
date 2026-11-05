/**
 * A daemon for the process-level tests. `startDaemon` (daemon_process.ts) runs it as a child process: argv[2] holds the
 * test-only switches as JSON, the rest are the four directory flags. It answers `{ id, op, input }` messages on Node's
 * IPC channel with `{ id, result }` or `{ id, error: { code, message } }`, posts `{ ready: true }` once the daemon is
 * ready, and stops on SIGTERM as `src/cli/bob.ts` does. It opens the local socket as `bob serve` does, so a client can
 * reach it over `bob.sock` too.
 */
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Type } from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent, type DeskCreatePoint } from "../../src/desk/desk_component.ts";
import { onInputSubmitted, submissionIdFor, submissionState } from "../../src/host/conversation_control.ts";
import type { Models, Storage } from "../../src/host/harness_host.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { blockJob, cancelJob } from "../../src/jobs/job_actions.ts";
import { createJobsComponent, type JobsComponentOptions, type WritePoint } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import type { InternModels } from "../../src/models/model_runtime.ts";
import { createJob, type JobView } from "../../src/service/job_operations.ts";
import { type Caller, defineOperation, ServiceError, type ServiceErrorCode } from "../../src/service/operations.ts";
import { RESUME_MARKER, type StartDaemonOptions } from "./daemon_process.ts";
import { createFakeModel, type FakeReply, type FakeTranscript } from "./fake_model.ts";
import { createTestOperations, type StorageSwitch } from "./test_operations.ts";

const TEAM_MEMBER: Caller = { actor: { kind: "team_member", wayIn: "command line" } };
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

const DESK_STEER_PREFIX = "steer ";
const DESK_STEER_MESSAGE = "from-desk";
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

const NESTED_PARENT_PROMPT = `${INVOKED_JOB_PROMPT_PREFIX} A`;
const NESTED_INVOKE_CALL = {
    name: "invoke",
    arguments: {
        agents: [{ role: "gp", contextMode: "clean", jobPrompt: `${INVOKED_JOB_PROMPT_PREFIX} A1` }],
        // biome-ignore lint/suspicious/noThenProperty: `then` is the invoke tool's parameter name
        then: "parked",
    },
};

const DEFINITION_OF_DONE = "The invoked agent has reported";
const UPDATE_JOB_CALL = { name: "update_job", arguments: { definitionOfDone: DEFINITION_OF_DONE } };
const SINGLE_INVOKE_CALL = {
    name: "invoke",
    arguments: {
        agents: [{ role: "gp", contextMode: "clean", jobPrompt: `${INVOKED_JOB_PROMPT_PREFIX} A` }],
        // biome-ignore lint/suspicious/noThenProperty: `then` is the invoke tool's parameter name
        then: "parked",
    },
};
const COMPLETE_JOB_CALL = {
    name: "complete_job",
    arguments: { justification: "The invoked agent reported, so the definition of done is met" },
};

/** The lead sets its definition of done, invokes one agent (it parks), and completes the job on the report. */
function invokeAndCompleteReply(transcript: FakeTranscript): FakeReply {
    const lastText = lastUserText(transcript);
    const hasReport = lastText.includes(`echo: ${INVOKED_JOB_PROMPT_PREFIX}`);
    if (hasReport) return { toolCall: COMPLETE_JOB_CALL };
    if (lastText.startsWith(INVOKED_JOB_PROMPT_PREFIX)) return `echo: ${lastText}`;
    return { toolCall: hasToolResult(transcript) ? SINGLE_INVOKE_CALL : UPDATE_JOB_CALL };
}

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
    if (script === "invoke-and-complete") return invokeAndCompleteReply(transcript);
    if (script === "invoke-nested") {
        if (hasToolResult(transcript)) return echo;
        if (lastText === NESTED_PARENT_PROMPT) return { toolCall: NESTED_INVOKE_CALL };
        return lastText.startsWith(INVOKED_JOB_PROMPT_PREFIX) ? echo : { toolCall: PARKED_INVOKE_CALL };
    }
    if (script === "desk-steer") {
        if (!lastText.startsWith(DESK_STEER_PREFIX) || hasToolResult(transcript)) return echo;
        const conversationId = lastText.slice(DESK_STEER_PREFIX.length);
        return {
            toolCall: {
                name: "send_to_conversation",
                arguments: { conversationId, message: DESK_STEER_MESSAGE, mode: "steer" },
            },
        };
    }
    if (script !== "bash-sleep") return echo;
    if (hasToolResult(transcript)) return "slept";
    const seconds = /^\d+(\.\d+)?$/.test(lastText) ? lastText : DEFAULT_SLEEP_SECONDS;
    return { toolCall: { name: "bash", arguments: { command: `sleep ${seconds}` } } };
}

/**
 * Holds back the answers a kill is meant to interrupt: all of `slow`, the answer after the tool of `desk-steer`, the
 * lead's answers to reports for `invoke-parked-slow-lead`, and the answers after the call of the others.
 */
function delayFor(switches: Switches, transcript: FakeTranscript): number {
    const delayMs = switches.delayMs ?? DEFAULT_SLOW_DELAY_MS;
    const lastText = lastUserText(transcript);
    if (switches.script === "slow") return delayMs;
    if (switches.script === "desk-steer") return hasToolResult(transcript) ? delayMs : 0;
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

/**
 * The front desk is created at startup and needs a model, so a daemon on the fake model gets the pi agent folder's
 * default from it, unless the test wrote its own settings before starting.
 */
async function writeFakeModelDefault(fake: ReturnType<typeof createFakeModel>): Promise<void> {
    const { provider, id } = fake.getModel();
    const settings = JSON.stringify({ defaultProvider: provider, defaultModel: id });
    try {
        await writeFile(join(process.env.PI_CODING_AGENT_DIR ?? "", "settings.json"), settings, { flag: "wx" });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
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

/** Kills the process once an agent's steer is placed, and never lets the steering call return. */
function killOnSteerComponent(): DaemonComponent {
    return {
        name: "kill-on-steer",
        async start(ctx: ServiceContext) {
            onInputSubmitted(ctx.host, async (input) => {
                if (!input.requestId.startsWith("steer:")) return;
                process.kill(process.pid, "SIGKILL");
                return new Promise<void>(() => undefined);
            });
        },
    };
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
    if (switches.killOnSteer) components.push(killOnSteerComponent());
    if (switches.holdStart) components.push({ name: "hold-start", start: () => release });
    return components;
}

/** Kills the process the first time the Jobs component reaches `crashAt`, and never lets the work after it run. */
function killingAt(crashAt: WritePoint): NonNullable<JobsComponentOptions["afterWrite"]> {
    return (point) => {
        if (point !== crashAt) return undefined;
        process.kill(process.pid, "SIGKILL");
        return new Promise<void>(() => undefined);
    };
}

/** Kills the process at the front desk's creation point `crashAt`, and never lets the work after it run. */
function killingDeskAt(
    crashAt: DeskCreatePoint,
): NonNullable<Parameters<typeof createDeskComponent>[0]["afterCreate"]> {
    return (point) => {
        if (point !== crashAt) return undefined;
        process.kill(process.pid, "SIGKILL");
        return new Promise<void>(() => undefined);
    };
}

/** Blocks a job as a team member at the command line, so a test drives a block without scripting the model. */
function blockJobOperation(jobs: { options: JobsComponentOptions }) {
    return defineOperation<ServiceContext, { job: string; reason: string }, Record<string, never>>({
        name: "test.blockJob",
        kind: "control",
        parse: (raw) => raw as { job: string; reason: string },
        async run(ctx, { job, reason }) {
            await blockJob({ ctx, options: jobs.options }, job, reason, { kind: "team_member", wayIn: "command line" });
            return {};
        },
    });
}

/** Creates a job that is cancelled before its lead conversation exists, which the service never does on its own. */
function createJobCancelledBeforeLeadOperation(jobs: { options: JobsComponentOptions }) {
    return defineOperation<ServiceContext, { text: string }, JobView>({
        name: "test.createJobCancelledBeforeLead",
        kind: "control",
        parse: (raw) => raw as { text: string },
        run(ctx, { text }, caller) {
            const cancelAtCreation: NonNullable<JobsComponentOptions["afterWrite"]> = async (point, jobId) => {
                if (point !== "job-created") return;
                const author = { kind: "team_member", wayIn: "command line" } as const;
                await cancelJob({ ctx, options: jobs.options }, jobId, "Cancelled before its lead", author);
            };
            return createJob(ctx, { ...jobs.options, afterWrite: cancelAtCreation }, { text }, caller);
        },
    });
}

/**
 * Cancels the jobs one after the other, each stopping right after its conversations' closed marks are committed, then
 * kills the process. The jobs' runs are left unfinished and the jobs are Done, as after a `kill -9` at that point.
 */
function cancelJobsThenKillOperation(jobs: { options: JobsComponentOptions }) {
    const stopMessage = "stopped after the closed marks";
    const stopAfterClosedMarks: NonNullable<JobsComponentOptions["afterWrite"]> = (point) => {
        if (point === "conversations-closed") throw new Error(stopMessage);
    };
    return defineOperation<ServiceContext, { jobs: string[] }, Record<string, never>>({
        name: "test.cancelJobsThenKill",
        kind: "control",
        parse: (raw) => raw as { jobs: string[] },
        async run(ctx, input) {
            const deps = { ctx, options: { ...jobs.options, afterWrite: stopAfterClosedMarks } };
            const author = { kind: "team_member", wayIn: "command line" } as const;
            for (const jobId of input.jobs) {
                await cancelJob(deps, jobId, "no longer needed", author).catch((error: unknown) => {
                    if (!(error instanceof Error) || error.message !== stopMessage) throw error;
                });
            }
            process.kill(process.pid, "SIGKILL");
            return new Promise<never>(() => undefined);
        },
    });
}

/** Lists the model requests the daemon received, each with the first user message and the daemon phase it started in. */
function modelRequestsOperation(requests: { firstUserText: string; phase: string }[]) {
    return defineOperation<ServiceContext, Record<string, never>, { firstUserText: string; phase: string }[]>({
        name: "test.modelRequests",
        kind: "read",
        parse: (raw) => raw as Record<string, never>,
        run: async () => [...requests],
    });
}

/** Lists what each conversation of a job still waits for, which no service operation shows. */
function waitingOperation() {
    return defineOperation<ServiceContext, { job: string }, { id: string; awaiting: string[]; held: number }[]>({
        name: "test.waiting",
        kind: "read",
        parse: (raw) => raw as { job: string },
        async run(ctx, { job }) {
            const waiting: { id: string; awaiting: string[]; held: number }[] = [];
            for (const { id } of await ctx.host.listConversations()) {
                const meta = await readConversationMeta(ctx.host, id);
                if (meta?.jobId === job) waiting.push({ id, awaiting: meta.awaiting, held: meta.held.length });
            }
            return waiting;
        },
    });
}

/** Reads how the input with a request id settled, which no service operation shows. */
function submissionStateOperation() {
    return defineOperation<
        ServiceContext,
        { conversationId: string; requestId: string },
        Awaited<ReturnType<typeof submissionState>>
    >({
        name: "test.submissionState",
        kind: "read",
        parse: (raw) => raw as { conversationId: string; requestId: string },
        async run(ctx, { conversationId, requestId }) {
            const submissionId = await submissionIdFor(ctx.host, conversationId, requestId);
            if (submissionId === undefined) {
                throw new Error(`Conversation ${conversationId} holds no submission for request ${requestId}`);
            }
            return submissionState(ctx.host, submissionId);
        },
    });
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

    const runGate = Promise.withResolvers<void>();
    const modelRequests: { firstUserText: string; phase: string }[] = [];
    let currentPhase: () => string = () => "none";
    const fake = switches.realModels
        ? undefined
        : createFakeModel((transcript) => replyFor(switches.script ?? "echo", transcript), {
              delayMs: (transcript) => delayFor(switches, transcript),
              onRequest: (transcript) =>
                  modelRequests.push({
                      firstUserText: transcript.find((turn) => turn.role === "user")?.text ?? "",
                      phase: currentPhase(),
                  }),
              ...(switches.script === "gated" && { gate: runGate.promise }),
              ...(switches.script === "streaming-gated" && { streamGate: runGate.promise }),
          });
    const fakeModelId = fake ? `${fake.getModel().provider}/${fake.getModel().id}` : undefined;
    const storageSwitch: StorageSwitch = { isFailing: false };
    const hold = Promise.withResolvers<void>();

    if (fake) await writeFakeModelDefault(fake);
    const logger = createLogger({ verbose: false });
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({
        agents,
        logger,
        ...(switches.turnEndRule !== undefined && { turnEndRule: switches.turnEndRule }),
        ...(switches.jobCrashAt !== undefined && { afterWrite: killingAt(switches.jobCrashAt) }),
    });
    const desk = await createDeskComponent({
        agents,
        jobs,
        logger,
        ...(switches.deskCrashAt !== undefined && { afterCreate: killingDeskAt(switches.deskCrashAt) }),
    });
    const daemon = runDaemon({
        flags: parseFlags(process.argv.slice(3)),
        env: process.env,
        homeDir: process.env.HOME ?? "",
        logger,
        sections: agents.sections,
        // The jobs and desk components and the local socket follow the agents component, as in `src/cli/bob.ts`.
        components: [
            // First, so its hook runs in the tick that resumes the host, before any model request can start.
            {
                name: "mark-resume",
                afterResume: async () => void modelRequests.push({ firstUserText: RESUME_MARKER, phase: "starting" }),
            },
            agents.component,
            jobs.component,
            desk.component,
            createLocalSocketComponent(),
            ...createComponents(switches, hold.promise),
        ],
        operations: [
            ...agents.operations,
            ...jobs.operations,
            ...desk.operations,
            blockJobOperation(jobs),
            createJobCancelledBeforeLeadOperation(jobs),
            cancelJobsThenKillOperation(jobs),
            modelRequestsOperation(modelRequests),
            waitingOperation(),
            submissionStateOperation(),
            ...createTestOperations({
                storageSwitch,
                modelFor: (ctx) => modelFor(ctx, fakeModelId, switches.model),
            }),
        ],
        ...(switches.workerThreads !== undefined && { workerThreadCount: switches.workerThreads }),
        ...(fake && { prepareModels: (runtime: InternModels) => modelsWithFake(runtime, fake) }),
        openStorage: async (database) => failingOnDemand(await SqliteStorage.open(database), storageSwitch),
    });

    currentPhase = () => daemon.phase();

    process.on("message", async (message: Request | { release: true } | { releaseRuns: true }) => {
        if ("release" in message) return hold.resolve();
        if ("releaseRuns" in message) return runGate.resolve();
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
