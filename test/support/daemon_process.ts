/**
 * Starts `test/support/daemon_child.ts` as a child process and drives it over Node's IPC channel, so process-level
 * tests can kill and restart a daemon. Everything the child sees comes from `options.hermetic`: nothing is inherited
 * from the test process.
 */
import { fork } from "node:child_process";
import { createServer } from "node:net";
import { join } from "node:path";
import type { DeskCreatePoint } from "../../src/desk/desk_component.ts";
import type { WritePoint } from "../../src/jobs/jobs_component.ts";
import { ServiceError, type ServiceErrorCode } from "../../src/service/operations.ts";
import type { DaemonStatus } from "../../src/service/status_operation.ts";
import type { HermeticEnv } from "./hermetic_env.ts";
import { guardProcess } from "./process_guard.ts";

const CHILD_ENTRY = join(import.meta.dirname, "daemon_child.ts");
const READY_POLL_TIMEOUT_MS = 30_000;

/**
 * `handoff-clean`: a seated agent's first answer is a Clean handoff to `gp` with the note `CLEAN-NOTE`; the new agent's
 * answer is slow. `invoke-parked`: a lead's first answer is a parked invoke of two `gp` agents with the job prompts
 * `job A` and `job B`; the invoked agents' answers are slow. `invoke-parked-slow-lead`: as `invoke-parked`, but the invoked
 * agents answer at once and the lead's answer to each report is slow, so a kill lands while a report is being delivered.
 * `gated`: every answer waits until the test calls `releaseRuns()`, so a run lasts exactly as long as the test wants.
 * `streaming-gated`: every answer streams its first piece of text and then waits until the test calls `releaseRuns()`,
 * so a partial answer is committed while the turn is still running.
 * `desk-steer`: an input `steer <conversationId>` makes the answering agent call `send_to_conversation` to that
 * conversation with the message `from-desk`, and its answer after the tool result is slow, so a kill lands in that run.
 * `block-with-reason`: a lead blocks its job with the job's text as the reason; after an answer it waits until the test
 * calls `releaseRuns()`, then sets a definition of done and completes the job.
 * `invoke-many`: a lead's first answer is a parked invoke of 8 `gp` agents, whose answers wait until the test calls
 * `releaseRuns()`.
 * `long-output`: a lead's first answer, and that of any input after its old result is compacted away, calls a test tool
 * whose result is 1 MiB of text; an input starting `text only: ` and a compaction summary request are answered with text.
 * `long-output-failing-summary`: as `long-output`, but a compaction summary request is answered with a tool call, so
 * the compaction fails.
 * `desk-create-job`: an input `create job <text>` makes the answering agent call `create_job` with that text.
 * All of the others answer anything else with an echo.
 */
export type FakeScript =
    | "echo"
    | "bash-sleep"
    | "slow"
    | "handoff-clean"
    | "invoke-parked"
    | "invoke-parked-slow-lead"
    | "invoke-nested"
    | "invoke-and-complete"
    | "gated"
    | "streaming-gated"
    | "desk-steer"
    | "block-with-reason"
    | "invoke-many"
    | "long-output"
    | "long-output-failing-summary"
    | "desk-create-job";

/** Recorded among the child's model requests at the point the host resumes, so a test can tell which came before. */
export const RESUME_MARKER = "<host resumed>";

/** The child's test operation that tells whether its network listener started and the port it is in use on. */
export const NETWORK_STATE_OPERATION = "test.networkListener";

const PORT_PICK_ATTEMPTS = 50;
// Below Linux's default ephemeral range (32768-60999), so a socket the system numbers itself cannot take the port
// between the pick and the daemon child's bind.
const FIXED_PORT_LOW = 20_000;
const FIXED_PORT_SPAN = 12_000;

function canListenOn(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const server = createServer();
        server.once("error", () => resolve(false));
        server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
    });
}

/**
 * A port nothing listens on at the moment, to pass as `fixedPort`. It is picked at random below the range the system
 * hands out to other sockets, so no unrelated process takes it before the daemon child binds it.
 */
export async function freeLoopbackPort(): Promise<number> {
    for (let attempt = 0; attempt < PORT_PICK_ATTEMPTS; attempt++) {
        const port = FIXED_PORT_LOW + Math.floor(Math.random() * FIXED_PORT_SPAN);
        if (await canListenOn(port)) return port;
    }
    throw new Error(`No free loopback port found in ${PORT_PICK_ATTEMPTS} attempts`);
}

export type StartDaemonOptions = {
    hermetic: HermeticEnv;
    workerThreads?: number;
    script?: FakeScript;
    /**
     * How long a slow answer of the `slow`, `handoff-clean`, `invoke-parked`, `invoke-parked-slow-lead` and
     * `desk-steer` scripts is held back.
     */
    delayMs?: number;
    realModels?: boolean;
    /** Live tests only: the model new conversations use with `realModels`, instead of the pi agent folder's default. */
    model?: string;
    checkModel?: string;
    holdStart?: boolean;
    /** `false` applies no turn-end rule to leads (`true` by default), for tests about conversations, not jobs. */
    turnEndRule?: boolean;
    /** The child kills itself with `SIGKILL` the first time the Jobs component reaches this write point. */
    jobCrashAt?: WritePoint;
    /** The child kills itself with `SIGKILL` just before, or just after, the commit that creates the front desk. */
    deskCrashAt?: DeskCreatePoint;
    /**
     * The child kills itself with `SIGKILL` as the first steer of an agent (request id `steer:...`) has been placed
     * and its caller is still waiting, so the kill lands inside the steering tool call, before its result is saved.
     */
    killOnSteer?: boolean;
    /**
     * The child kills itself with `SIGKILL` in the `afterResume` of a component placed before the Jobs component: the
     * host has resumed and the inputs the repair owes are not yet delivered.
     */
    killAfterResume?: boolean;
    /**
     * Adds the network listener, with a `[network]` section on the loopback address written to the instance's
     * `config.toml` before the daemon starts. It listens on a free port, which `networkPort()` gives.
     */
    networkListener?: boolean;
    /** With `networkListener`: listens on this port, so a restart finds the same address (see `freeLoopbackPort`). */
    fixedPort?: number;
    /** With `networkListener`: keeps the component and writes no `[network]` section, so it opens no port. */
    omitNetworkSection?: boolean;
};

export type DaemonProcess = {
    pid: number;
    ready: Promise<void>;
    invoke(op: string, input: unknown): Promise<unknown>;
    release(): void;
    /** Lets the answers of the `gated` script through, now and from then on. */
    releaseRuns(): void;
    /** The port the network listener is in use on; rejects when it listens on none. */
    networkPort(): Promise<number>;
    stderr(): string;
    signal(sig: NodeJS.Signals): void;
    kill9(): void;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

type Reply = { id: number; result?: unknown; error?: { code: ServiceErrorCode; message: string } };
type Pending = { resolve(result: unknown): void; reject(error: Error): void };

function isReply(message: unknown): message is Reply {
    return typeof message === "object" && message !== null && typeof (message as Reply).id === "number";
}

function isReadyMessage(message: unknown): boolean {
    return typeof message === "object" && message !== null && (message as { ready?: unknown }).ready === true;
}

function directoryFlags(hermetic: HermeticEnv): string[] {
    return [
        "--config-dir",
        hermetic.configDir,
        "--state-dir",
        hermetic.stateDir,
        "--data-dir",
        hermetic.dataDir,
        "--runtime-dir",
        hermetic.runtimeDir,
    ];
}

function childSwitches(options: StartDaemonOptions): string {
    const { hermetic: _hermetic, ...switches } = options;
    return JSON.stringify(switches);
}

export function startDaemon(options: StartDaemonOptions): DaemonProcess {
    const child = fork(CHILD_ENTRY, [childSwitches(options), ...directoryFlags(options.hermetic)], {
        env: options.hermetic.env,
        cwd: options.hermetic.root,
        stdio: ["ignore", "ignore", "pipe", "ipc"],
    });
    guardProcess(child, options.hermetic.root);
    let stderrText = "";
    child.stderr?.on("data", (chunk) => {
        stderrText += chunk;
    });

    const pending = new Map<number, Pending>();
    let nextId = 1;
    let hasExited = false;
    const readyMessage = Promise.withResolvers<void>();

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
        child.on("exit", (code, signal) => {
            hasExited = true;
            const failure = new Error(`The daemon child exited (code ${code}, signal ${signal}) before answering`);
            for (const request of pending.values()) request.reject(failure);
            pending.clear();
            resolve({ code, signal });
        });
        // `close` follows `exit` once stderr has been read to its end, so the rejection can carry the child's error.
        child.on("close", (code, signal) => {
            const detail = stderrText.trim();
            const reason = `The daemon child exited (code ${code}, signal ${signal}) before answering`;
            readyMessage.reject(new Error(detail ? `${reason}: ${detail}` : reason));
        });
    });

    child.on("message", (message) => {
        if (isReadyMessage(message)) readyMessage.resolve();
        if (!isReply(message)) return;
        const request = pending.get(message.id);
        if (!request) return;
        pending.delete(message.id);
        if (message.error) request.reject(new ServiceError(message.error.code, message.error.message));
        else request.resolve(message.result);
    });

    function invoke(op: string, input: unknown): Promise<unknown> {
        if (hasExited) return Promise.reject(new Error(`The daemon child has exited; cannot invoke ${op}`));
        const id = nextId++;
        return new Promise((resolve, reject) => {
            pending.set(id, { resolve, reject });
            child.send({ id, op, input }, (error) => {
                if (!error) return;
                pending.delete(id);
                reject(error);
            });
        });
    }

    async function confirmReady(): Promise<void> {
        const timer = setTimeout(
            () => readyMessage.reject(new Error("The daemon child did not become ready")),
            READY_POLL_TIMEOUT_MS,
        );
        try {
            await readyMessage.promise;
        } finally {
            clearTimeout(timer);
        }
        const status = (await invoke("daemon.status", {})) as DaemonStatus;
        if (status.phase !== "ready") throw new Error(`daemon.status reported ${status.phase} after the ready message`);
    }

    const ready = confirmReady();
    // A test that never awaits `ready` must not crash on the rejection of a child that exits early.
    ready.catch(() => undefined);

    return {
        pid: child.pid ?? 0,
        ready,
        invoke,
        release: () => child.send({ release: true }),
        releaseRuns: () => child.send({ releaseRuns: true }),
        networkPort: async () => {
            const state = (await invoke(NETWORK_STATE_OPERATION, {})) as { port?: number };
            if (state.port === undefined) throw new Error("The daemon child has no network port in use");
            return state.port;
        },
        stderr: () => stderrText,
        signal: (sig) => child.kill(sig),
        kill9: () => child.kill("SIGKILL"),
        exited,
    };
}
