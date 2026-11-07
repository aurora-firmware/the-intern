import { describe, it } from "node:test";
import { bestOf } from "../support/best_of.ts";

describe("bestOf", () => {
    it("returns the lowest measurement when a later attempt is faster", async (t) => {
        const samples = [900, 400, 700];
        const best = await bestOf(3, async () => samples.shift() as number, 500);
        t.assert.equal(best, 400);
    });

    it("stops measuring once an attempt is within the limit", async (t) => {
        let calls = 0;
        const best = await bestOf(
            5,
            async () => {
                calls++;
                return calls === 1 ? 800 : 300;
            },
            500,
        );
        t.assert.equal(best, 300);
        t.assert.equal(calls, 2);
    });

    it("returns the lowest measurement over the limit when every attempt is slow", async (t) => {
        const samples = [900, 700, 800];
        const best = await bestOf(3, async () => samples.shift() as number, 500);
        t.assert.equal(best, 700);
    });

    it("rejects an attempt count below one", async (t) => {
        await t.assert.rejects(
            bestOf(0, async () => 1, 500),
            /at least one attempt/,
        );
    });
});
