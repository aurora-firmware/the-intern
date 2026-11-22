import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { uptime } from "node:os";
import { join } from "node:path";

const OWNER_LOCK_FILE_NAME = "owner.lock";
const INSTALL_LOCK_FILE_NAME = "install.lock";
const LOCK_FILE_MODE = 0o600;
const BOOT_TIME_TOLERANCE_MS = 60_000;

type LockContent = { pid: number; bootTime: number; token: string; command?: string };

export type OwnershipHandle = { release(): Promise<void> };

export class InstallLockRefusedError extends Error {
    commandName: string;
    ownerPid: number;

    constructor(commandName: string, ownerPid: number) {
        super(`${commandName} is running (pid ${ownerPid})`);
        this.name = "InstallLockRefusedError";
        this.commandName = commandName;
        this.ownerPid = ownerPid;
    }
}

export class OwnershipRefusedError extends Error {
    stateDir: string;
    ownerPid: number;

    constructor(stateDir: string, ownerPid: number) {
        super(`State directory ${stateDir} is owned by a running daemon (pid ${ownerPid})`);
        this.name = "OwnershipRefusedError";
        this.stateDir = stateDir;
        this.ownerPid = ownerPid;
    }
}

function currentBootTime(): number {
    return Math.round((Date.now() - uptime() * 1000) / 1000) * 1000;
}

function parseLock(raw: string): LockContent | undefined {
    try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "object" || parsed === null) return undefined;
        const { pid, bootTime, token, command } = parsed as Record<string, unknown>;
        if (typeof pid !== "number" || typeof bootTime !== "number" || typeof token !== "string") return undefined;
        return { pid, bootTime, token, command: typeof command === "string" ? command : undefined };
    } catch {
        return undefined;
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function isLive(lock: LockContent | undefined): lock is LockContent {
    if (lock === undefined) return false;
    if (Math.abs(lock.bootTime - currentBootTime()) > BOOT_TIME_TOLERANCE_MS) return false;
    // The checker is itself running, so a lock naming its pid was left by a dead holder whose pid was reused.
    if (lock.pid === process.pid) return false;
    return isProcessAlive(lock.pid);
}

/**
 * Creates the lock file exclusively and complete: the content is written to a private temporary file that is then
 * linked to the lock path, so no reader ever sees an empty lock. Returns false when the lock already exists.
 */
async function tryCreateLock(lockPath: string, content: LockContent): Promise<boolean> {
    const draftPath = `${lockPath}.${randomUUID()}.draft`;
    const file = await open(draftPath, "wx", LOCK_FILE_MODE);
    try {
        await file.writeFile(JSON.stringify(content));
    } finally {
        await file.close();
    }
    try {
        await link(draftPath, lockPath);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
    } finally {
        await unlink(draftPath);
    }
}

async function readRaw(path: string): Promise<string | undefined> {
    try {
        return await readFile(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
}

/** Reads the pid of whoever holds the lock now, for the refusal message. */
async function currentOwnerPid(lockPath: string, fallbackPid: number): Promise<number> {
    const raw = await readRaw(lockPath);
    return (raw === undefined ? undefined : parseLock(raw))?.pid ?? fallbackPid;
}

/**
 * Moves the stale lock aside and checks it is still the content judged stale. When another daemon took over first,
 * puts the displaced file back and returns that file's pid so the caller can refuse; returns undefined when the
 * stale lock was removed and the exclusive create may be retried.
 */
async function clearStaleLock(lockPath: string, staleRaw: string): Promise<number | undefined> {
    const asidePath = `${lockPath}.${randomUUID()}`;
    try {
        await rename(lockPath, asidePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
    }
    const movedRaw = await readRaw(asidePath);
    if (movedRaw === staleRaw) {
        await unlink(asidePath);
        return undefined;
    }
    const movedPid = (movedRaw === undefined ? undefined : parseLock(movedRaw))?.pid ?? 0;
    try {
        await link(asidePath, lockPath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    await unlink(asidePath);
    return currentOwnerPid(lockPath, movedPid);
}

function createHandle(lockPath: string, token: string): OwnershipHandle {
    return {
        async release() {
            const raw = await readRaw(lockPath);
            if (raw === undefined || parseLock(raw)?.token !== token) return;
            await unlink(lockPath);
        },
    };
}

type Acquisition = { holder: LockContent } | { handle: OwnershipHandle };

/**
 * Takes the lock at lockPath with the given content. Returns the handle, or the live holder's content when a live
 * process of the current boot holds it; takes over a stale lock.
 */
async function acquireLock(lockPath: string, content: LockContent): Promise<Acquisition> {
    if (await tryCreateLock(lockPath, content)) return { handle: createHandle(lockPath, content.token) };

    const staleRaw = await readRaw(lockPath);
    const existing = staleRaw === undefined ? undefined : parseLock(staleRaw);
    if (isLive(existing)) return { holder: existing };

    if (staleRaw !== undefined) {
        const takenOverBy = await clearStaleLock(lockPath, staleRaw);
        if (takenOverBy !== undefined) return { holder: await currentHolder(lockPath, takenOverBy) };
    }
    if (await tryCreateLock(lockPath, content)) return { handle: createHandle(lockPath, content.token) };
    return { holder: await currentHolder(lockPath, 0) };
}

async function currentHolder(lockPath: string, fallbackPid: number): Promise<LockContent> {
    const raw = await readRaw(lockPath);
    const parsed = raw === undefined ? undefined : parseLock(raw);
    return parsed ?? { pid: fallbackPid, bootTime: 0, token: "" };
}

/**
 * Takes the one-owner-per-database lock in the state directory. Refuses with OwnershipRefusedError while a live
 * daemon of the current boot holds it; takes over a stale lock.
 */
export async function acquireOwnership(stateDir: string): Promise<OwnershipHandle> {
    const content: LockContent = { pid: process.pid, bootTime: currentBootTime(), token: randomUUID() };
    const result = await acquireLock(join(stateDir, OWNER_LOCK_FILE_NAME), content);
    if ("handle" in result) return result.handle;
    throw new OwnershipRefusedError(stateDir, result.holder.pid);
}

/**
 * Takes the one-installation-command-at-a-time lock in the program folder. Refuses with InstallLockRefusedError,
 * naming the command the holder wrote, while a live process holds it; takes over a stale lock.
 */
export async function acquireInstallLock(programDir: string, commandName: string): Promise<OwnershipHandle> {
    const content: LockContent = {
        pid: process.pid,
        bootTime: currentBootTime(),
        token: randomUUID(),
        command: commandName,
    };
    const result = await acquireLock(join(programDir, INSTALL_LOCK_FILE_NAME), content);
    if ("handle" in result) return result.handle;
    throw new InstallLockRefusedError(result.holder.command ?? "an installation command", result.holder.pid);
}

/** Returns the owner lock's pid and token when a live daemon holds it, or undefined when it is absent or stale. */
export async function readOwnerLock(stateDir: string): Promise<{ pid: number; token: string } | undefined> {
    const raw = await readRaw(join(stateDir, OWNER_LOCK_FILE_NAME));
    const lock = raw === undefined ? undefined : parseLock(raw);
    return isLive(lock) ? { pid: lock.pid, token: lock.token } : undefined;
}
