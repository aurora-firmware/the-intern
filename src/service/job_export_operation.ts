/**
 * `jobs.export` (S-004 REQ-016): writes a consistent, owner-only copy of the instance's whole database to a new file
 * while the daemon keeps working. The configuration file is not in it.
 */
import { lstat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import type { ServiceContext } from "../daemon/daemon.ts";
import { backupDatabase } from "../host/database_copy.ts";
import { asRecord, requireString } from "./job_record_operations.ts";
import { defineOperation, ServiceError } from "./operations.ts";

type ExportInput = { path: string };
type ExportResult = { path: string; size: number };

function parseExport(raw: unknown): ExportInput {
    const path = requireString(asRecord(raw), "path");
    if (!isAbsolute(path)) throw new Error("path must be an absolute path");
    return { path };
}

async function exists(path: string): Promise<boolean> {
    try {
        await lstat(path);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

export const jobExportOperation = defineOperation<ServiceContext, ExportInput, ExportResult>({
    name: "jobs.export",
    kind: "control",
    parse: parseExport,
    async run(ctx, input) {
        if (await exists(input.path)) {
            throw new ServiceError(
                "invalid_input",
                `path ${input.path} already exists; give a file that doesn't exist`,
            );
        }
        if (!(await exists(dirname(input.path)))) {
            throw new ServiceError("invalid_input", `path ${input.path} is in a folder that doesn't exist`);
        }
        const { size } = await backupDatabase(ctx.host, input.path);
        return { path: input.path, size };
    },
});
