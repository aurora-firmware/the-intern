import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createAccountStatusHub } from "../../src/accounts/account_status.ts";
import { createTestClock } from "../support/schedule_rig.ts";

const MINUTE_MS = 60_000;
const START = new Date(2026, 10, 8, 1, 0, 0);

const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const setup = () => {
    const clock = createTestClock(START);
    const hub = createAccountStatusHub({ clock });
    const retries: string[] = [];
    const options = (name: string, extra: { needsSignIn?: boolean } = {}) => ({
        checkIntervalSeconds: 60,
        needsSignIn: extra.needsSignIn ?? false,
        retry: () => {
            retries.push(name);
        },
    });
    const advance = async (ms: number) => {
        clock.advance(ms);
        await settle();
    };
    return { clock, hub, retries, options, advance };
};

describe("account status hub", () => {
    it("sets connecting when an account starts and publishes the change", () => {
        const { hub, options } = setup();
        const seen: string[] = [];
        hub.onChange((view) => seen.push(`${view.name}:${view.status}`));
        hub.start("mail", "work", options("work"));
        assert.equal(hub.get("mail", "work")?.status, "connecting");
        assert.deepEqual(seen, ["work:connecting"]);
    });

    it("sets needs_sign_in when an account starts with needsSignIn", () => {
        const { hub, options } = setup();
        hub.start("mail", "work", options("work", { needsSignIn: true }));
        assert.equal(hub.get("mail", "work")?.status, "needs_sign_in");
    });

    it("keeps the message with its time and the check's time when a check fails", () => {
        const { hub, options } = setup();
        hub.start("mail", "work", options("work"));
        hub.report("mail", "work", { kind: "failing", message: "connection refused" });
        const view = hub.get("mail", "work");
        assert.equal(view?.status, "failing");
        assert.equal(view?.lastError?.message, "connection refused");
        assert.deepEqual(view?.lastError?.at, START);
        assert.deepEqual(view?.lastCheck, START);
    });

    it("calls retry after the check interval, then at doubling pauses capped at 30 minutes", async () => {
        const { hub, retries, options, advance } = setup();
        hub.start("mail", "work", options("work"));
        const fail = () => hub.report("mail", "work", { kind: "failing", message: "down" });
        const pausesMinutes = [1, 2, 4, 8, 16, 30, 30];
        fail();
        for (const pause of pausesMinutes) {
            const before = retries.length;
            await advance(pause * MINUTE_MS - 1);
            assert.equal(retries.length, before, `no retry before ${pause} minutes`);
            await advance(1);
            assert.equal(retries.length, before + 1, `a retry after ${pause} minutes`);
            fail();
        }
    });

    it("sets ready, resets the pauses and publishes when a check reports ready", async () => {
        const { hub, retries, options, advance } = setup();
        const seen: string[] = [];
        hub.start("mail", "work", options("work"));
        hub.report("mail", "work", { kind: "failing", message: "down" });
        await advance(MINUTE_MS);
        hub.report("mail", "work", { kind: "failing", message: "down" });
        await advance(2 * MINUTE_MS);
        assert.equal(retries.length, 2);
        hub.onChange((view) => seen.push(view.status));
        hub.report("mail", "work", { kind: "ready" });
        assert.equal(hub.get("mail", "work")?.status, "ready");
        assert.deepEqual(seen, ["ready"]);
        hub.report("mail", "work", { kind: "failing", message: "down again" });
        await advance(MINUTE_MS);
        assert.equal(retries.length, 3, "the first pause is the check interval again");
    });

    it("schedules no retry while an account needs sign-in", async () => {
        const { hub, retries, options, advance } = setup();
        hub.start("mail", "work", options("work"));
        hub.report("mail", "work", { kind: "needs_sign_in", message: "token revoked" });
        assert.equal(hub.get("mail", "work")?.status, "needs_sign_in");
        assert.equal(hub.get("mail", "work")?.lastError?.message, "token revoked");
        // The other account's retry comes after the one that must not fire: it proves the wait has passed.
        hub.start("mail", "other", options("other"));
        hub.report("mail", "other", { kind: "failing", message: "down" });
        await advance(60 * MINUTE_MS);
        assert.deepEqual(retries, ["other"]);
    });

    it("fires each failing account's retry at its own time", async () => {
        const { hub, retries, options, advance } = setup();
        hub.start("mail", "a", { ...options("a"), checkIntervalSeconds: 60 });
        hub.start("mail", "b", { ...options("b"), checkIntervalSeconds: 300 });
        hub.report("mail", "a", { kind: "failing", message: "down" });
        hub.report("mail", "b", { kind: "failing", message: "down" });
        await advance(MINUTE_MS);
        assert.deepEqual(retries, ["a"]);
        hub.report("mail", "a", { kind: "failing", message: "down" });
        await advance(4 * MINUTE_MS);
        assert.deepEqual(retries, ["a", "b"]);
    });

    it("cancels the timer and forgets an account when it stops", async () => {
        const { hub, retries, options, advance } = setup();
        hub.start("mail", "work", options("work"));
        hub.report("mail", "work", { kind: "failing", message: "down" });
        hub.stop("mail", "work");
        hub.start("mail", "other", options("other"));
        hub.report("mail", "other", { kind: "failing", message: "down" });
        await advance(MINUTE_MS);
        assert.deepEqual(retries, ["other"]);
        assert.equal(hub.get("mail", "work"), undefined);
        assert.deepEqual(
            hub.list("mail").map((view) => view.name),
            ["other"],
        );
    });
});
