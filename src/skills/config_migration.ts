/**
 * The conversion of an older configuration file at startup step 3 (S-008 REQ-011): a role's `instructions` text becomes
 * its instruction file, and the file is rewritten once without the older keys.
 */

import { readFile } from "node:fs/promises";
import { parse as parseToml } from "smol-toml";
import { type ConfigSection, fingerprintOf, type LoadedConfig, loadConfig } from "../config/config_file.ts";
import { ConfigChangeRefused, renderToml, replaceFile } from "../config/config_writer.ts";
import type { InstanceDirs } from "../daemon/state_layout.ts";
import type { OlderRoleKeys, RolesConfig } from "../roles/roles_section.ts";
import { rolesSection } from "../roles/roles_section.ts";
import type { FileStore } from "./file_store.ts";
import { roleInstructionPath } from "./internal_folder.ts";
import { discoverSkills } from "./skill_discovery.ts";
import { checkSearchPath, SearchPathError, type SkillsConfig, skillsSection } from "./skills_section.ts";

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

type ConvertedPath = { name: string; folder: string };

class OlderSkillPathError extends Error {
    constructor(role: string, path: string, reason: string) {
        super(`Role ${role}: the skill path ${path} can't be converted: ${reason}`);
        this.name = "OlderSkillPathError";
    }
}

// A path converts only when it is itself one valid skill and may be a search path.
async function checkOlderPath(role: string, path: string): Promise<ConvertedPath> {
    const scan = await discoverSkills(path);
    const [skill] = scan.skills;
    if (skill === undefined || scan.skills.length > 1 || skill.folder !== path) {
        const reason = scan.missing
            ? "the folder doesn't exist"
            : "the folder isn't a folder holding exactly one skill";
        throw new OlderSkillPathError(role, path, reason);
    }
    try {
        await checkSearchPath(path);
    } catch (error) {
        if (error instanceof SearchPathError) throw new OlderSkillPathError(role, path, error.reason);
        throw error;
    }
    return { name: skill.name, folder: path };
}

async function checkOlderPaths(older: [string, OlderRoleKeys][]): Promise<Map<string, ConvertedPath[]>> {
    const converted = new Map<string, ConvertedPath[]>();
    const folderOfName = new Map<string, string>();
    for (const [role, keys] of older) {
        for (const path of keys.skillPaths ?? []) {
            const skill = await checkOlderPath(role, path);
            const known = folderOfName.get(skill.name);
            if (known !== undefined && known !== path) {
                throw new OlderSkillPathError(role, path, `the skill name "${skill.name}" is also given by ${known}`);
            }
            folderOfName.set(skill.name, path);
            converted.set(role, [...(converted.get(role) ?? []), skill]);
        }
    }
    return converted;
}

const withNames = (skills: string[], added: ConvertedPath[]): string[] => [
    ...skills,
    ...added.map((skill) => skill.name).filter((name) => !skills.includes(name)),
];

function convertRoles(roles: RolesConfig, converted: Map<string, ConvertedPath[]>): RolesConfig {
    const teamRoles = { ...roles.teamRoles };
    const shippedChanges = { ...roles.shippedChanges };
    for (const [role, skills] of converted) {
        const team = teamRoles[role];
        if (team !== undefined) teamRoles[role] = { ...team, skills: withNames(team.skills, skills) };
        const shipped = shippedChanges[role];
        if (shipped !== undefined)
            shippedChanges[role] = { ...shipped, skills: withNames(shipped.skills ?? [], skills) };
    }
    return { teamRoles, shippedChanges, older: {} };
}

function convertSkills(current: SkillsConfig | undefined, converted: Map<string, ConvertedPath[]>): SkillsConfig {
    const paths = [...(current?.paths ?? [])];
    for (const skills of converted.values()) {
        for (const { folder } of skills) if (!paths.includes(folder)) paths.push(folder);
    }
    return { paths };
}

/**
 * Checks each role's older skill paths, writes its older `instructions` to its instruction file, then rewrites the
 * configuration file once, with each path replaced by the skill's name and its folder added to `[skills] paths`.
 * Returns the configuration read back from the new text, or `undefined` when no older key is present.
 */
export async function migrateOlderKeys(options: MigrateOlderKeysOptions): Promise<LoadedConfig | undefined> {
    const { dirs, config, sections, store } = options;
    const roles = config.values.get(rolesSection.name) as RolesConfig | undefined;
    const older = Object.entries(roles?.older ?? {});
    if (roles === undefined || older.length === 0) return undefined;

    const convertedPaths = await checkOlderPaths(older);
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
    values.set(rolesSection.name, convertRoles(roles, convertedPaths));
    if (convertedPaths.size > 0)
        values.set(
            skillsSection.name,
            convertSkills(config.values.get(skillsSection.name) as SkillsConfig | undefined, convertedPaths),
        );
    for (const key of unowned) values.set(key, document[key]);
    await replaceFile(dirs.configFile, renderToml(rendered, values));

    const loaded = await loadConfig(dirs.configFile, rendered);
    const converted = new Map(config.values);
    for (const section of sections) converted.set(section.name, loaded.values.get(section.name));
    return { values: converted, fingerprint: loaded.fingerprint };
}
