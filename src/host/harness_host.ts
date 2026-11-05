/**
 * The harness host (S-002 Harness host): owns the open pi-durable harness. Only this folder and the-intern's own
 * pi-durable extensions import pi-durable (ADR-001 decision 2), so the rest of the product depends on `HarnessHost`
 * and the type re-exports below.
 */
import { chmod, open } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
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
import { type SqliteDatabase, SqliteStorage } from "@earendil-works/pi-durable/storage/sqlite";
import { NodeSqliteDatabase } from "@earendil-works/pi-durable/storage/sqlite/node";
import type { Logger } from "../daemon/logger.ts";
import type { HarnessSettingsMapping } from "../models/settings_mapping.ts";
import { parseConversationId } from "./conversation_id.ts";

export type { Extension, Models, SqliteDatabase, Storage };

const OWNER_ONLY_FILE_MODE = 0o600;
const SQLITE_SIBLING_SUFFIXES = ["-wal", "-shm"];
const CONVERSATION_PAGE_SIZE = 500;
const BUSY_TIMEOUT_MS = 5_000;
const WAL_AUTOCHECKPOINT_PAGES = 1_000;
const context = BACKGROUND_CONTEXT;

export type AgentChoice = { model: string; thinkingLevel?: string; cwd?: string; instructions?: string };
export type HostEntry = { id: string; kind: string; data: unknown };
export type ConversationInfo = { id: string; busy: boolean };

/** A page cursor that this host never returned: the caller's input is invalid (S-002 REQ-013). */
export class HostInvalidCursorError extends Error {
    constructor(cursor: string, reason: string) {
        super(`Page cursor "${cursor}" is not one this host returned: ${reason}`);
        this.name = "HostInvalidCursorError";
    }
}

export type HostSqlValue = null | number | bigint | string | Uint8Array;

/**
 * A structural copy of chord's `SqliteExecutor`, so the job store imports no pi package (ADR-001 decisions 1 and 2).
 * Values go in as bindings, never interpolated into the SQL text.
 */
export type HostSqlExecutor = {
    exec(sql: string): Promise<void>;
    run(sql: string, ...params: HostSqlValue[]): Promise<void>;
    get<T extends object>(sql: string, ...params: HostSqlValue[]): Promise<T | undefined>;
    all<T extends object>(sql: string, ...params: HostSqlValue[]): Promise<T[]>;
};

/**
 * The instance's one SQLite connection, shared with pi-durable. Work in a transaction goes through the handle the
 * callback receives; calling the database itself from inside the callback never settles. A job store write must never
 * run inside a pi-durable commit, nor a commit inside a job store transaction (ADR-001 decision 1).
 */
export type HostDatabase = HostSqlExecutor & {
    transaction<T>(callback: (tx: HostSqlExecutor) => Promise<T>): Promise<T>;
};

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
    /** The ID of the conversation's newest entry as `readEntries` shows it, or `null` when it has none. */
    readNewestEntryId(id: string): Promise<string | null>;
    /** The entries the model sees now. */
    readContext(id: string): Promise<HostEntry[]>;
    /** The largest `timestamp` of the model messages of the stored entries, or `null` when there is none. */
    readLastMessageTime(id: string): Promise<number | null>;
};

export type HarnessHostOptions = {
    databaseFile: string;
    models: Models;
    harnessSettings: HarnessSettingsMapping;
    extensions: readonly Extension[];
    /** Installed but not in the default selection; a conversation selects them with `configure`. */
    optInExtensions?: readonly Extension[];
    defaultCwd: string;
    logger: Logger;
    /** Runs on the open database before pi-durable creates its tables. A rejection rejects the open. */
    beforeStorageOpen?: (database: HostDatabase) => Promise<void>;
    /** Test-only hook that replaces the SQLite storage, to make the storage fail. */
    openStorage?: (database: SqliteDatabase) => Promise<Storage>;
};

const harnesses = new WeakMap<HarnessHost, Harness>();
const hostDatabases = new WeakMap<HarnessHost, HostDatabase>();
const nodeDatabases = new WeakMap<HarnessHost, DatabaseSync>();

/** The pi-durable harness behind a host. For other modules under `src/host/` and the-intern's extensions only. */
export function internalHarness(host: HarnessHost): Harness {
    const harness = harnesses.get(host);
    if (!harness) throw new Error("internalHarness was given an object that openHarnessHost did not return");
    return harness;
}

/** The instance's one database connection, for the job store. The harness closes it when the host closes. */
export function hostDatabase(host: HarnessHost): HostDatabase {
    const database = hostDatabases.get(host);
    if (!database) throw new Error("hostDatabase was given an object that openHarnessHost did not return");
    return database;
}

/** The `node:sqlite` handle behind `hostDatabase`. For other modules under `src/host/` only. */
export function internalDatabase(host: HarnessHost): DatabaseSync {
    const database = nodeDatabases.get(host);
    if (!database) throw new Error("internalDatabase was given an object that openHarnessHost did not return");
    return database;
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

async function applyPragmas(database: NodeSqliteDatabase): Promise<void> {
    await database.exec("PRAGMA journal_mode = WAL");
    await database.exec("PRAGMA synchronous = NORMAL");
    await database.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
}

async function closeQuietly(database: NodeSqliteDatabase): Promise<void> {
    try {
        await database.close();
    } catch {
        // The open already failed; that error is the one to report.
    }
}

type OpenedDatabase = { node: DatabaseSync; database: NodeSqliteDatabase };

async function openOwnerOnlyDatabase(databaseFile: string): Promise<OpenedDatabase> {
    await createDatabaseFileOwnerOnly(databaseFile);
    const node = new DatabaseSync(databaseFile, { timeout: BUSY_TIMEOUT_MS });
    return { node, database: new NodeSqliteDatabase(node) };
}

/**
 * Opens a database file the way the host does, without a harness: owner-only, with the same pragmas. With
 * `readOnly` it opens an existing file, creates nothing and sets no pragma. The caller closes it.
 */
export async function openHostDatabase(
    file: string,
    options: { readOnly?: boolean } = {},
): Promise<HostDatabase & { close(): Promise<void> }> {
    if (options.readOnly) {
        return new NodeSqliteDatabase(new DatabaseSync(file, { readOnly: true, timeout: BUSY_TIMEOUT_MS }));
    }
    const { database } = await openOwnerOnlyDatabase(file);
    try {
        await applyPragmas(database);
        await restrictSiblingFiles(file);
    } catch (error) {
        await closeQuietly(database);
        throw error;
    }
    return database;
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

function toModelRef(model: string): { provider: string; modelId: string } {
    const separator = model.indexOf("/");
    if (separator <= 0 || separator === model.length - 1) {
        throw new Error(`Model "${model}" is not of the form provider/id.`);
    }
    return { provider: model.slice(0, separator), modelId: model.slice(separator + 1) };
}

/** The pi-durable agent of a new conversation. Shared with `idempotency.ts`, which creates conversations too. */
export function toAgentSpec(agent: AgentChoice) {
    return {
        model: toModelRef(agent.model),
        ...(agent.thinkingLevel !== undefined && { thinkingLevel: agent.thinkingLevel as never }),
        ...(agent.cwd !== undefined && { cwd: agent.cwd }),
        ...(agent.instructions !== undefined && { instructions: agent.instructions }),
    };
}

const INTERN_KIND_PREFIX = "intern.";

/**
 * How a transcript read shows an entry. An `intern.` entry (a report or a steer) is placed as an input, so it carries
 * the input's user message too, but the transcript shows its own data: who sent it (ADR-004 decision 1). Any other
 * entry that contributes messages to the model is shown by those messages, and the rest by their own data.
 */
export function toHostEntry(entry: EntryRecord): HostEntry {
    if (entry.kind.startsWith(INTERN_KIND_PREFIX)) return { id: String(entry.id), kind: entry.kind, data: entry.data };
    return toContextEntry(entry);
}

// What the model sees: an entry that contributes messages is shown by those messages, any other by its own data.
function toContextEntry(entry: EntryRecord): HostEntry {
    return { id: String(entry.id), kind: entry.kind, data: entry.model ?? entry.data };
}

// Entries carry no wall-clock time of their own; the messages they contribute to the model do.
function newestModelMessageTime(entries: readonly EntryRecord[]): number | null {
    let newest: number | null = null;
    for (const entry of entries) {
        for (const message of entry.model ?? []) {
            if (typeof message?.timestamp === "number" && (newest === null || message.timestamp > newest)) {
                newest = message.timestamp;
            }
        }
    }
    return newest;
}

async function listBusyConversationIds(harness: Harness): Promise<Set<ConversationId>> {
    const { tasks } = await harness.inspect(context);
    return new Set(tasks.map((task) => task.record.conversationId));
}

async function requireConversation(harness: Harness, id: string): Promise<Conversation> {
    const conversationId = parseConversationId(id);
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
                    agent: toAgentSpec(agent),
                },
                context,
            );
            return String(conversation.id);
        },
        listConversations,
        async conversationInfo(id) {
            const conversationId = parseConversationId(id);
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
        async readNewestEntryId(id) {
            const conversation = await requireConversation(harness, id);
            const newest = await conversation.entries({ order: "descending" }, 1, undefined, context);
            const entry = newest.items[0];
            return entry === undefined ? null : String(entry.id);
        },
        async readContext(id) {
            const conversation = await requireConversation(harness, id);
            return (await conversation.context(context)).entries.map(toContextEntry);
        },
        async readLastMessageTime(id) {
            const conversation = await requireConversation(harness, id);
            let newest: number | null = null;
            let cursor: Cursor | undefined;
            do {
                const page = await conversation.entries(
                    { order: "ascending" },
                    CONVERSATION_PAGE_SIZE,
                    cursor,
                    context,
                );
                const pageNewest = newestModelMessageTime(page.items);
                if (pageNewest !== null && (newest === null || pageNewest > newest)) newest = pageNewest;
                cursor = page.next;
            } while (cursor !== undefined);
            return newest;
        },
    };
}

async function openStorageOnHostDatabase(options: HarnessHostOptions, opened: OpenedDatabase): Promise<Storage> {
    await options.beforeStorageOpen?.(opened.database);
    await applyPragmas(opened.database);
    return options.openStorage ? options.openStorage(opened.database) : SqliteStorage.open(opened.database);
}

// The harness owns closing; the job store gets the connection without a way to close it.
function narrowToHostDatabase(database: NodeSqliteDatabase): HostDatabase {
    return {
        exec: (sql) => database.exec(sql),
        run: (sql, ...params) => database.run(sql, ...params),
        get: (sql, ...params) => database.get(sql, ...params),
        all: (sql, ...params) => database.all(sql, ...params),
        transaction: (callback) => database.transaction(callback),
    };
}

/** Opens the database, installs the extensions and returns the host. Nothing is resumed until `resume()`. */
export async function openHarnessHost(options: HarnessHostOptions): Promise<HarnessHost> {
    const { databaseFile, logger } = options;
    const opened = await openOwnerOnlyDatabase(databaseFile);
    let storage: Storage;
    try {
        storage = await openStorageOnHostDatabase(options, opened);
    } catch (error) {
        await closeQuietly(opened.database);
        throw error;
    }
    const registry = createRegistry();
    for (const extension of [...options.extensions, ...(options.optInExtensions ?? [])]) registry.install(extension);

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
    hostDatabases.set(host, narrowToHostDatabase(opened.database));
    nodeDatabases.set(host, opened.node);
    return host;
}
