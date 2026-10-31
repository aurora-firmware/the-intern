import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { AdmissionSnapshot } from "../../src/admission/admission.ts";
import { WORKER_THREAD_COUNT } from "../../src/daemon/constants.ts";
import type { InstanceDirs } from "../../src/daemon/state_layout.ts";
import { createCatalogue, type DaemonPhase } from "../../src/service/operations.ts";
import { type StatusSources, statusOperation } from "../../src/service/status_operation.ts";

const DIRS: InstanceDirs = {
    configDir: "/cfg",
    stateDir: "/state",
    dataDir: "/data",
    runtimeDir: "/run",
    configFile: "/cfg/config.json",
    databaseFile: "/state/db.sqlite",
};
const STARTED_AT = new Date("2026-10-31T08:30:00.000Z");
const CALLER = { actor: { kind: "team_member" } } as const;
const silentLogger = { error: () => {}, info: () => {}, debug: () => {} };

function makeStatus(phase: DaemonPhase, admission: AdmissionSnapshot) {
    const status: StatusSources = {
        phase: () => phase,
        startedAt: STARTED_AT,
        versions: { intern: "1.2.3", pi: "4.5.6" },
        dirs: DIRS,
        admission: () => admission,
    };
    return createCatalogue([statusOperation], {
        context: { status },
        phase: () => phase,
        logger: silentLogger,
    });
}

const IDLE: AdmissionSnapshot = { capacity: WORKER_THREAD_COUNT, active: [], waiting: [] };

describe("daemon.status", () => {
    it("is a read operation named daemon.status", () => {
        assert.deepEqual(makeStatus("ready", IDLE).list(), [{ name: "daemon.status", kind: "read" }]);
    });

    for (const phase of ["starting", "ready", "stopping"] as const) {
        it(`answers while the daemon is ${phase} and reports that phase`, async () => {
            const result = (await makeStatus(phase, IDLE).invoke("daemon.status", {}, CALLER)) as { phase: string };
            assert.equal(result.phase, phase);
        });
    }

    it("reports versions, start time as ISO-8601 and the four instance directories", async () => {
        const result = await makeStatus("ready", IDLE).invoke("daemon.status", {}, CALLER);
        assert.deepEqual(result, {
            phase: "ready",
            startedAt: "2026-10-31T08:30:00.000Z",
            versions: { intern: "1.2.3", pi: "4.5.6" },
            instance: { configDir: "/cfg", stateDir: "/state", dataDir: "/data", runtimeDir: "/run" },
            workerThreads: { count: 32, inUse: 0, waiting: [] },
        });
    });

    it("reports the count in use and each waiting conversation with its position", async () => {
        const admission: AdmissionSnapshot = {
            capacity: 2,
            active: ["c1", "c2"],
            waiting: [
                { conversationId: "c3", position: 1 },
                { conversationId: "c4", position: 2 },
            ],
        };
        const result = (await makeStatus("ready", admission).invoke("daemon.status", {}, CALLER)) as {
            workerThreads: unknown;
        };
        assert.deepEqual(result.workerThreads, { count: 2, inUse: 2, waiting: admission.waiting });
    });

    it("reports 32 worker threads when the capacity is WORKER_THREAD_COUNT", async () => {
        const result = (await makeStatus("ready", IDLE).invoke("daemon.status", {}, CALLER)) as {
            workerThreads: { count: number };
        };
        assert.equal(result.workerThreads.count, 32);
    });
});
