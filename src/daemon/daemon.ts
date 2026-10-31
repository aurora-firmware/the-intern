/**
 * The daemon's startup (S-002 component 1, R-2, R-3): eight steps in a fixed order. A failing step is logged with its
 * number, name and cause, the earlier steps are undone, and `exited` settles with 1. `runDaemon` never throws.
 */
import { type Admission, createAdmission } from "../admission/admission.ts";
import { createAdmissionGate } from "../admission/admission_extension.ts";
import { type ConfigSection, loadConfig } from "../config/config_file.ts";
import { type ConfigStore, createConfigStore } from "../config/config_writer.ts";
import { createInstanceFeed, type InstanceFeed } from "../feed/instance_feed.ts";
import { createObservationFeed, type ObservationFeed } from "../feed/observation_feed.ts";
import { type Extension, type HarnessHost, type Models, openHarnessHost, type Storage } from "../host/harness_host.ts";
import { recordOpenedVersions, runningVersions } from "../host/versions.ts";
import { createModelRuntime, type InternModels, resolvePiAgentDir } from "../models/model_runtime.ts";
import { conversationControlOperations } from "../service/conversation_control_operations.ts";
import { conversationReadOperations } from "../service/conversation_read_operations.ts";
import { feedOperations } from "../service/feed_operations.ts";
import { type Catalogue, createCatalogue, type DaemonPhase, type Operation } from "../service/operations.ts";
import { runtimeReadOperations } from "../service/runtime_read_operations.ts";
import { type StatusSources, statusOperation } from "../service/status_operation.ts";
import { WORKER_THREAD_COUNT } from "./constants.ts";
import type { Logger } from "./logger.ts";
import { acquireOwnership, type OwnershipHandle } from "./ownership.ts";
import {
    ensureInstanceDirs,
    InstanceDirError,
    type InstanceDirFlags,
    type InstanceDirs,
    resolveInstanceDirs,
} from "./state_layout.ts";

export type ServiceContext = {
    host: HarnessHost;
    admission: Admission;
    models: InternModels;
    config: ConfigStore;
    feed: ObservationFeed;
    instanceFeed: InstanceFeed;
    status: StatusSources;
    dirs: InstanceDirs;
    logger: Logger;
};

export type DaemonComponent = {
    name: string;
    extensions?: readonly Extension[];
    checkModels?(ctx: ServiceContext): Promise<void>;
    ensureWorkspaces?(ctx: ServiceContext): Promise<void>;
    start?(ctx: ServiceContext): Promise<void>;
    stop?(): Promise<void>;
};

export type DaemonOptions = {
    flags: InstanceDirFlags & { verbose?: boolean };
    env: NodeJS.ProcessEnv;
    homeDir: string;
    logger: Logger;
    sections?: readonly ConfigSection<unknown>[];
    components?: readonly DaemonComponent[];
    // biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
    operations?: readonly Operation<ServiceContext, any, any>[];
    /** Test-only: replaces the built-in worker-thread count. */
    workerThreadCount?: number;
    /** Test-only: replaces the models handed to the harness, to use the fake model. */
    prepareModels?: (models: InternModels) => Models;
    /** Test-only: replaces the SQLite storage, to make it fail. */
    openStorage?: (file: string) => Promise<Storage>;
};

export type RunningDaemon = {
    catalogue: Catalogue;
    phase(): DaemonPhase;
    stop(): Promise<number>;
    exited: Promise<number>;
};

const STEP_NAMES = {
    loadConfiguration: "load configuration",
    ensureDirectories: "ensure directories",
    takeOwnership: "take ownership",
    createModelRuntime: "create model runtime",
    checkModels: "check models",
    ensureWorkspaces: "ensure workspaces",
    restoreAndResume: "restore admission and resume",
    startComponents: "start components",
} as const;

class StartupFailure extends Error {
    readonly step: number;
    readonly stepName: string;

    constructor(step: number, stepName: string, cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
        this.name = "StartupFailure";
        this.step = step;
        this.stepName = stepName;
    }
}

type Undo = () => Promise<void>;

/** Resolves the directories, falling back to the defaults when the flags are invalid so `daemon.status` still has some. */
function resolveDirs(options: DaemonOptions): { dirs: InstanceDirs; failure?: StartupFailure } {
    const { flags, env, homeDir } = options;
    try {
        return { dirs: resolveInstanceDirs({ flags, env, homeDir }) };
    } catch (error) {
        const dirs = resolveInstanceDirs({ flags: {}, env, homeDir });
        if (error instanceof InstanceDirError)
            return { dirs, failure: new StartupFailure(2, STEP_NAMES.ensureDirectories, error) };
        throw error;
    }
}

export function runDaemon(options: DaemonOptions): RunningDaemon {
    const { logger } = options;
    const components = options.components ?? [];
    const sections = options.sections ?? [];
    const workerThreadCount = options.workerThreadCount ?? WORKER_THREAD_COUNT;
    const startedAt = new Date();
    const versions = runningVersions();
    const undoStack: Undo[] = [];
    const startedComponents: DaemonComponent[] = [];
    let phase: DaemonPhase = "starting";
    let admission: Admission | undefined;

    const { dirs, failure: pathFailure } = resolveDirs(options);
    const status: StatusSources = {
        phase: () => phase,
        startedAt,
        versions,
        dirs,
        admission: () => admission?.state() ?? { capacity: workerThreadCount, active: [], waiting: [] },
    };
    // The operations are rejected by phase until ready, so the context is complete by the time any of them runs.
    const context = { status, dirs, logger } as ServiceContext;
    const catalogue = createCatalogue(
        [
            statusOperation,
            ...conversationReadOperations,
            ...runtimeReadOperations,
            ...conversationControlOperations,
            ...feedOperations,
            ...(options.operations ?? []),
        ],
        { context, phase: () => phase, logger },
    );

    async function step<T>(number: number, name: string, action: () => Promise<T>): Promise<T> {
        logger.debug("startup step", { step: number, name });
        try {
            return await action();
        } catch (error) {
            throw new StartupFailure(number, name, error);
        }
    }

    async function undoAll(): Promise<void> {
        for (const component of startedComponents.splice(0).reverse()) {
            await component.stop?.().catch((error: unknown) => logUndoError(`component ${component.name}`, error));
        }
        for (const undo of undoStack.splice(0).reverse()) {
            await undo().catch((error: unknown) => logUndoError("startup step", error));
        }
    }

    function logUndoError(what: string, error: unknown): void {
        logger.error(`could not undo ${what}`, { cause: error instanceof Error ? error.message : String(error) });
    }

    async function openModelRuntime(): Promise<{ models: InternModels; host: HarnessHost; gateAdmission: Admission }> {
        const models = await createModelRuntime({ piAgentDir: resolvePiAgentDir(options.env) });
        undoStack.push(() => models.close());
        const gate = createAdmissionGate();
        const host = await openHarnessHost({
            databaseFile: dirs.databaseFile,
            models: options.prepareModels?.(models) ?? models.models,
            harnessSettings: models.harnessSettings,
            extensions: [gate.extension, ...components.flatMap((component) => component.extensions ?? [])],
            defaultCwd: dirs.dataDir,
            logger,
            ...(options.openStorage && { openStorage: options.openStorage }),
        });
        undoStack.push(() => host.close());
        const gateAdmission = createAdmission({ host, capacity: workerThreadCount, logger, gate });
        undoStack.push(async () => gateAdmission.stop());
        return { models, host, gateAdmission };
    }

    async function runComponents(hook: "checkModels" | "ensureWorkspaces"): Promise<void> {
        for (const component of components) await component[hook]?.(context);
    }

    async function recordVersions(host: HarnessHost): Promise<void> {
        const result = await recordOpenedVersions(host, versions);
        if (!result.changed || !result.previous) return;
        logger.info("versions changed", {
            previousIntern: result.previous.intern,
            previousPi: result.previous.pi,
            intern: versions.intern,
            pi: versions.pi,
        });
    }

    async function startUp(): Promise<void> {
        if (pathFailure) throw pathFailure;
        const config = await step(1, STEP_NAMES.loadConfiguration, () => loadConfig(dirs.configFile, sections));
        await step(2, STEP_NAMES.ensureDirectories, () => ensureInstanceDirs(dirs));
        const ownership: OwnershipHandle = await step(3, STEP_NAMES.takeOwnership, () =>
            acquireOwnership(dirs.stateDir),
        );
        undoStack.push(() => ownership.release());
        const opened = await step(4, STEP_NAMES.createModelRuntime, async () => {
            const runtime = await openModelRuntime();
            const store = createConfigStore(dirs.configFile, sections, config);
            const feed = createObservationFeed({ host: runtime.host });
            undoStack.push(async () => feed.close());
            const instanceFeed = await createInstanceFeed({
                host: runtime.host,
                admission: runtime.gateAdmission,
                config: store,
            });
            undoStack.push(async () => instanceFeed.close());
            Object.assign(context, {
                host: runtime.host,
                admission: runtime.gateAdmission,
                models: runtime.models,
                config: store,
                feed,
                instanceFeed,
            });
            return runtime;
        });
        admission = opened.gateAdmission;
        await step(5, STEP_NAMES.checkModels, () => runComponents("checkModels"));
        await step(6, STEP_NAMES.ensureWorkspaces, () => runComponents("ensureWorkspaces"));
        await step(7, STEP_NAMES.restoreAndResume, async () => {
            await recordVersions(opened.host);
            await opened.gateAdmission.restore();
            opened.host.resume();
        });
        await step(8, STEP_NAMES.startComponents, async () => {
            for (const component of components) {
                await component.start?.(context);
                startedComponents.push(component);
            }
        });
    }

    let resolveStop: (status: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
        startUp().then(
            () => {
                phase = "ready";
                logger.info("ready", {
                    stateDir: dirs.stateDir,
                    intern: versions.intern,
                    pi: versions.pi,
                    workerThreads: workerThreadCount,
                });
            },
            async (error: unknown) => {
                phase = "stopping";
                const failure = error instanceof StartupFailure ? error : new StartupFailure(0, "startup", error);
                logger.error("startup failed", { step: failure.step, name: failure.stepName, cause: failure.message });
                await undoAll();
                resolve(1);
            },
        );
        resolveStop = resolve;
    });
    return {
        catalogue,
        phase: () => phase,
        async stop() {
            phase = "stopping";
            await undoAll();
            resolveStop(0);
            return exited;
        },
        exited,
    };
}
