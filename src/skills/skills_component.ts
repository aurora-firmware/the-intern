/**
 * The skills daemon component (S-008): the `skills` configuration section, and the startup preparation of the internal
 * folder (instructions and skills) at step 3, before the configuration store is built.
 */

import type { ConfigSection } from "../config/config_file.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import type { Operation } from "../service/operations.ts";
import { createFileStore, type FileStore } from "./file_store.ts";
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
};

export function createSkillsComponent(options: SkillsComponentOptions): SkillsComponent {
    const shippedRoot = options.shippedRoot ?? DEFAULT_SHIPPED_ROOT;
    const fileStore = createFileStore();
    let recordedDataDir: string | undefined;

    const component: DaemonComponent = {
        name: "skills",
        async prepareFiles({ dirs }) {
            recordedDataDir = dirs.dataDir;
            await prepareInternalFolder({ dataDir: dirs.dataDir, shippedRoot, store: fileStore });
            return undefined;
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
    };
}
