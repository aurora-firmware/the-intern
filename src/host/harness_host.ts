/**
 * The harness host (S-002 component 5): owns the open pi-durable harness. Only this folder and the-intern's own
 * pi-durable extensions import pi-durable (ADR-001 decision 2), so the rest of the product depends on `HarnessHost`
 * and the type re-exports below.
 */
import { chmod, open } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Models } from "@earendil-works/pi-ai";
import {
    type Conversation,
    type ConversationId,
    type Cursor,
    createRegistry,
    type EntryRecord,
    type Extension,
    Harness,
    type HarnessSettings,
    type ReportInfo,
    type SessionEnd,
    type Storage,
    StorageRequestError,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Logger } from "../daemon/logger.ts";
import type { HarnessSettingsMapping } from "../models/settings_mapping.ts";

export type { Extension, Models, Storage };

const OWNER_ONLY_FILE_MODE = 0o600;
const SQLITE_SIBLING_SUFFIXES = ["-wal", "-shm"];
const CONVERSATION_PAGE_SIZE = 500;
const context = BACKGROUND_CONTEXT;

export type AgentChoice = { model: string; thinkingLevel?: string; cwd?: string; instructions?: string };
export type HostEntry = { id: string; kind: string; data: unknown };
export type ConversationInfo = { id: string; busy: boolean };

/** A page cursor that this host never returned: the caller's input is invalid (S-002 R-13). */
export class HostInvalidCursorError extends Error {
    constructor(cursor: string, reason: string) {
        super(`Page cursor "${cursor}" is not one this host returned: ${reason}`);
        this.name = "HostInvalidCursorError";
    }
}

export type HarnessHost = {
    /** Starts the work the last run left unfinished. Nothing runs before this is called. */
    resume(): void;
    close(): Promise<void>;
    /** Settles when the harness has closed, or failed on a storage error. */
    closed: Promise<SessionEnd>;
    createConversation(input: { agent: AgentChoice }): Promise<string>;
    listConversations(): Promise<ConversationInfo[]>;
    conversationInfo(id: string): Promise<ConversationInfo | undefined>;
    /** Entries oldest first, including those before a reset or compaction. `next` is the `after` of the next page. */
    readEntries(id: string, page: { after?: string; limit: number }): Promise<{ entries: HostEntry[]; next?: string }>;
    /** The entries the model sees now. */
    readContext(id: string): Promise<HostEntry[]>;
};

export type HarnessHostOptions = {
    databaseFile: string;
    models: Models;
    harnessSettings: HarnessSettingsMapping;
    extensions: readonly Extension[];
    defaultCwd: string;
    logger: Logger;
    /** Test-only hook that replaces the SQLite storage, to make the storage fail. */
    openStorage?: (file: string) => Promise<Storage>;
};

const harnesses = new WeakMap<HarnessHost, Harness>();

/** The pi-durable harness behind a host. For other modules under `src/host/` and the-intern's extensions only. */
export function internalHarness(host: HarnessHost): Harness {
    const harness = harnesses.get(host);
    if (!harness) throw new Error("internalHarness was given an object that openHarnessHost did not return");
    return harness;
}

// SQLite gives the -wal and -shm files the mode of the database file, so the file is created owner-only first.
async function createDatabaseFileOwnerOnly(databaseFile: string): Promise<void> {
    const handle = await open(databaseFile, "a", OWNER_ONLY_FILE_MODE);
    await handle.close();
    await chmod(databaseFile, OWNER_ONLY_FILE_MODE);
}

async function restrictSiblingFiles(databaseFile: string): Promise<void> {
    for (const suffix of SQLITE_SIBLING_SUFFIXES) {
        try {
            await chmod(`${databaseFile}${suffix}`, OWNER_ONLY_FILE_MODE);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
}

/**
 * The settings handed to pi-durable. `restartLimit` is set after the mapping, so no pi agent setting can lower it
 * (ADR-001 decision 4). pi-durable's own resolver is not a public export, so this is the setting as the host sets it.
 */
export function resolveHarnessSettings(
    mapping: HarnessSettingsMapping,
    extensions: readonly Extension[],
): HarnessSettings {
    return { ...mapping, extensions, restartLimit: Number.POSITIVE_INFINITY };
}

function logReport(logger: Logger, error: unknown, info: ReportInfo): void {
    const fields: Record<string, string> = { type: info.type, error: String(error) };
    if ("reason" in info) fields.reason = info.reason;
    if ("extension" in info && info.extension !== undefined) fields.extension = info.extension;
    logger.error("pi-durable report", fields);
}

function toConversationId(id: string): ConversationId | undefined {
    return /^\d+$/.test(id) ? (Number(id) as ConversationId) : undefined;
}

function toModelRef(model: string): { provider: string; modelId: string } {
    const separator = model.indexOf("/");
    if (separator <= 0 || separator === model.length - 1) {
        throw new Error(`Model "${model}" is not of the form provider/id.`);
    }
    return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}

// An entry that contributes messages to the model is shown by those messages; any other by its own data.
function toHostEntry(entry: EntryRecord): HostEntry {
    return { id: String(entry.id), kind: entry.kind, data: entry.model ?? entry.data };
}

async function listBusyConversationIds(harness: Harness): Promise<Set<ConversationId>> {
    const { tasks } = await harness.inspect(context);
    return new Set(tasks.map((task) => task.record.conversationId));
}

async function requireConversation(harness: Harness, id: string): Promise<Conversation> {
    const conversationId = toConversationId(id);
    const conversation = conversationId === undefined ? undefined : await harness.conversation(conversationId, context);
    if (!conversation) throw new Error(`Conversation "${id}" does not exist.`);
    return conversation;
}

function decodeCursor(text: string): Cursor {
    try {
        return JSON.parse(text) as Cursor;
    } catch (error) {
        throw new HostInvalidCursorError(text, (error as Error).message);
    }
}

function createHost(harness: Harness): HarnessHost {
    async function listConversations(): Promise<ConversationInfo[]> {
        const busyIds = await listBusyConversationIds(harness);
        const infos: ConversationInfo[] = [];
        let cursor: Cursor | undefined;
        do {
            const page = await harness.commit(
                (tx) => tx.scanConversations({ order: "ascending" }, CONVERSATION_PAGE_SIZE, cursor),
                context,
            );
            for (const record of page.items) infos.push({ id: String(record.id), busy: busyIds.has(record.id) });
            cursor = page.next;
        } while (cursor !== undefined);
        return infos;
    }

    return {
        resume: () => harness.resume(),
        close: () => harness.close(context),
        closed: harness.closed,
        async createConversation({ agent }) {
            const conversation = await harness.createConversation(
                {
                    ownership: { kind: "ownerless" },
                    agent: {
                        model: toModelRef(agent.model),
                        ...(agent.thinkingLevel !== undefined && { thinkingLevel: agent.thinkingLevel as never }),
                        ...(agent.cwd !== undefined && { cwd: agent.cwd }),
                        ...(agent.instructions !== undefined && { instructions: agent.instructions }),
                    },
                },
                context,
            );
            return String(conversation.id);
        },
        listConversations,
        async conversationInfo(id) {
            const conversationId = toConversationId(id);
            if (conversationId === undefined || !(await harness.conversation(conversationId, context)))
                return undefined;
            return { id, busy: (await listBusyConversationIds(harness)).has(conversationId) };
        },
        async readEntries(id, page) {
            const conversation = await requireConversation(harness, id);
            const cursor = page.after === undefined ? undefined : decodeCursor(page.after);
            let result: Awaited<ReturnType<Conversation["entries"]>>;
            try {
                result = await conversation.entries({ order: "ascending" }, page.limit, cursor, context);
            } catch (error) {
                // An invalid read fails only that call (pi-durable, Errors rule 2); a bad cursor is the caller's input.
                if (page.after !== undefined && error instanceof StorageRequestError) {
                    throw new HostInvalidCursorError(page.after, error.message);
                }
                throw error;
            }
            return {
                entries: result.items.map(toHostEntry),
                ...(result.next !== undefined && { next: JSON.stringify(result.next) }),
            };
        },
        async readContext(id) {
            const conversation = await requireConversation(harness, id);
            return (await conversation.context(context)).entries.map(toHostEntry);
        },
    };
}

/** Opens the database, installs the extensions and returns the host. Nothing is resumed until `resume()`. */
export async function openHarnessHost(options: HarnessHostOptions): Promise<HarnessHost> {
    const { databaseFile, logger } = options;
    await createDatabaseFileOwnerOnly(databaseFile);
    const storage = await (options.openStorage ?? openNodeSqliteStorage)(databaseFile);
    const registry = createRegistry();
    for (const extension of options.extensions) registry.install(extension);

    const harness = await Harness.open(
        storage,
        {
            models: options.models,
            registry,
            // Applied after the mapping, so no pi agent setting can lower it (ADR-001 decision 4).
            settings: resolveHarnessSettings(options.harnessSettings, options.extensions),
            onReport: (error, info) => logReport(logger, error, info),
            env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? options.defaultCwd }),
        },
        context,
    );
    await restrictSiblingFiles(databaseFile);

    const host = createHost(harness);
    harnesses.set(host, harness);
    return host;
}
