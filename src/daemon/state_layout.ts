import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const INSTANCE_FOLDER_NAME = "the-intern";
const OWNER_ONLY_MODE = 0o700;
const GROUP_AND_OTHER_BITS = 0o077;

export const LOCAL_SOCKET_FILE = "bob.sock";

export function localSocketPath(runtimeDir: string): string {
    return join(runtimeDir, LOCAL_SOCKET_FILE);
}

export type InstanceDirFlags = { configDir?: string; stateDir?: string; dataDir?: string; runtimeDir?: string };

export type InstanceDirs = {
    configDir: string;
    stateDir: string;
    dataDir: string;
    runtimeDir: string;
    configFile: string;
    databaseFile: string;
};

export class InstanceDirError extends Error {
    path: string;
    reason: string;

    constructor(path: string, reason: string) {
        super(`Instance directory ${path}: ${reason}`);
        this.name = "InstanceDirError";
        this.path = path;
        this.reason = reason;
    }
}

function requireAbsoluteFlag(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    if (!isAbsolute(value)) throw new InstanceDirError(value, "a directory flag must be an absolute path");
    return value;
}

function xdgBase(env: NodeJS.ProcessEnv, variable: string, fallback: string): string {
    const value = env[variable];
    return value && isAbsolute(value) ? value : fallback;
}

/** Resolves the instance directories from flags, environment and home directory, without touching the disk. */
export function resolveInstanceDirs(input: {
    flags: InstanceDirFlags;
    env: NodeJS.ProcessEnv;
    homeDir: string;
}): InstanceDirs {
    const { flags, env, homeDir } = input;
    const configDir =
        requireAbsoluteFlag(flags.configDir) ??
        join(xdgBase(env, "XDG_CONFIG_HOME", join(homeDir, ".config")), INSTANCE_FOLDER_NAME);
    const stateDir =
        requireAbsoluteFlag(flags.stateDir) ??
        join(xdgBase(env, "XDG_STATE_HOME", join(homeDir, ".local", "state")), INSTANCE_FOLDER_NAME);
    const dataDir =
        requireAbsoluteFlag(flags.dataDir) ??
        join(xdgBase(env, "XDG_DATA_HOME", join(homeDir, ".local", "share")), INSTANCE_FOLDER_NAME);
    const runtimeFlag = requireAbsoluteFlag(flags.runtimeDir);
    const xdgRuntime = env.XDG_RUNTIME_DIR;
    const runtimeDir =
        runtimeFlag ??
        (xdgRuntime && isAbsolute(xdgRuntime) ? join(xdgRuntime, INSTANCE_FOLDER_NAME) : join(stateDir, "run"));

    return {
        configDir,
        stateDir,
        dataDir,
        runtimeDir,
        configFile: join(configDir, "config.toml"),
        databaseFile: join(stateDir, "the-intern.sqlite"),
    };
}

async function statIfPresent(path: string) {
    try {
        return await stat(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

async function refuseUnsafeExistingDir(path: string): Promise<boolean> {
    const info = await statIfPresent(path);
    if (info === undefined) return false;
    if (!info.isDirectory()) throw new InstanceDirError(path, "the path exists but is not a directory");
    if (info.uid !== process.getuid?.()) {
        throw new InstanceDirError(path, "the directory is not owned by the service account");
    }
    if ((info.mode & GROUP_AND_OTHER_BITS) !== 0) {
        throw new InstanceDirError(path, "the directory is accessible to the group or others");
    }
    return true;
}

async function createPrivateDir(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    // mkdir's mode is masked by the umask, so the mode is set explicitly as well.
    await mkdir(path, { mode: OWNER_ONLY_MODE });
    await chmod(path, OWNER_ONLY_MODE);
}

/**
 * Creates each missing instance directory with mode 0700. Every existing path is checked first, so a refusal
 * changes nothing. The state directory comes before the runtime directory, whose fallback lives inside it.
 */
export async function ensureInstanceDirs(dirs: InstanceDirs): Promise<void> {
    const ordered = [dirs.configDir, dirs.stateDir, dirs.dataDir, dirs.runtimeDir];
    const missing: string[] = [];
    for (const path of ordered) {
        if (!(await refuseUnsafeExistingDir(path))) missing.push(path);
    }
    for (const path of missing) {
        await createPrivateDir(path);
    }
}
