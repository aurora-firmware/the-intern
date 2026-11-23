import assert from "node:assert/strict";
import { readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
    readStartupReport,
    removeStartupReport,
    STARTUP_REPORT_FILE,
    type StartupReport,
    writeStartupReport,
} from "../../src/daemon/startup_report.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const OWNER_ONLY_FILE_MODE = 0o600;

function report(overrides: Partial<StartupReport> = {}): StartupReport {
    return {
        format: 1,
        version: "1.2.3",
        pid: 4242,
        serviceLabel: null,
        furthestStep: 3,
        failedStep: null,
        failedStepName: null,
        reason: null,
        unreadableDatabase: false,
        ready: false,
        ...overrides,
    };
}

let env: HermeticEnv;

beforeEach(async () => {
    env = await createHermeticEnv();
});

afterEach(async () => {
    await env.dispose();
});

describe("startup report", () => {
    it("reads back what was written", async () => {
        const written = report({ serviceLabel: "the-intern", failedStep: 4, failedStepName: "x", reason: "why" });

        await writeStartupReport(env.stateDir, written);

        assert.deepEqual(await readStartupReport(env.stateDir), written);
    });

    it("writes the file with mode 0600", async () => {
        await writeStartupReport(env.stateDir, report());

        const info = await stat(join(env.stateDir, STARTUP_REPORT_FILE));
        assert.equal(info.mode & 0o777, OWNER_ONLY_FILE_MODE);
    });

    it("replaces the file whole and leaves nothing beside it", async () => {
        await writeStartupReport(env.stateDir, report({ furthestStep: 2 }));
        await writeStartupReport(env.stateDir, report({ furthestStep: 5, ready: true }));

        assert.deepEqual(await readStartupReport(env.stateDir), report({ furthestStep: 5, ready: true }));
        assert.deepEqual(await readdir(env.stateDir), [STARTUP_REPORT_FILE]);
    });

    it("reads as undefined when there is no file", async () => {
        assert.equal(await readStartupReport(env.stateDir), undefined);
    });

    it("refuses a newer format, naming the file", async () => {
        const file = join(env.stateDir, STARTUP_REPORT_FILE);
        await writeFile(file, JSON.stringify({ ...report(), format: 2 }));

        await assert.rejects(readStartupReport(env.stateDir), (error: Error) => {
            assert.ok(error.message.includes(file));
            assert.match(error.message, /format 2/);
            return true;
        });
    });

    it("refuses a file that is not valid JSON, naming the file", async () => {
        const file = join(env.stateDir, STARTUP_REPORT_FILE);
        await writeFile(file, "{not json");

        await assert.rejects(readStartupReport(env.stateDir), (error: Error) => error.message.includes(file));
    });

    it("removes the file, and removing it again is not an error", async () => {
        await writeStartupReport(env.stateDir, report());

        await removeStartupReport(env.stateDir);
        await removeStartupReport(env.stateDir);

        assert.equal(await readStartupReport(env.stateDir), undefined);
    });
});
