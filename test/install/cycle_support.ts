import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { scaled } from "../support/time_scale.ts";
import { MODEL_ID } from "./fake_model_server.ts";

export { startFakeModelServer } from "./fake_model_server.ts";

export type RunResult = { status: number | null; stdout: string; stderr: string };

/** A reply typed on the pseudo-terminal once the command's output shows the prompt. */
export type Answer = { prompt: string; reply: string };

export type RunOptions = {
    env?: Record<string, string>;
    /** Runs the command on a pseudo-terminal and types each reply in turn; its whole output is then `stdout`. */
    answers?: readonly Answer[];
    timeoutMs?: number;
};

/** The `bob` a command runs, and where its daemon listens when it is not the installed service's. */
export type BobTarget = { bob?: string; runtimeDir?: string; env?: Record<string, string> };

export type ServiceStatus = {
    registered: boolean;
    startsAtBoot: boolean;
    running: boolean;
    version: string | null;
    configDir: string | null;
    stateDir: string | null;
    dataDir: string | null;
    runtimeDir: string | null;
    piAgentDir: string | null;
};

export type JobView = { id: string; number: string; status: string; title: string };

const UNIT_NAME = "the-intern.service";
const INSTANCE_FOLDER = "the-intern";
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const FILE_MODE_BITS = 0o777;
const COMMAND_TIMEOUT_MS = scaled(120_000);
const STATE_TIMEOUT_MS = scaled(60_000);
const POLL_INTERVAL_MS = 100;
/** The PATH of every command: it holds no Node, as the rig's runner is not on it. */
const COMMAND_PATH = "/usr/local/bin:/usr/bin:/bin";

const home = (): string => homedir();

/** The installed `bob`, the link the install script makes. */
export const installedBob = (): string => join(home(), ".local", "bin", "bob");

function bundlesDir(): string {
    const dir = process.env.INSTALL_BUNDLES;
    if (!dir)
        throw new Error("INSTALL_BUNDLES names no folder: run the installation cycle with test/install/run_cycle.sh");
    return dir;
}

/** The download location `name` of the test bundles (`base`, `tampered`, ...). */
export const locationDir = (name: string): string => join(bundlesDir(), name);

function commandEnv(extra: Record<string, string> = {}): Record<string, string> {
    const inherited = ["HOME", "USER", "LOGNAME", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"].flatMap((name) => {
        const value = process.env[name];
        return value === undefined ? [] : [[name, value] as const];
    });
    return { PATH: COMMAND_PATH, HOME: home(), ...Object.fromEntries(inherited), ...extra };
}

function shellQuote(word: string): string {
    return `'${word.replaceAll("'", "'\\''")}'`;
}

function describeRun(command: string, args: readonly string[], status: number | null, output: string): string {
    return `${[command, ...args].join(" ")} exited ${status}: ${output}`;
}

/**
 * Runs `command` with a clean environment (`options.env` added) and resolves with its status and output once it ends.
 * It rejects, after killing the command, when the command runs past the timeout.
 */
export function runAs(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const env = commandEnv(options.env);
    const answers = options.answers ?? [];
    const onTerminal = answers.length > 0;
    const line = [command, ...args].map(shellQuote).join(" ");
    const child = onTerminal
        ? spawn("script", ["-qfec", `exec ${line}`, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"] })
        : spawn(command, args, { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let scanned = 0;
    let next = 0;
    child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
        for (let found = answers[next]; found !== undefined; found = answers[next]) {
            const at = stdout.indexOf(found.prompt, scanned);
            if (at < 0) return;
            scanned = at + found.prompt.length;
            next += 1;
            child.stdin?.write(`${found.reply}\n`);
        }
    });
    child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    return new Promise<RunResult>((resolve, reject) => {
        const timeoutMs = options.timeoutMs ?? COMMAND_TIMEOUT_MS;
        const timer = setTimeout(() => {
            child.kill("SIGKILL");
            reject(
                new Error(`${describeRun(command, args, null, `${stdout}${stderr}`)} (no end within ${timeoutMs} ms)`),
            );
        }, timeoutMs);
        child.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.once("close", (status) => {
            clearTimeout(timer);
            resolve({ status, stdout, stderr });
        });
    });
}

async function runChecked(command: string, args: readonly string[], options: RunOptions = {}): Promise<RunResult> {
    const result = await runAs(command, args, options);
    if (result.status !== 0)
        throw new Error(describeRun(command, args, result.status, `${result.stdout}${result.stderr}`));
    return result;
}

/**
 * Writes the test's pi agent folder: `models.json` with one OpenAI-style provider at `baseUrl`, `settings.json` naming
 * its model as the default, and an empty `auth.json`. The folder and its files are owner-only.
 */
export async function writePiAgentDir(piAgentDir: string, baseUrl: string): Promise<void> {
    const files = {
        "models.json": {
            providers: {
                loopback: {
                    baseUrl,
                    api: "openai-completions",
                    apiKey: "not-a-real-key",
                    models: [{ id: MODEL_ID, reasoning: false }],
                },
            },
        },
        "settings.json": { defaultProvider: "loopback", defaultModel: MODEL_ID },
        "auth.json": {},
    };
    await mkdir(piAgentDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await chmod(piAgentDir, OWNER_ONLY_DIR_MODE);
    for (const [file, content] of Object.entries(files)) {
        await writeFile(join(piAgentDir, file), JSON.stringify(content), { mode: OWNER_ONLY_FILE_MODE });
    }
}

/** Runs `install.sh` of the download location `location`, which also serves as `BOB_RELEASE_URL`. */
export function runInstallScript(
    location: string,
    args: readonly string[] = [],
    options: RunOptions = {},
): Promise<RunResult> {
    const folder = locationDir(location);
    const env = { BOB_RELEASE_URL: folder, ...options.env };
    return runAs("sh", [join(folder, "install.sh"), ...args], { ...options, env });
}

/** Polls `read` until `isDone` accepts its value; rejects at the timeout naming `what` and the last value seen. */
export async function waitUntil<T>(
    what: string,
    read: () => Promise<T>,
    isDone: (value: T) => boolean,
    timeoutMs: number = STATE_TIMEOUT_MS,
): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let last: T | undefined;
    do {
        last = await read();
        if (isDone(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    } while (Date.now() < deadline);
    throw new Error(`${what} did not happen within ${timeoutMs} ms; last seen ${JSON.stringify(last)}`);
}

async function commandLinesRunning(): Promise<string[]> {
    const lines: string[] = [];
    for (const entry of await readdir("/proc")) {
        if (!/^\d+$/.test(entry)) continue;
        try {
            lines.push((await readFile(join("/proc", entry, "cmdline"), "utf8")).split("\0").join(" ").trim());
        } catch {
            // The process ended between the listing and the read: it is no longer a candidate.
        }
    }
    return lines;
}

/** Waits until a process runs whose whole command line, words joined by spaces, ends with `commandLine`. */
export async function waitForProcess(commandLine: string, timeoutMs: number = STATE_TIMEOUT_MS): Promise<void> {
    await waitUntil(
        `a process running ${commandLine}`,
        commandLinesRunning,
        (lines) => lines.some((line) => line.endsWith(commandLine)),
        timeoutMs,
    );
}

async function bobJson<T>(target: BobTarget, args: readonly string[]): Promise<T> {
    const runtime = target.runtimeDir === undefined ? [] : ["--runtime-dir", target.runtimeDir];
    const result = await runChecked(target.bob ?? installedBob(), [...args, "--json", ...runtime], { env: target.env });
    return JSON.parse(result.stdout) as T;
}

/** Waits until `bob service status --json` shows every field of `expected`, and returns the status it showed. */
export function waitForServiceState(
    expected: Partial<ServiceStatus>,
    target: BobTarget = {},
    timeoutMs: number = STATE_TIMEOUT_MS,
): Promise<ServiceStatus> {
    const matches = (status: ServiceStatus): boolean =>
        Object.entries(expected).every(([name, value]) => status[name as keyof ServiceStatus] === value);
    return waitUntil(
        `the service showing ${JSON.stringify(expected)}`,
        () => bobJson<ServiceStatus>(target, ["service", "status"]),
        matches,
        timeoutMs,
    );
}

/** Creates a job with `bob jobs create`, and returns it as the command printed it. */
export function createJob(text: string, target: BobTarget = {}): Promise<JobView> {
    return bobJson<JobView>(target, ["jobs", "create", text]);
}

/** Lists the jobs, newest first, with `bob jobs list`. */
export async function listJobs(target: BobTarget = {}): Promise<JobView[]> {
    return (await bobJson<{ jobs: JobView[] }>(target, ["jobs", "list"])).jobs;
}

/** The permission bits of a file or folder, such as `0o600`. */
export function fileMode(path: string): number {
    return statSync(path).mode & FILE_MODE_BITS;
}

/**
 * Removes what a test installed without `bob uninstall`: the service (stopped, disabled, its unit file removed and the
 * manager reloaded), the program folder, the `bob` link, the instance directories at their default places, and the
 * test's own folders (its pi agent folder among them). A service that was never registered is not an error.
 */
export async function cleanUpInstall(folders: readonly string[] = []): Promise<void> {
    const unitFile = join(home(), ".config", "systemd", "user", UNIT_NAME);
    // `stop` and `disable` fail when the unit is not there, which is the state this clean-up wants.
    await runAs("systemctl", ["--user", "stop", UNIT_NAME]);
    await runAs("systemctl", ["--user", "disable", UNIT_NAME]);
    await rm(unitFile, { force: true });
    await runChecked("systemctl", ["--user", "daemon-reload"]);
    await runAs("systemctl", ["--user", "reset-failed", UNIT_NAME]);
    const runtime = process.env.XDG_RUNTIME_DIR;
    const instance = [
        join(home(), ".config", INSTANCE_FOLDER),
        join(home(), ".local", "state", INSTANCE_FOLDER),
        join(home(), ".local", "share", INSTANCE_FOLDER),
        ...(runtime ? [join(runtime, INSTANCE_FOLDER)] : []),
    ];
    const targets = [join(home(), ".local", "lib", INSTANCE_FOLDER), installedBob(), ...instance, ...folders];
    for (const target of targets) await rm(target, { recursive: true, force: true });
}
