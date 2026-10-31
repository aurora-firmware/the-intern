import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parse as parseToml, TomlError } from "smol-toml";

export const ABSENT_FINGERPRINT = "absent";

export type ConfigSection<T> = {
    name: string;
    defaults(): T;
    parse(table: unknown): T;
    serialize(value: T): Record<string, unknown>;
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

async function readConfigFile(file: string): Promise<ReadResult> {
    let bytes: Buffer;
    try {
        bytes = await readFile(file);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return undefined;
        throw new ConfigError(file, `can't read the file (${code ?? String(error)})`);
    }
    const fingerprint = createHash("sha256").update(bytes).digest("hex");
    return { text: bytes.toString("utf8"), fingerprint };
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

function parseSection(file: string, section: ConfigSection<unknown>, table: unknown): unknown {
    try {
        return section.parse(table);
    } catch (error) {
        if (error instanceof ConfigValueError) {
            throw new ConfigError(file, error.reason, `${section.name}.${error.key}`);
        }
        throw error;
    }
}

export async function loadConfig(file: string, sections: readonly ConfigSection<unknown>[]): Promise<LoadedConfig> {
    const read = await readConfigFile(file);
    if (read === undefined) {
        const defaults = new Map(sections.map((section) => [section.name, section.defaults()] as const));
        return { values: defaults, fingerprint: ABSENT_FINGERPRINT };
    }
    const document = parseTomlTable(file, read.text);
    const owned = new Set(sections.map((section) => section.name));
    for (const key of Object.keys(document)) {
        if (!owned.has(key)) throw new ConfigError(file, "no configuration section owns this key", key);
    }
    const values = new Map<string, unknown>();
    for (const section of sections) {
        const table = document[section.name];
        values.set(section.name, table === undefined ? section.defaults() : parseSection(file, section, table));
    }
    return { values, fingerprint: read.fingerprint };
}
