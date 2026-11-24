/**
 * The daemon's startup and shutdown (S-002 Lifecycle, REQ-002 to REQ-005, REQ-007). Startup is eight steps in a fixed
 * order. A failing step is logged with its number, name and cause, the earlier steps are undone, and `exited` settles
 * with 1. Shutdown undoes the same steps in reverse and settles with 0, or with 1 when it overruns `STOP_BOUND_MS`. A
 * storage failure runs the shutdown without closing the host and settles with 1. `runDaemon` never throws.
 */

import type { AccountStatusHub } from "../accounts/account_status.ts";
import { type Admission, createAdmission } from "../admission/admission.ts";
import { createAdmissionGate } from "../admission/admission_extension.ts";
import { type ConfigSection, type LoadedConfig, loadConfig } from "../config/config_file.ts";
import { type ConfigStore, createConfigStore } from "../config/config_writer.ts";
import { createInstanceFeed, type InstanceFeed } from "../feed/instance_feed.ts";
import { createObservationFeed, type ObservationFeed } from "../feed/observation_feed.ts";
import {
    type Extension,
    type HarnessHost,
    type HostDatabase,
    hostDatabase,
    type Models,
    openHarnessHost,
    type SqliteDatabase,
    type Storage,
} from "../host/harness_host.ts";
import { logCompactionFailures } from "../host/host_observation.ts";
import { recordOpenedVersions, runningVersions } from "../host/versions.ts";
import {
    checkJobSchemaVersion,
    createJobStore,
    JobSchemaTooNewError,
    type JobStore,
    migrateJobStore,
} from "../jobs/job_store.ts";
import { createModelRuntime, type InternModels, resolvePiAgentDir } from "../models/model_runtime.ts";
import { conversationControlOperations } from "../service/conversation_control_operations.ts";
import { conversationReadOperations } from "../service/conversation_read_operations.ts";
import { feedOperations } from "../service/feed_operations.ts";
import { type Catalogue, createCatalogue, type DaemonPhase, type Operation } from "../service/operations.ts";
import { runtimeReadOperations } from "../service/runtime_read_operations.ts";
import { type StatusSources, statusOperation } from "../service/status_operation.ts";
import { createFileChangeHub, type FileChangeHub } from "../skills/file_store.ts";
import { STOP_BOUND_MS, WORKER_THREAD_COUNT } from "./constants.ts";
import type { Logger } from "./logger.ts";
import { acquireOwnership } from "./ownership.ts";
import { isReportableStateDir, readStartupReport, type StartupReport, writeStartupReport } from "./startup_report.ts";
import {
    ensureInstanceDirs,
    InstanceDirError,
    type InstanceDirFlags,
    type InstanceDirs,
    resolveInstanceDirs,
} from "./state_layout.ts";

const MAIL_OWNER = "mail";
const DATABASE_STEP = 4;
const LAST_STEP = 8;
// The error pi-durable's SQLite migrations throw when the file's data is newer than the library's (no error class).
const NEWER_DURABLE_SCHEMA_MESSAGE = /SQLite schema version \d+ is newer than supported version/;

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
    catalogue: Catalogue;
    jobStore: JobStore;
    fileChanges: FileChangeHub;
    accountStatus?: AccountStatusHub;
};

export type DaemonComponent = {
    name: string;
    extensions?: readonly Extension[];
    /** Installed like `extensions` but left out of the default selection: a conversation selects them by name. */
    optInExtensions?: readonly Extension[];
    /**
     * Step 3, right after the ownership is taken: seeds or converts the component's files. A returned configuration
     * replaces the one step 4 builds the configuration store from.
     */
    prepareFiles?(input: {
        dirs: InstanceDirs;
        config: LoadedConfig;
        logger: Logger;
    }): Promise<LoadedConfig | undefined>;
    checkModels?(ctx: ServiceContext): Promise<void>;
    ensureWorkspaces?(ctx: ServiceContext): Promise<void>;
    /** Step 7, after admission is restored and before work resumes: brings the component's saved state in step. */
    repair?(ctx: ServiceContext): Promise<void>;
    /** Step 7, after the host has resumed: waits for what the repair marked to end, before listeners open. */
    afterResume?(ctx: ServiceContext): Promise<void>;
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
    openStorage?: (database: SqliteDatabase) => Promise<Storage>;
    /** Test-only: wraps the database the job store writes to, to make a write fail. */
    wrapJobDatabase?: (database: HostDatabase) => HostDatabase;
    /** The accounts layer's status hub, created by the mail component with its own clock; the context carries it unchanged. */
    accountStatus?: AccountStatusHub;
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

function causeChain(error: unknown): unknown[] {
    const chain: unknown[] = [];
    for (let link = error; link !== undefined && chain.length < 10; link = (link as Error | undefined)?.cause) {
        chain.push(link);
    }
    return chain;
}

/** Whether step 4 refused the database: its job schema or its pi-durable data is newer than this release's. */
function isUnreadableDatabase(failure: StartupFailure): boolean {
    if (failure.step !== DATABASE_STEP) return false;
    return causeChain(failure).some(
        (link) =>
            link instanceof JobSchemaTooNewError ||
            (link instanceof Error && NEWER_DURABLE_SCHEMA_MESSAGE.test(link.message)),
    );
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
    let isHostClosedByStorageFailure = false;
    const serviceLabel = options.env.BOB_SERVICE_LABEL || null;
    let furthestStep = 0;
    let isFurthestStepRead = false;
    let reportWrites: Promise<void> = Promise.resolve();

    const { dirs, failure: pathFailure } = resolveDirs(options);
    const status: StatusSources = {
        phase: () => phase,
        startedAt,
        versions,
        dirs,
        admission: () => admission?.state() ?? { capacity: workerThreadCount, active: [], waiting: [] },
        mailAccounts: () => options.accountStatus?.list(MAIL_OWNER) ?? [],
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
    context.catalogue = catalogue;

    /** Writes the startup report after the earlier writes; a write that fails is logged and never stops the startup. */
    function reportStartup(
        update: Pick<Partial<StartupReport>, "ready" | "unreadableDatabase"> & {
            failure?: StartupFailure;
            reachedStep?: number;
        },
    ): Promise<void> {
        reportWrites = reportWrites.then(() => writeReport(update));
        return reportWrites;
    }

    async function writeReport(update: Parameters<typeof reportStartup>[0]): Promise<void> {
        if (pathFailure) return;
        try {
            if (!(await isReportableStateDir(dirs.stateDir))) return;
            if (!isFurthestStepRead) {
                isFurthestStepRead = true;
                furthestStep = (await readStartupReport(dirs.stateDir).catch(() => undefined))?.furthestStep ?? 0;
            }
            furthestStep = Math.max(furthestStep, update.reachedStep ?? 0);
            await writeStartupReport(dirs.stateDir, {
                format: 1,
                version: versions.intern,
                pid: process.pid,
                serviceLabel,
                furthestStep,
                failedStep: update.failure?.step ?? null,
                failedStepName: update.failure?.stepName ?? null,
                reason: update.failure?.message ?? null,
                unreadableDatabase: update.unreadableDatabase ?? false,
                ready: update.ready ?? false,
            });
        } catch (error) {
            logger.error("could not write the startup report", {
                cause: error instanceof Error ? error.message : String(error),
            });
        }
    }

    async function step<T>(number: number, name: string, action: () => Promise<T>): Promise<T> {
        logger.debug("startup step", { step: number, name });
        await reportStartup({ reachedStep: number });
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

    async function openModelRuntime(): Promise<{
        models: InternModels;
        host: HarnessHost;
        gateAdmission: Admission;
        jobStore: JobStore;
    }> {
        const models = await createModelRuntime({
            piAgentDir: resolvePiAgentDir(options.env),
            onReadError: (error) => logger.error("could not read the pi agent folder again", { cause: error.message }),
        });
        undoStack.push(() => models.close());
        const gate = createAdmissionGate();
        const host = await openHarnessHost({
            databaseFile: dirs.databaseFile,
            models: options.prepareModels?.(models) ?? (() => models.current()),
            harnessSettings: models.harnessSettings,
            extensions: [gate.extension, ...components.flatMap((component) => component.extensions ?? [])],
            optInExtensions: components.flatMap((component) => component.optInExtensions ?? []),
            defaultCwd: dirs.dataDir,
            logger,
            beforeStorageOpen: checkJobSchemaVersion,
            ...(options.openStorage && { openStorage: options.openStorage }),
        });
        // After a storage failure the harness has already closed itself, and closing it again would only fail.
        undoStack.push(async () => {
            if (!isHostClosedByStorageFailure) await host.close();
        });
        const compactionLog = logCompactionFailures(host, logger);
        undoStack.push(async () => compactionLog.stop());
        const gateAdmission = createAdmission({ host, capacity: workerThreadCount, logger, gate });
        undoStack.push(async () => gateAdmission.stop());
        await migrateJobStore(hostDatabase(host));
        const jobDatabase = hostDatabase(host);
        // A failed write is a storage error: the daemon exits and the supervisor restarts it (S-002 REQ-007).
        const jobStore = createJobStore(options.wrapJobDatabase?.(jobDatabase) ?? jobDatabase, {
            onWriteFailure: (error) => void exitAfterFailure("job store write failed; the daemon exits", error),
        });
        return { models, host, gateAdmission, jobStore };
    }

    async function runComponents(hook: "checkModels" | "ensureWorkspaces" | "repair" | "afterResume"): Promise<void> {
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

    async function prepareComponentFiles(loaded: LoadedConfig): Promise<LoadedConfig> {
        let current = loaded;
        for (const component of components) {
            current = (await component.prepareFiles?.({ dirs, config: current, logger })) ?? current;
        }
        return current;
    }

    async function startUp(): Promise<void> {
        if (pathFailure) throw pathFailure;
        let config = await step(1, STEP_NAMES.loadConfiguration, () => loadConfig(dirs.configFile, sections));
        await step(2, STEP_NAMES.ensureDirectories, () => ensureInstanceDirs(dirs));
        await step(3, STEP_NAMES.takeOwnership, async () => {
            const ownership = await acquireOwnership(dirs.stateDir);
            undoStack.push(() => ownership.release());
            config = await prepareComponentFiles(config);
        });
        const opened = await step(4, STEP_NAMES.createModelRuntime, async () => {
            const runtime = await openModelRuntime();
            const store = createConfigStore(dirs.configFile, sections, config);
            const feed = createObservationFeed({ host: runtime.host });
            undoStack.push(async () => feed.close());
            const fileChanges = createFileChangeHub();
            const instanceFeed = await createInstanceFeed({
                host: runtime.host,
                admission: runtime.gateAdmission,
                config: store,
                jobStore: runtime.jobStore,
                fileChanges,
                ...(options.accountStatus && { accountStatus: options.accountStatus }),
            });
            undoStack.push(async () => instanceFeed.close());
            Object.assign(context, {
                host: runtime.host,
                admission: runtime.gateAdmission,
                models: runtime.models,
                jobStore: runtime.jobStore,
                config: store,
                feed,
                instanceFeed,
                fileChanges,
                ...(options.accountStatus && { accountStatus: options.accountStatus }),
            });
            return runtime;
        });
        admission = opened.gateAdmission;
        await step(5, STEP_NAMES.checkModels, () => runComponents("checkModels"));
        await step(6, STEP_NAMES.ensureWorkspaces, () => runComponents("ensureWorkspaces"));
        await step(7, STEP_NAMES.restoreAndResume, async () => {
            await recordVersions(opened.host);
            await opened.gateAdmission.restore();
            await runComponents("repair");
            opened.host.resume();
            await runComponents("afterResume");
        });
        await step(8, STEP_NAMES.startComponents, async () => {
            for (const component of components) {
                await component.start?.(context);
                startedComponents.push(component);
            }
        });
    }

    let resolveExit: (status: number) => void = () => {};
    const exited = new Promise<number>((resolve) => {
        resolveExit = resolve;
    });

    let shutdownInFlight: Promise<void> | undefined;

    /**
     * Undoes everything within `STOP_BOUND_MS`: shutdown that code stalls by ignoring its abort ends with status 1.
     * The first request decides the status; a later request waits for that shutdown instead of starting another.
     */
    function shutDown(successStatus: number): Promise<void> {
        phase = "stopping";
        shutdownInFlight ??= undoWithinBound(successStatus);
        return shutdownInFlight;
    }

    async function undoWithinBound(successStatus: number): Promise<void> {
        let boundTimer: NodeJS.Timeout | undefined;
        const bound = new Promise<"overran">((resolve) => {
            boundTimer = setTimeout(() => resolve("overran"), STOP_BOUND_MS);
        });
        const outcome = await Promise.race([undoAll().then(() => "finished" as const), bound]);
        clearTimeout(boundTimer);
        if (outcome === "overran") {
            logger.error("shutdown did not finish within the bound", { boundMs: STOP_BOUND_MS });
            resolveExit(1);
            return;
        }
        resolveExit(successStatus);
    }

    async function exitAfterFailure(description: string, error: unknown): Promise<void> {
        logger.error(description, { cause: error instanceof Error ? error.message : String(error) });
        await shutDown(1);
    }

    function watchHostAfterReady(host: HarnessHost): void {
        host.closed.then(
            (end) => {
                if (end.reason !== "failed") return;
                isHostClosedByStorageFailure = true;
                return exitAfterFailure("storage failed; the daemon exits", end.error);
            },
            (error: unknown) => exitAfterFailure("daemon failed after ready", error),
        );
    }

    startUp().then(
        async () => {
            if (shutdownInFlight) {
                // A shutdown began during startup (a failed job store write, or a stop): never ready. Components the
                // startup went on to start after the shutdown's undo ran are stopped here.
                await shutdownInFlight;
                await undoAll();
                return;
            }
            await reportStartup({ reachedStep: LAST_STEP, ready: true });
            if (shutdownInFlight) {
                await shutdownInFlight;
                await undoAll();
                return;
            }
            phase = "ready";
            logger.info("ready", {
                stateDir: dirs.stateDir,
                intern: versions.intern,
                pi: versions.pi,
                workerThreads: workerThreadCount,
            });
            if (context.host) watchHostAfterReady(context.host);
        },
        async (error: unknown) => {
            phase = "stopping";
            const failure = error instanceof StartupFailure ? error : new StartupFailure(0, "startup", error);
            logger.error("startup failed", { step: failure.step, name: failure.stepName, cause: failure.message });
            await reportStartup({ failure, unreadableDatabase: isUnreadableDatabase(failure) });
            await undoAll();
            resolveExit(1);
        },
    );
    return {
        catalogue,
        phase: () => phase,
        async stop() {
            await shutDown(0);
            return exited;
        },
        exited,
    };
}
