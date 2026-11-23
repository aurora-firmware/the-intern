/**
 * The service manager interface (ADR-012): the registration record `bob service install` writes, the hold file that
 * keeps the service stopped, and the contract the systemd and launchd modules implement. Only those two modules run
 * the supervisors' commands. This module imports only Node modules and the program layout.
 */
import { spawn } from "node:child_process";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import type { ProgramLayout } from "./program_layout.ts";

const SERVICE_RECORD_FORMAT = 1;
const OWNER_ONLY_FILE_MODE = 0o600;
const OWNER_ONLY_DIR_MODE = 0o700;

export type CommandResult = { code: number; stdout: string; stderr: string };

export type CommandRunner = (
    command: string,
    args: string[],
    options?: { stdin?: "inherit" | "ignore" },
) => Promise<CommandResult>;

export type ServiceRecord = {
    format: 1;
    platform: "linux-x64" | "darwin-arm64";
    label: string;
    configDir: string;
    stateDir: string;
    dataDir: string;
    runtimeDir: string;
    piAgentDir: string;
    path: string;
    lingerTurnedOn: boolean;
};

/** What a registration step shows the team member while it runs. */
export type ServiceIo = {
    writeLine: (text: string) => void;
};

export type ServiceState = { registered: boolean; startsAtBoot: boolean };

export type ServiceManager = {
    register(record: ServiceRecord, io: ServiceIo): Promise<void>;
    remove(record: ServiceRecord, io: ServiceIo): Promise<void>;
    stop(record: ServiceRecord): Promise<void>;
    start(record: ServiceRecord): Promise<void>;
    state(record: ServiceRecord): Promise<ServiceState>;
    logCommand(record: ServiceRecord): string;
};

/** The supervisor or the machine refuses an operation. The message is the reason. */
export class ServiceRefusedError extends Error {
    reason: string;

    constructor(reason: string) {
        super(reason);
        this.name = "ServiceRefusedError";
        this.reason = reason;
    }
}

/** The registration record is unusable. The message names the file and says why. */
export class ServiceRecordError extends Error {
    path: string;

    constructor(path: string, reason: string) {
        super(`Service record ${path}: ${reason}`);
        this.name = "ServiceRecordError";
        this.path = path;
    }
}

/** Runs a real command. A command that can't start gives code 127 and the reason on stderr. */
export const nodeCommandRunner: CommandRunner = (command, args, options) =>
    new Promise((resolve) => {
        const child = spawn(command, args, { stdio: [options?.stdin ?? "ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
            stderr += chunk;
        });
        child.on("error", (error) => resolve({ code: 127, stdout, stderr: `${command}: ${error.message}` }));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    });

/** Writes the record beside `service.json` and renames it over, so a reader sees the old or the new one. */
export async function writeServiceRecord(layout: ProgramLayout, record: ServiceRecord): Promise<void> {
    await mkdir(dirname(layout.serviceRecord), { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    const temporary = `${layout.serviceRecord}.${process.pid}.tmp`;
    const file = await open(temporary, "w", OWNER_ONLY_FILE_MODE);
    try {
        await file.writeFile(`${JSON.stringify(record, null, 2)}\n`);
        await file.chmod(OWNER_ONLY_FILE_MODE);
        await file.sync();
    } finally {
        await file.close();
    }
    try {
        await rename(temporary, layout.serviceRecord);
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

/** The record, or null when there is none. Refuses a newer `format` or a file that is not a record. */
export async function readServiceRecord(layout: ProgramLayout): Promise<ServiceRecord | null> {
    let text: string;
    try {
        text = await readFile(layout.serviceRecord, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new ServiceRecordError(layout.serviceRecord, "the file is not valid JSON");
    }
    const format = (parsed as { format?: unknown } | null)?.format;
    if (typeof format !== "number") throw new ServiceRecordError(layout.serviceRecord, "the file has no format number");
    if (format > SERVICE_RECORD_FORMAT) {
        throw new ServiceRecordError(
            layout.serviceRecord,
            `its format is ${format}, newer than ${SERVICE_RECORD_FORMAT}; use the newer version of bob that wrote it`,
        );
    }
    return parsed as ServiceRecord;
}

export async function removeServiceRecord(layout: ProgramLayout): Promise<void> {
    await rm(layout.serviceRecord, { force: true });
}

/** Creates `service.hold`, which keeps the service stopped. Holding twice changes nothing. */
export async function hold(layout: ProgramLayout): Promise<void> {
    await mkdir(dirname(layout.holdFile), { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    const file = await open(layout.holdFile, "a", OWNER_ONLY_FILE_MODE);
    await file.close();
}

/** Removes `service.hold`, so the service may start. */
export async function unhold(layout: ProgramLayout): Promise<void> {
    await rm(layout.holdFile, { force: true });
}
