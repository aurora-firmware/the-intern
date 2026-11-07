import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type DaemonComponent, type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { STEER_RECORD_KIND } from "../../src/host/steering.ts";
import { createJobsComponent, type WritePoint } from "../../src/jobs/jobs_component.ts";
import { DEFAULT_LEAD_ROLE } from "../../src/roles/shipped_roles.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";

export const WAIT_MS = 20_000;
export const POLL_MS = 10;
export const SETTLE_MS = 250;
export const TEAM_TEXT = "please also check the staging copy";
export const webCaller: Caller = { actor: { kind: "team_member", wayIn: "web interface" } };
export const DAEMON = { kind: "daemon" };

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const fakes: FauxProviderRegistration[] = [];

export async function disposeAll(): Promise<void> {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
}

export type Call = { name: string; arguments: Record<string, unknown> };
export type Step = { calls: Call[] } | { hold: Promise<unknown>; onEntered?: () => void };
export type CreatedJob = { id: string; number: string; leadConversation: string };
export type StartOptions = { turnEndRule?: boolean; lines?: string[] };
export type Hooks = { onWrite?: (point: WritePoint, jobId: string) => void | Promise<void> };

export const call = (name: string, args: Record<string, unknown>): Step => ({ calls: [{ name, arguments: args }] });
export const invokeAndWait = (jobPrompt: string, mode: "parked" | "steerable"): Step =>
    call("invoke", {
        agents: [{ role: "gp", contextMode: "clean", jobPrompt }],
        // biome-ignore lint/suspicious/noThenProperty: `then` is the parameter name the specification gives the tool
        then: mode,
    });
export const setDefinitionOfDone: Step = call("update_job", { definitionOfDone: "the report is filed" });

export function deferred() {
    let release = (): void => {};
    const promise = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

export async function waitFor(check: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

/** Settles when the signal aborts, so a held model call ends with the run's abort. */
export function untilAborted(signal: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve) => {
        if (signal?.aborted) resolve();
        signal?.addEventListener("abort", () => resolve(), { once: true });
    });
}

export const settle = () => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

export const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((block) => block.text ?? "").join("");

/**
 * A daemon whose conversations follow scripts. A conversation follows the script whose key its first user message
 * contains, one step per model reply; any other conversation (and a script that has run out) answers in plain text.
 */
export async function start(scripts: Record<string, Step[]>, options: StartOptions = {}) {
    const env = await createHermeticEnv();
    envs.push(env);
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    fakes.push(fake);
    const userMessages: Record<string, string[]> = {};
    const respond: FauxResponseFactory = async (context, streamOptions) => {
        fake.appendResponses([respond]);
        const users = context.messages.filter((message) => message.role === "user").map((m) => textOf(m.content));
        const key = Object.keys(scripts).find((candidate) => users[0]?.includes(candidate));
        if (key === undefined) return fauxAssistantMessage("done");
        userMessages[key] = users;
        const step = (scripts[key] as Step[])[context.messages.filter((m) => m.role === "assistant").length];
        if (step === undefined) return fauxAssistantMessage("finished");
        if ("hold" in step) {
            step.onEntered?.();
            await Promise.race([step.hold, untilAborted(streamOptions?.signal)]);
            return fauxAssistantMessage("done");
        }
        return fauxAssistantMessage(
            step.calls.map((c) => fauxToolCall(c.name, c.arguments as never)),
            { stopReason: "toolUse" },
        );
    };
    fake.setResponses([respond]);
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: "model-one" }),
    );
    const lines = options.lines ?? [];
    const logger = createLogger({
        stream: {
            write: (chunk) => {
                lines.push(String(chunk));
                return true;
            },
        },
    });
    const hooks: Hooks = {};
    const points: { point: WritePoint; jobId: string }[] = [];
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({
        agents,
        logger,
        ...(options.turnEndRule !== undefined && { turnEndRule: options.turnEndRule }),
        afterWrite: async (point, jobId) => {
            points.push({ point, jobId });
            await hooks.onWrite?.(point, jobId);
        },
    });
    let captured: ServiceContext | undefined;
    const probe: DaemonComponent = {
        name: "probe",
        checkModels: async (ctx) => {
            captured = ctx;
        },
    };
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        sections: agents.sections,
        components: [agents.component, jobs.component, probe],
        operations: [...agents.operations, ...jobs.operations],
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            if (!implementation) throw new Error("the fake model's api is not registered");
            runtime.models.registerNativeProvider(
                createProvider({
                    id: provider,
                    auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                    models: fake.models,
                    api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
                }),
            );
            return runtime.models;
        },
    });
    daemons.push(daemon);
    await waitFor(() => daemon.phase() === "ready", "the daemon to become ready");
    const ctx = captured as ServiceContext;
    const createJob = async (text: string): Promise<CreatedJob> =>
        (await daemon.catalogue.invoke("jobs.create", { text }, webCaller)) as CreatedJob;
    const status = async (jobId: string) => (await ctx.jobStore.getJob(jobId)).status;
    const turnEndsOf = (jobId: string) => points.filter((p) => p.point === "turn-ended" && p.jobId === jobId).length;
    return {
        ctx,
        hooks,
        userMessages,
        createJob,
        status,
        turnEndsOf,
        jobDeps: { ctx, options: jobs.options },
        leadSeat: () => agents.runtime().catalog.seatFor(DEFAULT_LEAD_ROLE),
        invoke: (name: string, input: unknown) => daemon.catalogue.invoke(name, input, webCaller),
        isIdle: async (id: string) => (await ctx.host.conversationInfo(id))?.busy === false,
        /** Reminders (and other steers) in the lead's transcript. */
        steersOf: async (leadId: string) =>
            (await ctx.host.readEntries(leadId, { limit: 200 })).entries
                .filter((entry) => entry.kind === STEER_RECORD_KIND)
                .map((entry) => entry.data as { actor: unknown; mode: string; content: string }),
        statusChanges: async (jobId: string) =>
            (await ctx.jobStore.listHistory(jobId, { limit: 100 })).entries.filter((e) => e.field === "status"),
        /**
         * Returns once the rule has finished everything it was handed before now: the rule's queue is serial, so a
         * marker job whose lead has stopped and reached "turn-ended" proves the earlier items are done.
         */
        async barrier() {
            const marker = await createJob("marker job");
            await waitFor(() => turnEndsOf(marker.id) === 1, "the marker job's turn to end");
        },
    };
}
