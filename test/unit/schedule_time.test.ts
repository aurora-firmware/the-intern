import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { CronError, localTimeText, nextDueTime, parseCron } from "../../src/schedules/schedule_time.ts";

const originalZone = process.env.TZ;

const inZone = (zone: string): void => {
    process.env.TZ = zone;
};

afterEach(() => {
    if (originalZone === undefined) {
        delete process.env.TZ;
    } else {
        process.env.TZ = originalZone;
    }
});

const dueTimes = (text: string, after: Date, count: number): string[] => {
    const cron = parseCron(text);
    const found: string[] = [];
    let cursor = after;
    for (let index = 0; index < count; index += 1) {
        cursor = nextDueTime(cron, cursor);
        found.push(localTimeText(cursor));
    }
    return found;
};

const refusal = (text: string): CronError => {
    try {
        parseCron(text);
    } catch (error) {
        assert.ok(error instanceof CronError);
        return error;
    }
    assert.fail(`expected ${text} to be refused`);
};

describe("nextDueTime", () => {
    it("gives the next 02:00 in local time for a daily expression", () => {
        inZone("Europe/Madrid");
        const after = new Date(2026, 10, 8, 2, 0);
        assert.deepEqual(dueTimes("0 2 * * *", after, 2), [
            "2026-11-09T02:00:00.000+01:00",
            "2026-11-10T02:00:00.000+01:00",
        ]);
    });

    it("gives due times in the working window for a stepped hour range on weekdays", () => {
        inZone("Europe/Madrid");
        const after = new Date(2026, 10, 6, 17, 45);
        assert.deepEqual(dueTimes("*/15 9-17 * * 1-5", after, 3), [
            "2026-11-09T09:00:00.000+01:00",
            "2026-11-09T09:15:00.000+01:00",
            "2026-11-09T09:30:00.000+01:00",
        ]);
    });

    it("gives the first of the month or a Sunday when both day fields are restricted", () => {
        inZone("Europe/Madrid");
        const after = new Date(2026, 10, 8, 0, 0);
        assert.deepEqual(dueTimes("0 0 1 * 0", after, 3), [
            "2026-11-15T00:00:00.000+01:00",
            "2026-11-22T00:00:00.000+01:00",
            "2026-11-29T00:00:00.000+01:00",
        ]);
        assert.deepEqual(dueTimes("0 0 1 * 0", new Date(2026, 10, 29, 0, 0), 2), [
            "2026-12-01T00:00:00.000+01:00",
            "2026-12-06T00:00:00.000+01:00",
        ]);
    });

    it("reads day of week 7 as Sunday", () => {
        inZone("Europe/Madrid");
        const after = new Date(2026, 10, 8, 0, 0);
        assert.deepEqual(dueTimes("0 0 * * 7", after, 1), ["2026-11-15T00:00:00.000+01:00"]);
    });

    it("treats a day field that covers its whole range as unrestricted", () => {
        inZone("Europe/Madrid");
        const after = new Date(2026, 10, 8, 0, 0);
        assert.deepEqual(dueTimes("0 0 1 * 0-7", after, 1), ["2026-12-01T00:00:00.000+01:00"]);
        assert.deepEqual(dueTimes("0 0 */1 * 1", after, 1), ["2026-11-09T00:00:00.000+01:00"]);
    });

    it("treats a stepped day field as restricted", () => {
        inZone("Europe/Madrid");
        const after = new Date(2026, 10, 8, 0, 0);
        assert.deepEqual(dueTimes("0 0 */2 * 1", after, 2), [
            "2026-11-09T00:00:00.000+01:00",
            "2026-11-11T00:00:00.000+01:00",
        ]);
    });

    it("finds a 29 February up to eight years ahead", () => {
        inZone("Europe/Madrid");
        assert.deepEqual(dueTimes("0 0 29 2 *", new Date(2096, 2, 1, 0, 0), 1), ["2104-02-29T00:00:00.000+01:00"]);
    });

    it("gives each matching minute of a repeated hour once", () => {
        inZone("Europe/Madrid");
        const after = new Date(2027, 9, 31, 0, 0);
        assert.deepEqual(dueTimes("*/20 2 * * *", after, 4), [
            "2027-10-31T02:00:00.000+02:00",
            "2027-10-31T02:20:00.000+02:00",
            "2027-10-31T02:40:00.000+02:00",
            "2027-11-01T02:00:00.000+01:00",
        ]);
    });

    it("passes over a local time that does not exist in Europe/Madrid", () => {
        inZone("Europe/Madrid");
        const after = new Date(2027, 2, 27, 12, 0);
        assert.deepEqual(dueTimes("30 2 * * *", after, 2), [
            "2027-03-29T02:30:00.000+02:00",
            "2027-03-30T02:30:00.000+02:00",
        ]);
    });

    it("passes over the skipped half hour at Lord Howe", () => {
        inZone("Australia/Lord_Howe");
        const after = new Date(2026, 9, 3, 12, 0);
        assert.deepEqual(dueTimes("15 2 * * *", after, 2), [
            "2026-10-05T02:15:00.000+11:00",
            "2026-10-06T02:15:00.000+11:00",
        ]);
    });

    it("passes over a midnight that does not exist in Havana", () => {
        inZone("America/Havana");
        const after = new Date(2027, 2, 13, 12, 0);
        assert.deepEqual(dueTimes("0 0 * * *", after, 2), [
            "2027-03-15T00:00:00.000-04:00",
            "2027-03-16T00:00:00.000-04:00",
        ]);
    });
});

describe("parseCron", () => {
    it("refuses an expression with other than five fields", () => {
        assert.match(refusal("0 2 * *").message, /five fields/);
        assert.match(refusal("0 0 2 * * *").message, /five fields/);
    });

    it("accepts several spaces between fields", () => {
        assert.doesNotThrow(() => parseCron("0   2  *  * *"));
    });

    it("refuses forms outside the reading rules, naming the reason", () => {
        for (const text of [
            "5/15 * * * *",
            "0 0 * * MON",
            "0 0 L * *",
            "0 0 ? * *",
            "@daily",
            "0 0 1W * *",
            "0 0 * * 1#2",
        ]) {
            assert.ok(refusal(text) instanceof CronError, text);
        }
    });

    it("refuses values out of range, descending ranges and a zero step", () => {
        for (const text of [
            "60 * * * *",
            "* 24 * * *",
            "* * 0 * *",
            "* * * 13 *",
            "* * * * 8",
            "30-10 * * * *",
            "*/0 * * * *",
        ]) {
            assert.ok(refusal(text) instanceof CronError, text);
        }
    });

    it("refuses an expression that can never be due", () => {
        assert.match(refusal("0 0 31 2 *").message, /never/);
        assert.match(refusal("0 0 30 2 *").message, /never/);
    });

    it("accepts an expression whose day of week can still come due", () => {
        assert.doesNotThrow(() => parseCron("0 0 31 2 1"));
    });
});

describe("localTimeText", () => {
    it("gives local time with its offset that Date parses back to the same instant", () => {
        for (const zone of ["Europe/Madrid", "Australia/Lord_Howe", "America/Havana", "UTC"]) {
            inZone(zone);
            const at = new Date(2026, 10, 8, 2, 0);
            assert.equal(new Date(localTimeText(at)).getTime(), at.getTime());
        }
        inZone("Europe/Madrid");
        assert.equal(localTimeText(new Date(2026, 10, 8, 2, 0)), "2026-11-08T02:00:00.000+01:00");
        inZone("Australia/Lord_Howe");
        assert.match(localTimeText(new Date(2026, 6, 1, 12, 0)), /\+10:30$/);
    });
});
