import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseToml, TomlError } from "smol-toml";

export const ABSENT_FINGERPRINT = "absent";

export type ConfigSection<T> = {
    name: string;
    defaults(): T;
    parse(table: unknown): T;
    /** Runs after `parse`, on the parsed or default value, for what only an async look can decide. */
    check?(value: T): Promise<void>;
    serialize(value: T): Record<string, unknown> | Record<string, unknown>[];
};

export type LoadedConfig = {
    values: ReadonlyMap<string, unknown>;
    fingerprint: string;
};

export class ConfigValueError extends Error {
    readonly key: string;
    readonly reason: string;

    constructor(key: string, reason: string) {
        super(`${key}: ${reason}`);
        this.name = "ConfigValueError";
        this.key = key;
        this.reason = reason;
    }
}

export class ConfigError extends Error {
    readonly file: string;
    readonly key?: string;
    readonly reason: string;

    constructor(file: string, reason: string, key?: string) {
        super(key === undefined ? `${file}: ${reason}` : `${file}: ${key}: ${reason}`);
        this.name = "ConfigError";
        this.file = file;
        this.key = key;
        this.reason = reason;
    }
}

export function defineConfigSection<T>(section: ConfigSection<T>): ConfigSection<T> {
    return section;
}

type ReadResult = { text: string; fingerprint: string } | undefined;

/** The SHA-256 of a configuration file's bytes, which detects a change made by someone else. */
export function fingerprintOf(bytes: Buffer | string): string {
    return createHash("sha256").update(bytes).digest("hex");
}

async function readConfigFile(file: string): Promise<ReadResult> {
    let bytes: Buffer;
    try {
        bytes = await readFile(file);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return undefined;
        throw new ConfigError(file, `can't read the file (${code ?? String(error)})`);
    }
    return { text: bytes.toString("utf8"), fingerprint: fingerprintOf(bytes) };
}

function parseTomlTable(file: string, text: string): Record<string, unknown> {
    try {
        return parseToml(text);
    } catch (error) {
        if (error instanceof TomlError) {
            throw new ConfigError(file, `invalid TOML at line ${error.line}, column ${error.column}: ${error.message}`);
        }
        throw new ConfigError(file, `invalid TOML: ${(error as Error).message}`);
    }
}

async function guardSection<T>(
    file: string,
    section: ConfigSection<unknown>,
    action: () => T | Promise<T>,
): Promise<T> {
    try {
        return await action();
    } catch (error) {
        if (error instanceof ConfigValueError) {
            throw new ConfigError(file, error.reason, `${section.name}.${error.key}`);
        }
        throw error;
    }
}

async function resolveSection(file: string, section: ConfigSection<unknown>, table: unknown): Promise<unknown> {
    const value = await guardSection(file, section, () =>
        table === undefined ? section.defaults() : section.parse(table),
    );
    await guardSection(file, section, () => section.check?.(value));
    return value;
}

export async function loadConfig(file: string, sections: readonly ConfigSection<unknown>[]): Promise<LoadedConfig> {
    const read = await readConfigFile(file);
    if (read === undefined) {
        return { values: await resolveSections(file, sections, {}), fingerprint: ABSENT_FINGERPRINT };
    }
    const document = parseTomlTable(file, read.text);
    const owned = new Set(sections.map((section) => section.name));
    for (const key of Object.keys(document)) {
        if (!owned.has(key)) throw new ConfigError(file, "no configuration section owns this key", key);
    }
    return { values: await resolveSections(file, sections, document), fingerprint: read.fingerprint };
}

async function resolveSections(
    file: string,
    sections: readonly ConfigSection<unknown>[],
    document: Record<string, unknown>,
): Promise<Map<string, unknown>> {
    const values = new Map<string, unknown>();
    for (const section of sections) {
        values.set(section.name, await resolveSection(file, section, document[section.name]));
    }
    return values;
}
