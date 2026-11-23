import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type AdmissionState, positions, release, request, restore } from "../../src/admission/admission_queue.ts";

const state = (active: string[], waiting: string[] = []): AdmissionState => ({ active, waiting });

describe("request", () => {
    it("grants a new id while fewer than capacity are active and none waits", () => {
        const result = request(state(["a"]), "b", 2);
        assert.deepEqual(result, { state: state(["a", "b"]), granted: true });
    });

    it("appends a new id to the waiting list when every worker thread is held", () => {
        const result = request(state(["a"], ["b"]), "c", 1);
        assert.deepEqual(result, { state: state(["a"], ["b", "c"]), granted: false });
    });

    it("queues a newcomer behind waiting runs even when a worker thread is free", () => {
        const result = request(state(["a"], ["b"]), "c", 2);
        assert.deepEqual(result, { state: state(["a"], ["b", "c"]), granted: false });
    });

    it("grants an active id again without changing the state", () => {
        const result = request(state(["a", "b"]), "a", 2);
        assert.deepEqual(result, { state: state(["a", "b"]), granted: true });
    });

    it("keeps a waiting id waiting without changing the state", () => {
        const result = request(state(["a"], ["b"]), "b", 1);
        assert.deepEqual(result, { state: state(["a"], ["b"]), granted: false });
    });

    it("does not modify the state it was given", () => {
        const input = state(["a"], ["b"]);
        request(input, "c", 1);
        assert.deepEqual(input, state(["a"], ["b"]));
    });
});

describe("release", () => {
    it("grants the head of the waiting list when an active run releases", () => {
        const result = release(state(["a", "b"], ["c", "d"]), "a", 2);
        assert.deepEqual(result, { state: state(["b", "c"], ["d"]), granted: ["c"] });
    });

    it("removes a waiting id without granting anything", () => {
        const result = release(state(["a"], ["b", "c"]), "b", 1);
        assert.deepEqual(result, { state: state(["a"], ["c"]), granted: [] });
    });

    it("grants several waiting runs when capacity has room for them", () => {
        const result = release(state(["a"], ["b", "c", "d"]), "a", 3);
        assert.deepEqual(result, { state: state(["b", "c", "d"]), granted: ["b", "c", "d"] });
    });

    it("leaves the state unchanged when the id is unknown", () => {
        const result = release(state(["a"], ["b"]), "z", 1);
        assert.deepEqual(result, { state: state(["a"], ["b"]), granted: [] });
    });
});

describe("positions", () => {
    it("gives each waiting id its 1-based position", () => {
        assert.deepEqual(positions(state(["a"], ["b", "c"])), [
            { conversationId: "b", position: 1 },
            { conversationId: "c", position: 2 },
        ]);
    });

    it("returns nothing when no run waits", () => {
        assert.deepEqual(positions(state(["a"])), []);
    });
});

describe("restore", () => {
    it("keeps the earliest-granted runs active and puts the extra ones ahead of the waiting runs", () => {
        const result = restore(state(["a", "b", "c", "d"], ["e"]), 2);
        assert.deepEqual(result, { state: state(["a", "b"], ["c", "d", "e"]), granted: [] });
    });

    it("grants waiting runs in stored order while worker threads are free", () => {
        const result = restore(state(["a"], ["b", "c", "d"]), 3);
        assert.deepEqual(result, { state: state(["a", "b", "c"], ["d"]), granted: ["b", "c"] });
    });

    it("leaves the state unchanged when capacity is exactly held", () => {
        const result = restore(state(["a", "b"], ["c"]), 2);
        assert.deepEqual(result, { state: state(["a", "b"], ["c"]), granted: [] });
    });
});
