import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readdir, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const SECRET_FILE_SUFFIX = ".json";
const KEY_PATTERN = /^([A-Za-z0-9_-][A-Za-z0-9._-]*)\/([A-Za-z0-9_-][A-Za-z0-9._-]*)$/;

/** One account's secret values. Each is optional: an account holds the ones its sign-in method uses. */
export type AccountSecret = {
    password?: string;
    clientSecret?: string;
    refreshToken?: string;
    accessToken?: string;
    accessTokenExpiresAt?: number;
};

export type SecretsStore = {
    /** The secret under a key, or undefined when none is stored. */
    read(key: string): Promise<AccountSecret | undefined>;
    write(key: string, secret: AccountSecret): Promise<void>;
    /** Removes a key's file; a key with no file is not an error. */
    remove(key: string): Promise<void>;
    keys(): Promise<string[]>;
    removeAllExcept(keys: readonly string[]): Promise<void>;
};

/** A store failure. The message names the key and the cause, and never holds a secret value. */
export class SecretsStoreError extends Error {
    key: string;
    reason: string;

    constructor(key: string, reason: string) {
        super(`Secrets store, key ${key}: ${reason}`);
        this.name = "SecretsStoreError";
        this.key = key;
        this.reason = reason;
    }
}

// The cause is the error code only: a parser's message can quote the text it failed on, which is a secret.
function causeOf(error: unknown): string {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    return typeof code === "string" ? code : "an unexpected error";
}

function splitKey(key: string): { owner: string; name: string } {
    const match = KEY_PATTERN.exec(key);
    if (match === null) throw new SecretsStoreError(key, "a key must be <owner>/<name> of letters, digits, . _ -");
    return { owner: match[1] as string, name: match[2] as string };
}

function isAccountSecret(value: unknown): value is AccountSecret {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const record = value as Record<string, unknown>;
    const texts = ["password", "clientSecret", "refreshToken", "accessToken"];
    if (texts.some((field) => record[field] !== undefined && typeof record[field] !== "string")) return false;
    const expiry = record.accessTokenExpiresAt;
    return expiry === undefined || typeof expiry === "number";
}

async function writeWhole(file: string, text: string): Promise<void> {
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", OWNER_ONLY_FILE_MODE);
    try {
        await handle.writeFile(text);
        await handle.sync();
    } catch (error) {
        await handle.close();
        await unlink(temporary).catch(() => {});
        throw error;
    }
    await handle.close();
    try {
        await rename(temporary, file);
    } catch (error) {
        await unlink(temporary).catch(() => {});
        throw error;
    }
}

async function syncDirectory(dir: string): Promise<void> {
    const handle = await open(dir, "r");
    try {
        await handle.sync();
    } finally {
        await handle.close();
    }
}

export function createSecretsStore(options: { secretsDir: string }): SecretsStore {
    const { secretsDir } = options;
    let queue: Promise<unknown> = Promise.resolve();

    function fileOf(owner: string, name: string): string {
        return join(secretsDir, owner, `${name}${SECRET_FILE_SUFFIX}`);
    }

    // Writes and removals run one at a time, in the order they were requested; a failure does not stop the queue.
    function enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = queue.then(task, task);
        queue = run.catch(() => {});
        return run;
    }

    async function read(key: string): Promise<AccountSecret | undefined> {
        const { owner, name } = splitKey(key);
        let text: string;
        try {
            text = await readFile(fileOf(owner, name), "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
            throw new SecretsStoreError(key, `the secret could not be read (${causeOf(error)})`);
        }
        let parsed: unknown;
        try {
            parsed = JSON.parse(text);
        } catch {
            throw new SecretsStoreError(key, "the stored secret is not valid JSON");
        }
        if (!isAccountSecret(parsed)) throw new SecretsStoreError(key, "the stored secret has an unexpected shape");
        return parsed;
    }

    async function writeNow(key: string, secret: AccountSecret): Promise<void> {
        const { owner, name } = splitKey(key);
        if (!isAccountSecret(secret)) throw new SecretsStoreError(key, "the secret has an unexpected shape");
        const ownerDir = join(secretsDir, owner);
        try {
            await mkdir(ownerDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
            await chmod(ownerDir, OWNER_ONLY_DIR_MODE);
            await writeWhole(fileOf(owner, name), JSON.stringify(secret));
            await syncDirectory(ownerDir);
        } catch (error) {
            throw new SecretsStoreError(key, `the secret could not be written (${causeOf(error)})`);
        }
    }

    async function removeNow(key: string): Promise<void> {
        const { owner, name } = splitKey(key);
        try {
            await unlink(fileOf(owner, name));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
            throw new SecretsStoreError(key, `the secret could not be removed (${causeOf(error)})`);
        }
    }

    async function keysNow(): Promise<string[]> {
        const keys: string[] = [];
        let owners: string[];
        try {
            owners = await readdir(secretsDir);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return keys;
            throw new SecretsStoreError("*", `the keys could not be listed (${causeOf(error)})`);
        }
        for (const owner of owners) {
            const entries = await readdir(join(secretsDir, owner), { withFileTypes: true }).catch(() => []);
            for (const entry of entries) {
                if (!entry.isFile() || !entry.name.endsWith(SECRET_FILE_SUFFIX)) continue;
                const key = `${owner}/${entry.name.slice(0, -SECRET_FILE_SUFFIX.length)}`;
                if (KEY_PATTERN.test(key)) keys.push(key);
            }
        }
        return keys;
    }

    return {
        read,
        write: (key, secret) => enqueue(() => writeNow(key, secret)),
        remove: (key) => enqueue(() => removeNow(key)),
        keys: keysNow,
        removeAllExcept: (keep) =>
            enqueue(async () => {
                const kept = new Set(keep);
                for (const key of await keysNow()) {
                    if (!kept.has(key)) await removeNow(key);
                }
            }),
    };
}
