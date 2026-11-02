/**
 * The online copy of the instance's database (S-004 REQ-016; ADR-001 decision 1): SQLite's backup on the daemon's own
 * connection, so the copy is consistent while work goes on.
 */
import { chmod, link, mkdtemp, rm, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { backup } from "node:sqlite";
import type { HarnessHost } from "./harness_host.ts";
import { internalDatabase } from "./harness_host.ts";

const OWNER_ONLY_FILE_MODE = 0o600;
const COPY_NAME = "copy.sqlite";
// One step copies every page, so no other statement can start between the first page and the last.
const ALL_PAGES_IN_ONE_STEP = 0x7fffffff;

/**
 * Copies the whole database to `path`, a file that doesn't exist yet in an existing folder, and returns its size. The
 * copy is never readable by the group or others, not even while it is written: it is written inside a new folder that
 * only the service account can enter (`mkdtemp` makes it `0700`) and linked to `path` once complete, which also fails
 * rather than replace a file that appeared meanwhile.
 */
export async function backupDatabase(host: HarnessHost, path: string): Promise<{ size: number }> {
    const privateFolder = await mkdtemp(join(dirname(path), `.${basename(path)}-`));
    try {
        const staged = join(privateFolder, COPY_NAME);
        await backup(internalDatabase(host), staged, { rate: ALL_PAGES_IN_ONE_STEP });
        await chmod(staged, OWNER_ONLY_FILE_MODE);
        await link(staged, path);
        return { size: (await stat(path)).size };
    } finally {
        await rm(privateFolder, { recursive: true, force: true });
    }
}
