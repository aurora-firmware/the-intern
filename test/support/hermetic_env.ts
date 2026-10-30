import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const OWNER_ONLY_MODE = 0o700;
const DROPPED_VARIABLE_PREFIXES = ["BOB_", "PI_"];

export type HermeticEnv = {
    root: string;
    configDir: string;
    stateDir: string;
    dataDir: string;
    runtimeDir: string;
    piAgentDir: string;
    env: NodeJS.ProcessEnv;
    dispose(): Promise<void>;
};

function inheritedEnvWithoutProductVariables(): NodeJS.ProcessEnv {
    const inherited: NodeJS.ProcessEnv = {};
    for (const [name, value] of Object.entries(process.env)) {
        if (DROPPED_VARIABLE_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
        inherited[name] = value;
    }
    return inherited;
}

async function createPrivateDir(path: string): Promise<string> {
    // mkdir's mode is masked by the umask, so the mode is set explicitly as well.
    await mkdir(path, { mode: OWNER_ONLY_MODE });
    await chmod(path, OWNER_ONLY_MODE);
    return path;
}

/**
 * Makes a fresh temporary root with owner-only config, state, data, runtime and pi agent directories, and an
 * environment for child processes that points at them, so tests never touch personal configuration or a running
 * service.
 */
export async function createHermeticEnv(): Promise<HermeticEnv> {
    const root = await realpath(await mkdtemp(join(tmpdir(), "bob-hermetic-")));
    const configDir = await createPrivateDir(join(root, "config"));
    const stateDir = await createPrivateDir(join(root, "state"));
    const dataDir = await createPrivateDir(join(root, "data"));
    const runtimeDir = await createPrivateDir(join(root, "runtime"));
    const piAgentDir = await createPrivateDir(join(root, "pi-agent"));

    const env: NodeJS.ProcessEnv = {
        ...inheritedEnvWithoutProductVariables(),
        HOME: root,
        XDG_CONFIG_HOME: configDir,
        XDG_STATE_HOME: stateDir,
        XDG_DATA_HOME: dataDir,
        XDG_RUNTIME_DIR: runtimeDir,
        PI_CODING_AGENT_DIR: piAgentDir,
    };

    return {
        root,
        configDir,
        stateDir,
        dataDir,
        runtimeDir,
        piAgentDir,
        env,
        dispose: () => rm(root, { recursive: true, force: true }),
    };
}
