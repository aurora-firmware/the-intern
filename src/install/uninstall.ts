/**
 * `bob uninstall` (S-010 REQ-010): under `install.lock`, which first finishes a cut-off operation, it stops and removes
 * the service, turns lingering off when `bob service install` turned it on, asks whether to keep the instance's data,
 * and removes the `bob` link and the program folder, which goes last since the command runs from it. Notices and
 * questions go to standard error; the kept directories are printed to standard output. It imports only the
 * installation modules (ADR-005 decision 2).
 */
import { lstat, readlink, rm } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { writeError, writeLine } from "../cli/output.ts";
import { resolveInstanceDirs } from "../daemon/state_layout.ts";
import type { ProgramLayout } from "./program_layout.ts";
import { type ServiceCommandContext, withInstallLock } from "./service_commands.ts";
import {
    type CommandRunner,
    nodeCommandRunner,
    readServiceRecord,
    removeServiceRecord,
    type ServiceRecord,
    ServiceRefusedError,
    unhold,
} from "./service_manager.ts";
import { type Ask, askYesNo } from "./upgrade_steps.ts";

export type UninstallInput = {
    context: ServiceCommandContext;
    yes: boolean;
    removeData: boolean;
    ask?: Ask;
    /** Runs `loginctl` and `sudo`. Defaults to the real commands. */
    runner?: CommandRunner;
    /** The account whose lingering is turned off. Defaults to the current account. */
    user?: string;
};

/** Turns lingering off as the account, then through sudo (asking for a password only on a terminal). */
async function turnLingerOff(input: UninstallInput): Promise<void> {
    const runner = input.runner ?? nodeCommandRunner;
    const user = input.user ?? userInfo().username;
    if ((await runner("loginctl", ["disable-linger"])).code === 0) return;
    const isTerminal = input.context.io.isStdinTerminal;
    const args = isTerminal ? ["loginctl", "disable-linger", user] : ["-n", "loginctl", "disable-linger", user];
    const result = await runner("sudo", args, { stdin: isTerminal ? "inherit" : "ignore" });
    if (result.code !== 0) {
        throw new ServiceRefusedError(
            `admin rights were refused: turning lingering off for ${user} needs them; ` +
                `run \`sudo loginctl disable-linger ${user}\` yourself, then run \`bob uninstall\` again`,
        );
    }
}

/** Stops and removes the service as `bob service remove` does, then turns lingering off when `bob` turned it on. */
async function removeService(input: UninstallInput, record: ServiceRecord): Promise<void> {
    const { context } = input;
    const manager = context.managerFor(record.platform);
    // A rerun after a refused lingering change finds the service already removed: stopping it again would fail.
    if ((await manager.state(record)).registered) {
        await manager.stop(record);
        await manager.remove(record, { writeLine: (text) => writeError(context.io, text) });
    }
    if (record.platform === "linux-x64" && record.lingerTurnedOn) {
        writeError(context.io, "Turning off lingering (admin rights may be asked).");
        await turnLingerOff(input);
    }
    await removeServiceRecord(context.layout);
    await unhold(context.layout);
}

/** Whether to keep the data: `--remove-data` removes, `--yes` or no terminal keeps, a terminal is asked. */
async function shouldKeepData(input: UninstallInput): Promise<boolean> {
    const { io } = input.context;
    if (input.removeData) return false;
    if (input.yes || !io.isStdinTerminal) return true;
    const ask = input.ask ?? ((question, defaultYes) => askYesNo(io, question, defaultYes));
    return ask("Keep the instance's data?", true);
}

function isInside(inner: string, outer: string): boolean {
    const path = relative(outer, inner);
    return path !== "" && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

/** Removes `~/.local/bin/bob` when it is a link into the program folder; any other file there isn't ours. */
async function removeBobLink(layout: ProgramLayout): Promise<void> {
    const stats = await lstat(layout.bobLink).catch(() => undefined);
    if (stats === undefined || !stats.isSymbolicLink()) return;
    const target = resolve(dirname(layout.bobLink), await readlink(layout.bobLink));
    if (isInside(target, resolve(layout.root))) await rm(layout.bobLink, { force: true });
}

function instanceDirsOf(context: ServiceCommandContext, record: ServiceRecord | null): string[] {
    const { env, homeDir } = context.io;
    const flags = record === null ? {} : record;
    const dirs = resolveInstanceDirs({ flags, env, homeDir });
    return [dirs.configDir, dirs.stateDir, dirs.dataDir, dirs.runtimeDir];
}

async function uninstallSteps(input: UninstallInput): Promise<number> {
    const { context } = input;
    const { io, layout } = context;
    const record = await readServiceRecord(layout);
    if (record === null) writeError(io, "No service is registered.");
    else await removeService(input, record);
    const instanceDirs = instanceDirsOf(context, record);
    const isKept = await shouldKeepData(input);
    await removeBobLink(layout);
    if (isKept) {
        writeLine(io, "Kept the instance's directories:");
        for (const dir of instanceDirs) writeLine(io, dir);
    } else {
        for (const dir of instanceDirs) await rm(dir, { recursive: true, force: true });
    }
    await rm(layout.root, { recursive: true, force: true });
    return 0;
}

/** Runs `bob uninstall`: 0 when done, 1 with the reason on standard error for any failure. */
export async function runUninstall(input: UninstallInput): Promise<number> {
    const { context } = input;
    try {
        return await withInstallLock(context.layout, "uninstall", context.resumers, () => uninstallSteps(input));
    } catch (error) {
        writeError(context.io, error instanceof Error ? error.message : String(error));
        return 1;
    }
}
