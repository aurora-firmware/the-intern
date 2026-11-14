/**
 * The skills daemon component (S-008): the `skills` configuration section, and the startup preparation of the internal
 * folder (instructions and skills) at step 3, before the configuration store is built.
 */

import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentsRuntime } from "../agents/agents_component.ts";
import type { ConfigSection } from "../config/config_file.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import { upgradeEnabledSkills } from "../host/skill_set.ts";
import { rolesSection, workspacesSection } from "../roles/roles_section.ts";
import type { Operation } from "../service/operations.ts";
import { skillOperations } from "../service/skill_operations.ts";
import { migrateOlderKeys } from "./config_migration.ts";
import { createFileStore, type FileChangeHub, type FileStore } from "./file_store.ts";
import { DEFAULT_SHIPPED_ROOT, prepareInternalFolder } from "./internal_folder.ts";
import { readCatalog } from "./skill_discovery.ts";
import { createSkillToolExtension } from "./skill_tool_extension.ts";
import { skillsSection } from "./skills_section.ts";

const OWNER_ONLY_MODE = 0o700;
const COMMAND_LINE_ENTRY = join(import.meta.dirname, "..", "cli", "bob.ts");

function shellQuote(text: string): string {
    return `'${text.replaceAll("'", `'\\''`)}'`;
}

/**
 * Writes `<runtime dir>/bin/bob` (S-008 REQ-014): a script that runs the daemon's own Node on this package's command
 * line, so an agent's `bob` is the daemon's version. The folder and the file are owner-only.
 */
async function writeBobLauncher(runtimeDir: string): Promise<void> {
    const folder = join(runtimeDir, "bin");
    await mkdir(folder, { recursive: true, mode: OWNER_ONLY_MODE });
    await chmod(folder, OWNER_ONLY_MODE);
    const file = join(folder, "bob");
    await writeFile(file, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(COMMAND_LINE_ENTRY)} "$@"\n`, {
        mode: OWNER_ONLY_MODE,
    });
    await chmod(file, OWNER_ONLY_MODE);
}

export type SkillsComponentOptions = {
    logger: Logger;
    /** Test-only: the folder the shipped text is read from. */
    shippedRoot?: string;
};

export type SkillsComponent = {
    component: DaemonComponent;
    sections: readonly ConfigSection<unknown>[];
    // biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
    operations: Operation<ServiceContext, any, any>[];
    fileStore: FileStore;
    shippedRoot: string;
    /** The data directory; throws before startup step 3 has run. */
    dataDir(): string;
    /** The runtime directory; throws before startup step 3 has run. */
    runtimeDir(): string;
    /** Called by the agents component, which holds this one: the operations reach the roles and workspaces lazily. */
    connectAgents(runtime: () => AgentsRuntime): void;
    /** The agents runtime; throws before the agents component has connected, and before startup step 5. */
    agentsRuntime(): AgentsRuntime;
};

export function createSkillsComponent(options: SkillsComponentOptions): SkillsComponent {
    const shippedRoot = options.shippedRoot ?? DEFAULT_SHIPPED_ROOT;
    let hub: FileChangeHub | undefined;
    const fileStore = createFileStore({ changes: () => hub });
    let recordedDataDir: string | undefined;
    let recordedRuntimeDir: string | undefined;
    let connectedRuntime: (() => AgentsRuntime) | undefined;
    let searchPaths: () => readonly string[] = () => [];

    const dataDir = (): string => {
        if (recordedDataDir === undefined) {
            throw new Error("the data directory is not known before startup step 3 has run");
        }
        return recordedDataDir;
    };

    const runtimeDir = (): string => {
        if (recordedRuntimeDir === undefined) {
            throw new Error("the runtime directory is not known before startup step 3 has run");
        }
        return recordedRuntimeDir;
    };

    const agentsRuntime = (): AgentsRuntime => {
        if (connectedRuntime === undefined) throw new Error("the skills component isn't connected to the agents");
        return connectedRuntime();
    };

    const component: DaemonComponent = {
        name: "skills",
        extensions: [
            createSkillToolExtension({
                catalogFor: (workspace) =>
                    readCatalog({ dataDir: dataDir(), shippedRoot, searchPaths: searchPaths(), workspace }),
                defaultsOf: (role) => new Set(agentsRuntime().catalog.get(role)?.skills ?? []),
            }),
        ],
        async prepareFiles({ dirs, config }) {
            recordedDataDir = dirs.dataDir;
            recordedRuntimeDir = dirs.runtimeDir;
            await writeBobLauncher(dirs.runtimeDir);
            await prepareInternalFolder({ dataDir: dirs.dataDir, shippedRoot, store: fileStore });
            const owned = [skillsSection, rolesSection, workspacesSection] as ConfigSection<unknown>[];
            return migrateOlderKeys({
                dirs,
                config,
                sections: owned.filter((section) => config.values.has(section.name)),
                store: fileStore,
            });
        },
        // Writes before this step announce nothing: the start rule of step 3 has no feed to tell.
        async checkModels(ctx) {
            hub = ctx.fileChanges;
            searchPaths = () => ctx.config.current(skillsSection).paths;
        },
        // Step 7, after admission is restored and before the jobs repair rules and `host.resume()`.
        async repair(ctx) {
            await upgradeEnabledSkills(ctx.host, (role) => [...(agentsRuntime().catalog.get(role)?.skills ?? [])]);
        },
    };

    const skills: SkillsComponent = {
        component,
        sections: [skillsSection as ConfigSection<unknown>],
        operations: [],
        fileStore,
        shippedRoot,
        dataDir,
        runtimeDir,
        connectAgents(runtime) {
            connectedRuntime = runtime;
        },
        agentsRuntime,
    };
    skills.operations.push(...skillOperations(skills));
    return skills;
}
