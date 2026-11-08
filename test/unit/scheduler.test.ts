import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import type { ScheduleEntry } from "../../src/schedules/schedule_model.ts";
import { createScheduler } from "../../src/schedules/scheduler.ts";
import type { ScheduleClock } from "../../src/schedules/schedules_component.ts";
import type { DaemonPhase } from "../../src/service/operations.ts";

const originalZone = process.env.TZ;

const at = (text: string): Date => new Date(`2026-03-10T${text}`);

type FakeClock = ScheduleClock & {
    /** Moves the clock to `time` and ends the current wait, as a wake-up there would. */
    moveTo(time: Date): Promise<void>;
};

const createFakeClock = (start: Date): FakeClock => {
    let current = start;
    let waiting: (() => void) | undefined;
    return {
        now: () => current,
        wait: (_until, signal) =>
            new Promise<void>((resolve) => {
                waiting = resolve;
                signal.addEventListener("abort", () => resolve(), { once: true });
                if (signal.aborted) resolve();
            }),
        async moveTo(time) {
            current = time;
            const resolve = waiting;
            waiting = undefined;
            resolve?.();
            await settle();
        },
    };
};

const settle = async (): Promise<void> => {
    for (let turn = 0; turn < 20; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
};

const silentLogger = { error: () => {}, info: () => {}, debug: () => {} };

const entry = (name: string, cron: string): ScheduleEntry => ({ name, cron, request: "go" });

describe("scheduler", () => {
    let phase: DaemonPhase;
    let entries: ScheduleEntry[];
    let fires: string[];

    beforeEach(() => {
        process.env.TZ = "UTC";
        phase = "ready";
        entries = [entry("two", "0 2 * * *")];
        fires = [];
    });

    afterEach(() => {
        if (originalZone === undefined) delete process.env.TZ;
        else process.env.TZ = originalZone;
    });

    const build = (clock: ScheduleClock, fire?: (entry: ScheduleEntry, due: Date) => Promise<void>) =>
        createScheduler({
            clock,
            phase: () => phase,
            entries: () => entries,
            fire:
                fire ??
                (async (fired, due) => {
                    fires.push(`${fired.name}@${due.toISOString().slice(11, 16)}`);
                }),
            logger: silentLogger,
        });

    it("fires nothing while the phase isn't ready and never fires that due time after", async () => {
        const clock = createFakeClock(at("01:59:30Z"));
        const scheduler = build(clock);
        phase = "starting";
        scheduler.start();
        await clock.moveTo(at("02:00:05Z"));
        phase = "ready";
        await clock.moveTo(at("02:01:05Z"));
        await clock.moveTo(at("02:02:05Z"));
        await scheduler.stop();
        assert.deepEqual(fires, []);
    });

    it("starts no fire for a due time the clock jumped over", async () => {
        const clock = createFakeClock(at("01:59:00Z"));
        const scheduler = build(clock);
        scheduler.start();
        await clock.moveTo(at("02:30:00Z"));
        await scheduler.stop();
        assert.deepEqual(fires, []);
    });

    it("fires a due time less than a minute old at the check", async () => {
        const clock = createFakeClock(at("01:59:50Z"));
        const scheduler = build(clock);
        scheduler.start();
        await clock.moveTo(at("02:00:40Z"));
        await scheduler.stop();
        assert.deepEqual(fires, ["two@02:00"]);
    });

    it("fires a due time again when the clock goes back past it", async () => {
        const clock = createFakeClock(at("01:59:50Z"));
        const scheduler = build(clock);
        scheduler.start();
        await clock.moveTo(at("02:00:10Z"));
        await clock.moveTo(at("01:58:50Z"));
        await clock.moveTo(at("02:00:20Z"));
        await scheduler.stop();
        assert.deepEqual(fires, ["two@02:00", "two@02:00"]);
    });

    it("reads the entries at each tick so a change reaches later due times only", async () => {
        const clock = createFakeClock(at("01:59:50Z"));
        const scheduler = build(clock);
        scheduler.start();
        await clock.moveTo(at("02:00:20Z"));
        entries = [entry("two", "0 2 * * *"), entry("late", "1 2 * * *")];
        await clock.moveTo(at("02:01:20Z"));
        await scheduler.stop();
        assert.deepEqual(fires, ["two@02:00", "late@02:01"]);
    });

    it("lets a slow fire hold back neither the next tick nor another entry", async () => {
        entries = [entry("slow", "* * * * *"), entry("quick", "* * * * *")];
        const clock = createFakeClock(at("01:59:50Z"));
        const release: (() => void)[] = [];
        const scheduler = build(clock, async (fired, due) => {
            if (fired.name === "slow") await new Promise<void>((resolve) => release.push(resolve));
            fires.push(`${fired.name}@${due.toISOString().slice(11, 16)}`);
        });
        scheduler.start();
        await clock.moveTo(at("02:00:05Z"));
        await clock.moveTo(at("02:01:05Z"));
        assert.deepEqual(fires, ["quick@02:00", "quick@02:01"]);
        for (const resolve of release) resolve();
        await scheduler.stop();
    });

    it("waits for a fire in flight when it stops", async () => {
        const clock = createFakeClock(at("01:59:50Z"));
        let release = () => {};
        const scheduler = build(clock, async () => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            fires.push("done");
        });
        scheduler.start();
        await clock.moveTo(at("02:00:05Z"));
        let stopped = false;
        const stopping = scheduler.stop().then(() => {
            stopped = true;
        });
        await settle();
        assert.equal(stopped, false);
        release();
        await stopping;
        assert.deepEqual(fires, ["done"]);
    });

    it("logs a fire that rejects and keeps ticking", async () => {
        entries = [entry("every", "* * * * *")];
        const clock = createFakeClock(at("01:59:50Z"));
        let calls = 0;
        const scheduler = build(clock, async () => {
            calls += 1;
            throw new Error("boom");
        });
        scheduler.start();
        await clock.moveTo(at("02:00:05Z"));
        await clock.moveTo(at("02:01:05Z"));
        await scheduler.stop();
        assert.equal(calls, 2);
    });
});
