import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    INVOCATION_DEPTH_CAP,
    MAX_SUBMISSION_WAIT_MS,
    STOP_BOUND_MS,
    WORKER_THREAD_COUNT,
} from "../../src/daemon/constants.ts";

describe("built-in daemon constants", () => {
    it("fixes the worker thread count at 32", () => {
        assert.equal(WORKER_THREAD_COUNT, 32);
    });

    it("fixes the invocation depth cap at 10", () => {
        assert.equal(INVOCATION_DEPTH_CAP, 10);
    });

    it("fixes the stop bound at 10 seconds", () => {
        assert.equal(STOP_BOUND_MS, 10_000);
    });

    it("fixes the maximum submission wait at 5 minutes", () => {
        assert.equal(MAX_SUBMISSION_WAIT_MS, 300_000);
    });
});
