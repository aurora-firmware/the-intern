import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, unlink } from "node:fs/promises";
import { uptime } from "node:os";
import { join } from "node:path";

const LOCK_FILE_NAME = "owner.lock";
const LOCK_FILE_MODE = 0o600;
const BOOT_TIME_TOLERANCE_MS = 60_000;

type LockContent = { pid: number; bootTime: number; token: string };

export type OwnershipHandle = { release(): Promise<void> };

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
        const { pid, bootTime, token } = parsed as Record<string, unknown>;
        if (typeof pid !== "number" || typeof bootTime !== "number" || typeof token !== "string") return undefined;
        return { pid, bootTime, token };
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
    return isProcessAlive(lock.pid);
}

/** Creates the lock file exclusively; returns false when it already exists. */
async function tryCreateLock(lockPath: string, content: LockContent): Promise<boolean> {
    try {
        const file = await open(lockPath, "wx", LOCK_FILE_MODE);
        try {
            await file.writeFile(JSON.stringify(content));
        } finally {
            await file.close();
        }
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
        throw error;
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

/**
 * Takes the one-owner-per-database lock in the state directory. Refuses with OwnershipRefusedError while a live
 * daemon of the current boot holds it; takes over a stale lock.
 */
export async function acquireOwnership(stateDir: string): Promise<OwnershipHandle> {
    const lockPath = join(stateDir, LOCK_FILE_NAME);
    const content: LockContent = { pid: process.pid, bootTime: currentBootTime(), token: randomUUID() };
    if (await tryCreateLock(lockPath, content)) return createHandle(lockPath, content.token);

    const staleRaw = await readRaw(lockPath);
    const existing = staleRaw === undefined ? undefined : parseLock(staleRaw);
    if (isLive(existing)) throw new OwnershipRefusedError(stateDir, existing.pid);

    if (staleRaw !== undefined) {
        const takenOverBy = await clearStaleLock(lockPath, staleRaw);
        if (takenOverBy !== undefined) throw new OwnershipRefusedError(stateDir, takenOverBy);
    }
    if (await tryCreateLock(lockPath, content)) return createHandle(lockPath, content.token);
    throw new OwnershipRefusedError(stateDir, await currentOwnerPid(lockPath, 0));
}
