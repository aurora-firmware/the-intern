import { createHash } from "node:crypto";
import { open, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stringify as stringifyToml } from "smol-toml";
import { ABSENT_FINGERPRINT, type ConfigSection, ConfigValueError, type LoadedConfig } from "./config_file.ts";

const OWNER_ONLY_MODE = 0o600;

export type ConfigChangeKind = "invalid" | "conflict" | "write_failed";

export class ConfigChangeRefused extends Error {
    readonly kind: ConfigChangeKind;
    readonly file: string;
    readonly key?: string;
    readonly reason: string;

    constructor(kind: ConfigChangeKind, file: string, reason: string, key?: string) {
        super(key === undefined ? `${file}: ${reason}` : `${file}: ${key}: ${reason}`);
        this.name = "ConfigChangeRefused";
        this.kind = kind;
        this.file = file;
        this.key = key;
        this.reason = reason;
    }
}

export type ConfigStore = {
    current<T>(section: ConfigSection<T>): T;
    change<T>(section: ConfigSection<T>, next: T): Promise<void>;
    onChange(listener: (change: { section: string }) => void): () => void;
};

function fingerprintOf(bytes: Buffer | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

async function readFingerprint(file: string): Promise<string> {
    try {
        return fingerprintOf(await readFile(file));
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return ABSENT_FINGERPRINT;
        throw new ConfigChangeRefused("write_failed", file, `can't read the file (${code ?? String(error)})`);
    }
}

function renderToml(sections: readonly ConfigSection<unknown>[], values: ReadonlyMap<string, unknown>): string {
    const document: Record<string, unknown> = {};
    for (const section of sections) {
        const table = section.serialize(values.get(section.name));
        const defaults = section.serialize(section.defaults());
        if (JSON.stringify(table) !== JSON.stringify(defaults)) document[section.name] = table;
    }
    return stringifyToml(document);
}

// The temporary file sits in the same directory so the rename stays on one file system and is atomic.
async function replaceFile(file: string, text: string): Promise<void> {
    const temporary = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
    try {
        const handle = await open(temporary, "w", OWNER_ONLY_MODE);
        try {
            await handle.writeFile(text);
            await handle.sync();
        } finally {
            await handle.close();
        }
        await rename(temporary, file);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

function validate<T>(file: string, section: ConfigSection<T>, next: T): void {
    try {
        section.parse(section.serialize(next));
    } catch (error) {
        if (error instanceof ConfigValueError) {
            throw new ConfigChangeRefused("invalid", file, error.reason, `${section.name}.${error.key}`);
        }
        throw error;
    }
}

export function createConfigStore(
    file: string,
    sections: readonly ConfigSection<unknown>[],
    loaded: LoadedConfig,
): ConfigStore {
    const values = new Map(loaded.values);
    const listeners = new Set<(change: { section: string }) => void>();
    let fingerprint = loaded.fingerprint;
    let queue: Promise<void> = Promise.resolve();

    // The change is already persisted, so a failing listener is reported as a warning and never rejects the change.
    function notifyListeners(sectionName: string): void {
        for (const listener of listeners) {
            try {
                listener({ section: sectionName });
            } catch (error) {
                process.emitWarning(
                    `a configuration change listener for ${sectionName} threw: ${(error as Error).message}`,
                );
            }
        }
    }

    async function applyChange<T>(section: ConfigSection<T>, next: T): Promise<void> {
        validate(file, section, next);
        if ((await readFingerprint(file)) !== fingerprint) {
            throw new ConfigChangeRefused("conflict", file, "the file changed since it was last read or written");
        }
        const text = renderToml(sections, new Map(values).set(section.name, next));
        try {
            await replaceFile(file, text);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            throw new ConfigChangeRefused("write_failed", file, `can't write the file (${code ?? String(error)})`);
        }
        values.set(section.name, next);
        fingerprint = fingerprintOf(text);
        notifyListeners(section.name);
    }

    return {
        current: <T>(section: ConfigSection<T>) => values.get(section.name) as T,
        change(section, next) {
            const result = queue.then(() => applyChange(section, next));
            queue = result.catch(() => undefined);
            return result;
        },
        onChange(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
}
