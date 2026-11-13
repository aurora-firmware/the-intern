/**
 * The skills daemon component (S-008): the `skills` configuration section, and the startup preparation of the internal
 * folder (instructions and skills) at step 3, before the configuration store is built.
 */

import type { AgentsRuntime } from "../agents/agents_component.ts";
import type { ConfigSection } from "../config/config_file.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import { rolesSection, workspacesSection } from "../roles/roles_section.ts";
import type { Operation } from "../service/operations.ts";
import { migrateOlderKeys } from "./config_migration.ts";
import { createFileStore, type FileChangeHub, type FileStore } from "./file_store.ts";
import { DEFAULT_SHIPPED_ROOT, prepareInternalFolder } from "./internal_folder.ts";
import { skillsSection } from "./skills_section.ts";

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
    let connectedRuntime: (() => AgentsRuntime) | undefined;

    const component: DaemonComponent = {
        name: "skills",
        async prepareFiles({ dirs, config }) {
            recordedDataDir = dirs.dataDir;
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
        },
    };

    return {
        component,
        sections: [skillsSection as ConfigSection<unknown>],
        operations: [],
        fileStore,
        shippedRoot,
        dataDir() {
            if (recordedDataDir === undefined) {
                throw new Error("the data directory is not known before startup step 3 has run");
            }
            return recordedDataDir;
        },
        connectAgents(runtime) {
            connectedRuntime = runtime;
        },
        agentsRuntime() {
            if (connectedRuntime === undefined) throw new Error("the skills component isn't connected to the agents");
            return connectedRuntime();
        },
    };
}
