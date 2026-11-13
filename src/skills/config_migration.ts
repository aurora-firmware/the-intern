/**
 * The conversion of an older configuration file at startup step 3 (S-008 REQ-011): a role's `instructions` text becomes
 * its instruction file, and the file is rewritten once without the older keys.
 */

import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { type ConfigSection, fingerprintOf, type LoadedConfig, loadConfig } from "../config/config_file.ts";
import { ConfigChangeRefused, renderToml, replaceFile } from "../config/config_writer.ts";
import type { InstanceDirs } from "../daemon/state_layout.ts";
import type { RolesConfig } from "../roles/roles_section.ts";
import { rolesSection } from "../roles/roles_section.ts";
import type { FileStore } from "./file_store.ts";
import { roleInstructionPath } from "./internal_folder.ts";

export type MigrateOlderKeysOptions = {
    dirs: InstanceDirs;
    config: LoadedConfig;
    sections: readonly ConfigSection<unknown>[];
    store: FileStore;
};

// A section the migration doesn't own is written back as the file holds it, so rewriting loses nothing.
function passThrough(name: string): ConfigSection<unknown> {
    return {
        name,
        defaults: () => ({}),
        parse: (table) => table,
        serialize: (value) => value as Record<string, unknown>,
    };
}

async function readCurrentText(file: string, expectedFingerprint: string): Promise<string> {
    const bytes = await readFile(file);
    if (fingerprintOf(bytes) !== expectedFingerprint) {
        throw new ConfigChangeRefused("conflict", file, "the file changed since startup step 1 read it");
    }
    return bytes.toString("utf8");
}

/**
 * Writes each role's older `instructions` to its instruction file, then rewrites the configuration file without the
 * older keys. Returns the configuration read back from the new text, or `undefined` when no older key is present.
 */
export async function migrateOlderKeys(options: MigrateOlderKeysOptions): Promise<LoadedConfig | undefined> {
    const { dirs, config, sections, store } = options;
    const roles = config.values.get(rolesSection.name) as RolesConfig | undefined;
    const older = Object.entries(roles?.older ?? {});
    if (roles === undefined || older.length === 0) return undefined;

    for (const [role, keys] of older) {
        if (keys.instructions !== undefined) {
            await store.write(roleInstructionPath(dirs.dataDir, role), keys.instructions);
        }
    }

    const document = parseToml(await readCurrentText(dirs.configFile, config.fingerprint));
    const owned = new Set(sections.map((section) => section.name));
    const unowned = Object.keys(document).filter((key) => !owned.has(key));
    const rendered = [...sections, ...unowned.map(passThrough)];
    const values = new Map<string, unknown>(config.values);
    values.set(rolesSection.name, { ...roles, older: {} });
    for (const key of unowned) values.set(key, document[key]);
    await replaceFile(dirs.configFile, renderToml(rendered, values));

    const loaded = await loadConfig(dirs.configFile, rendered);
    const converted = new Map(config.values);
    for (const section of sections) converted.set(section.name, loaded.values.get(section.name));
    return { values: converted, fingerprint: loaded.fingerprint };
}
