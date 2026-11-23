import { type FileHandle, lstat, open, readFile, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fingerprintOf } from "../config/config_file.ts";

export const MAX_FILE_BYTES = 1024 * 1024;

const NEW_FILE_MODE = 0o600;
const PERMISSION_BITS = 0o7777;

export type FileRefusedKind = "not_found" | "invalid" | "conflict";

export class FileRefusedError extends Error {
    readonly kind: FileRefusedKind;
    readonly path: string;
    readonly reason: string;

    constructor(kind: FileRefusedKind, path: string, reason: string) {
        super(`${path}: ${reason}`);
        this.name = "FileRefusedError";
        this.kind = kind;
        this.path = path;
        this.reason = reason;
    }
}

export type FileChangeKind = "common" | "role" | "instructions" | "workspace" | "skill";

export type FileChange = { path: string; kind: FileChangeKind };

export type FileChangeHub = {
    publish(change: FileChange): void;
    onChange(listener: (change: FileChange) => void): () => void;
};

export type FileText = { text: string; version: string };

export type WriteOptions = { version?: string; announce?: FileChangeKind };

export type FileStore = {
    enqueue<T>(job: () => Promise<T>): Promise<T>;
    read(path: string): Promise<FileText>;
    write(path: string, text: string, options?: WriteOptions): Promise<string>;
    remove(path: string, options?: { announce?: FileChangeKind }): Promise<void>;
    /** Tells the feed a file changed, for a writer that changed it inside the queue without `write`. */
    announce(path: string, kind: FileChangeKind): void;
};

export function createFileChangeHub(): FileChangeHub {
    const listeners = new Set<(change: FileChange) => void>();
    return {
        // The change is already on disk, so a failing listener is reported as a warning and never fails the write.
        publish(change) {
            for (const listener of listeners) {
                try {
                    listener(change);
                } catch (error) {
                    process.emitWarning(`a file change listener for ${change.path} threw: ${(error as Error).message}`);
                }
            }
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}

function errorCode(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException).code;
}

async function readBytes(path: string): Promise<Buffer> {
    try {
        const info = await stat(path);
        if (info.isDirectory()) throw new FileRefusedError("invalid", path, "it is a folder, not a file");
        if (info.size > MAX_FILE_BYTES) {
            throw new FileRefusedError("invalid", path, `the file is over ${MAX_FILE_BYTES} bytes`);
        }
        const bytes = await readFile(path);
        if (bytes.length > MAX_FILE_BYTES) {
            throw new FileRefusedError("invalid", path, `the file is over ${MAX_FILE_BYTES} bytes`);
        }
        return bytes;
    } catch (error) {
        if (error instanceof FileRefusedError) throw error;
        if (errorCode(error) === "ENOENT") throw new FileRefusedError("not_found", path, "the file doesn't exist");
        throw error;
    }
}

function decodeUtf8(path: string, bytes: Buffer): string {
    try {
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        throw new FileRefusedError("invalid", path, "the file isn't valid UTF-8 text");
    }
}

// A symbolic link is resolved so the temporary file lands next to the real file and the link survives the rename.
async function resolveTarget(path: string): Promise<string> {
    try {
        return await realpath(path);
    } catch (error) {
        if (errorCode(error) === "ENOENT") return path;
        throw error;
    }
}

async function existingFile(path: string): Promise<{ mode: number; gid: number | undefined }> {
    try {
        const info = await lstat(path);
        return { mode: info.mode & PERMISSION_BITS, gid: info.gid };
    } catch (error) {
        if (errorCode(error) === "ENOENT") return { mode: NEW_FILE_MODE, gid: undefined };
        throw error;
    }
}

// Only a group the service account belongs to can be set; EPERM means the file keeps the service account's own group.
async function keepGroup(handle: FileHandle, gid: number | undefined): Promise<void> {
    if (gid === undefined) return;
    try {
        await handle.chown(-1, gid);
    } catch (error) {
        if (errorCode(error) !== "EPERM") throw error;
    }
}

let temporaryCounter = 0;

// The unqueued write, for use inside an `enqueue` job. The temporary file sits in the same folder so the rename stays
// on one file system and is atomic. It takes the target's mode bits and, where the service account may set it, the
// target's group; its owner becomes the service account (ADR-002 decision 6).
export async function writeFileAtomic(path: string, bytes: Buffer | string): Promise<void> {
    const target = await resolveTarget(path);
    const { mode, gid } = await existingFile(target);
    temporaryCounter += 1;
    const temporary = join(dirname(target), `.${basename(target)}.${process.pid}.${temporaryCounter}.tmp`);
    try {
        const handle = await open(temporary, "w", mode);
        try {
            await handle.chmod(mode);
            await keepGroup(handle, gid);
            await handle.writeFile(bytes);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, target);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

export function createFileStore(options: { changes?: () => FileChangeHub | undefined } = {}): FileStore {
    let queue: Promise<unknown> = Promise.resolve();

    function enqueue<T>(job: () => Promise<T>): Promise<T> {
        const result = queue.then(job);
        queue = result.catch(() => undefined);
        return result;
    }

    function announce(path: string, kind: FileChangeKind | undefined): void {
        if (kind !== undefined) options.changes?.()?.publish({ path, kind });
    }

    async function applyWrite(path: string, text: string, writeOptions: WriteOptions): Promise<string> {
        if (writeOptions.version !== undefined) {
            const current = fingerprintOf(await readBytes(path));
            if (current !== writeOptions.version) {
                throw new FileRefusedError("conflict", path, "the file changed since it was read");
            }
        }
        const bytes = Buffer.from(text, "utf8");
        await writeFileAtomic(path, bytes);
        announce(path, writeOptions.announce);
        return fingerprintOf(bytes);
    }

    return {
        enqueue,
        announce,
        async read(path) {
            const bytes = await readBytes(path);
            return { text: decodeUtf8(path, bytes), version: fingerprintOf(bytes) };
        },
        write(path, text, writeOptions = {}) {
            if (Buffer.byteLength(text, "utf8") > MAX_FILE_BYTES) {
                return Promise.reject(
                    new FileRefusedError("invalid", path, `the text is over ${MAX_FILE_BYTES} bytes`),
                );
            }
            return enqueue(() => applyWrite(path, text, writeOptions));
        },
        remove(path, removeOptions = {}) {
            return enqueue(async () => {
                try {
                    await rm(path);
                } catch (error) {
                    if (errorCode(error) === "ENOENT") {
                        throw new FileRefusedError("not_found", path, "the file doesn't exist");
                    }
                    throw error;
                }
                announce(path, removeOptions.announce);
            });
        },
    };
}
