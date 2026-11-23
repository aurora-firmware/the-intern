import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Logger } from "../../src/daemon/logger.ts";
import {
    type AnyOperation,
    type Caller,
    type Catalogue,
    createCatalogue,
    type DaemonPhase,
    defineOperation,
    ServiceError,
} from "../../src/service/operations.ts";

const TEAM_MEMBER: Caller = { actor: { kind: "team_member" } };

function makeLogger() {
    const errors: { message: string; fields?: Record<string, string | number | boolean> }[] = [];
    const logger: Logger = {
        error: (message, fields) => errors.push({ message, fields }),
        info: () => {},
        debug: () => {},
    };
    return { logger, errors };
}

function echoOperation(overrides: Partial<Parameters<typeof defineOperation>[0]> = {}) {
    return defineOperation<{ prefix: string }, string, string>({
        name: "echo",
        kind: "read",
        parse(raw) {
            if (typeof raw !== "string") throw new Error("text must be a string");
            return raw;
        },
        async run(context, input) {
            return `${context.prefix}${input}`;
        },
        ...overrides,
    } as Parameters<typeof defineOperation<{ prefix: string }, string, string>>[0]);
}

function makeCatalogue(
    operations: readonly AnyOperation<{ prefix: string }>[],
    phase: DaemonPhase = "ready",
): { catalogue: Catalogue; errors: ReturnType<typeof makeLogger>["errors"] } {
    const { logger, errors } = makeLogger();
    const catalogue = createCatalogue(operations, { context: { prefix: "> " }, phase: () => phase, logger });
    return { catalogue, errors };
}

async function rejection(promise: Promise<unknown>): Promise<ServiceError> {
    try {
        await promise;
    } catch (error) {
        assert.ok(error instanceof ServiceError, `expected a ServiceError, got ${String(error)}`);
        return error;
    }
    throw new Error("expected the call to reject");
}

describe("defineOperation", () => {
    it("throws at definition when the kind is neither read nor control", () => {
        assert.throws(() => echoOperation({ kind: "write" as "read" }), /kind/);
    });

    it("throws at definition when the kind is missing", () => {
        assert.throws(() => echoOperation({ kind: undefined as unknown as "read" }), /kind/);
    });
});

describe("createCatalogue", () => {
    it("refuses two operations with the same name", () => {
        assert.throws(() => makeCatalogue([echoOperation(), echoOperation()]), /echo/);
    });

    it("lists every operation with its kind sorted by name", () => {
        const { catalogue } = makeCatalogue([
            echoOperation({ name: "jobs.cancel", kind: "control" }),
            echoOperation({ name: "daemon.status" }),
            echoOperation({ name: "jobs.list" }),
        ]);
        assert.deepEqual(catalogue.list(), [
            { name: "daemon.status", kind: "read" },
            { name: "jobs.cancel", kind: "control" },
            { name: "jobs.list", kind: "read" },
        ]);
    });
});

describe("invoke", () => {
    it("runs the operation with its context, parsed input and caller", async () => {
        const { catalogue } = makeCatalogue([echoOperation()]);
        assert.equal(await catalogue.invoke("echo", "hi", TEAM_MEMBER), "> hi");
    });

    it("rejects with not_found when the name is unknown", async () => {
        const { catalogue } = makeCatalogue([echoOperation()]);
        const error = await rejection(catalogue.invoke("missing", "hi", TEAM_MEMBER));
        assert.equal(error.code, "not_found");
        assert.match(error.message, /missing/);
    });

    it("rejects with invalid_input when the caller names no actor", async () => {
        const { catalogue } = makeCatalogue([echoOperation()]);
        const error = await rejection(catalogue.invoke("echo", "hi", {} as Caller));
        assert.equal(error.code, "invalid_input");
        assert.match(error.message, /actor/);
    });

    it("rejects with invalid_input naming the failure and does not call run when parse throws", async () => {
        let isRunCalled = false;
        const { catalogue } = makeCatalogue([
            echoOperation({
                async run() {
                    isRunCalled = true;
                    return "";
                },
            }),
        ]);
        const error = await rejection(catalogue.invoke("echo", 42, TEAM_MEMBER));
        assert.equal(error.code, "invalid_input");
        assert.match(error.message, /text must be a string/);
        assert.equal(isRunCalled, false);
    });

    it("rejects with unavailable naming the phase when the phase is not allowed", async () => {
        const { catalogue } = makeCatalogue([echoOperation()], "starting");
        const error = await rejection(catalogue.invoke("echo", "hi", TEAM_MEMBER));
        assert.equal(error.code, "unavailable");
        assert.match(error.message, /starting/);
    });

    it("allows an operation in every phase it lists", async () => {
        const operation = echoOperation({ phases: ["starting", "ready", "stopping"] });
        for (const phase of ["starting", "ready", "stopping"] as const) {
            const { catalogue } = makeCatalogue([operation], phase);
            assert.equal(await catalogue.invoke("echo", "x", TEAM_MEMBER), "> x");
        }
    });

    it("checks the phase before parsing the input", async () => {
        const { catalogue } = makeCatalogue([echoOperation()], "stopping");
        const error = await rejection(catalogue.invoke("echo", 42, TEAM_MEMBER));
        assert.equal(error.code, "unavailable");
    });

    it("checks the actor before the phase", async () => {
        const { catalogue } = makeCatalogue([echoOperation()], "stopping");
        const error = await rejection(catalogue.invoke("echo", "hi", {} as Caller));
        assert.equal(error.code, "invalid_input");
    });

    it("passes a ServiceError from run through unchanged", async () => {
        const thrown = new ServiceError("busy", "all worker threads are held");
        const { catalogue, errors } = makeCatalogue([
            echoOperation({
                async run() {
                    throw thrown;
                },
            }),
        ]);
        assert.equal(await rejection(catalogue.invoke("echo", "hi", TEAM_MEMBER)), thrown);
        assert.deepEqual(errors, []);
    });

    it("turns any other error from run into internal naming the operation and logs it", async () => {
        const { catalogue, errors } = makeCatalogue([
            echoOperation({
                async run() {
                    throw new Error("disk exploded");
                },
            }),
        ]);
        const error = await rejection(catalogue.invoke("echo", "hi", TEAM_MEMBER));
        assert.equal(error.code, "internal");
        assert.match(error.message, /echo/);
        assert.equal(errors.length, 1);
        assert.match(errors[0].message, /echo/);
        assert.match(String(errors[0].fields?.error), /disk exploded/);
    });

    it("turns a synchronous throw from run into internal", async () => {
        const { catalogue } = makeCatalogue([
            echoOperation({
                run() {
                    throw new Error("sync failure");
                },
            }),
        ]);
        assert.equal((await rejection(catalogue.invoke("echo", "hi", TEAM_MEMBER))).code, "internal");
    });

    it("passes the caller to run", async () => {
        const caller: Caller = { actor: { kind: "agent", conversationId: "c-1" } };
        const { catalogue } = makeCatalogue([
            echoOperation({
                async run(_context, _input, received) {
                    return JSON.stringify(received);
                },
            }),
        ]);
        assert.equal(await catalogue.invoke("echo", "hi", caller), JSON.stringify(caller));
    });
});
