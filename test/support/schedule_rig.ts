/**
 * An in-process daemon with the agents, jobs and schedules components, the fake model and a controllable clock (S-007).
 * It is written with a chosen `config.toml` and can restart on the same directories.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createSchedulesComponent, type ScheduleClock } from "../../src/schedules/schedules_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { createFakeModel } from "./fake_model.ts";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";

const WAIT_TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 10;
/** `jobs.create` refuses the in-process way in, so calls are made as a team member at the command line. */
const TEAM_MEMBER: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

/** A clock a test moves. A wait ends when the clock reaches its time, or when its signal aborts. */
export type TestClock = ScheduleClock & { set(time: Date): void; advance(ms: number): void };

export function createTestClock(start: Date): TestClock {
    let current = start.getTime();
    const waiters = new Set<{ until: number; wake(): void }>();
    const wakeDue = () => {
        for (const waiter of [...waiters]) if (waiter.until <= current) waiter.wake();
    };
    return {
        now: () => new Date(current),
        wait: (until, signal) =>
            new Promise<void>((resolve) => {
                const waiter = {
                    until: until.getTime(),
                    wake: () => {
                        waiters.delete(waiter);
                        signal.removeEventListener("abort", waiter.wake);
                        resolve();
                    },
                };
                waiters.add(waiter);
                signal.addEventListener("abort", waiter.wake, { once: true });
                if (signal.aborted || waiter.until <= current) waiter.wake();
            }),
        set(time) {
            current = time.getTime();
            wakeDue();
        },
        advance(ms) {
            current += ms;
            wakeDue();
        },
    };
}

export type ScheduleRigOptions = {
    /** The text of `config.toml`, written before each start. */
    configToml: string | ((env: HermeticEnv) => string);
    /** The clock's first moment; a fixed local time by default. */
    startTime?: Date;
};

export type ScheduleRig = {
    env: HermeticEnv;
    clock: TestClock;
    /** The daemon's log, as written to its stream. */
    logs(): string;
    daemon(): RunningDaemon;
    /** Settles with the exit code of the current daemon. */
    exited(): Promise<number>;
    isReady(): boolean;
    invoke(name: string, input?: unknown): Promise<unknown>;
    /** Stops the daemon and starts another on the same directories, with new `config.toml` text when given. */
    restart(configToml?: string | ((env: HermeticEnv) => string)): Promise<void>;
    dispose(): Promise<void>;
};

const defaultStart = (): Date => new Date(2026, 10, 8, 1, 0, 0);

/** Starts the daemon and returns when it is ready, or has exited after a failed startup. */
export async function startScheduleRig(options: ScheduleRigOptions): Promise<ScheduleRig> {
    const env = await createHermeticEnv();
    const clock = createTestClock(options.startTime ?? defaultStart());
    const fake = createFakeModel(() => "ok");
    const provider = fake.getModel().provider;
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: provider, defaultModel: fake.getModel().id }),
    );
    let log = "";
    const logger = createLogger({
        stream: {
            write: (chunk) => {
                log += chunk;
                return true;
            },
        },
    });
    let current: RunningDaemon | undefined;
    let exit: Promise<number> | undefined;

    const writeConfig = (configToml: string | ((env: HermeticEnv) => string)) =>
        writeFile(join(env.configDir, "config.toml"), typeof configToml === "string" ? configToml : configToml(env));

    const launch = async (): Promise<void> => {
        const agents = await createAgentsComponent({ logger });
        const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
        const schedules = await createSchedulesComponent({ agents, jobs, logger, clock });
        const daemon = runDaemon({
            flags: {
                configDir: env.configDir,
                stateDir: env.stateDir,
                dataDir: env.dataDir,
                runtimeDir: env.runtimeDir,
            },
            env: env.env,
            homeDir: env.root,
            logger,
            sections: [...agents.sections, ...schedules.sections],
            components: [agents.component, jobs.component, schedules.component],
            operations: [...agents.operations, ...jobs.operations, ...schedules.operations],
            prepareModels: (runtime) => {
                const implementation = getApiProvider(fake.api);
                assert.ok(implementation, "the fake model's api is registered");
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
        current = daemon;
        exit = daemon.exited;
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        let hasExited = false;
        daemon.exited.then(() => {
            hasExited = true;
        });
        while (daemon.phase() !== "ready" && !hasExited) {
            if (Date.now() > deadline) throw new Error("timed out waiting for the daemon to be ready or to exit");
            await sleep(POLL_INTERVAL_MS);
        }
    };

    const requireDaemon = (): RunningDaemon => {
        assert.ok(current, "the rig has started a daemon");
        return current;
    };
    const stopCurrent = async (): Promise<void> => {
        if (current) await Promise.race([current.stop(), sleep(STOP_BOUND_MS)]);
    };

    await writeConfig(options.configToml);
    await launch();
    return {
        env,
        clock,
        logs: () => log,
        daemon: requireDaemon,
        exited: () => {
            assert.ok(exit, "the rig has started a daemon");
            return exit;
        },
        isReady: () => current?.phase() === "ready",
        invoke: (name, input = {}) => requireDaemon().catalogue.invoke(name, input, TEAM_MEMBER),
        async restart(configToml) {
            await stopCurrent();
            if (configToml !== undefined) await writeConfig(configToml);
            await launch();
        },
        async dispose() {
            await stopCurrent();
            fake.unregister();
            await env.dispose();
        },
    };
}
