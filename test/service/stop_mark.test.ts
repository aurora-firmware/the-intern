import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isStopMarkLive, submitInput } from "../../src/host/conversation_control.ts";
import { abortJobConversations, abortWithAwaited } from "../../src/host/invocation.ts";
import { readConversationMeta } from "../../src/host/seating.ts";
import { disposeFixtures, openFixture, POLL_ATTEMPTS, POLL_PAUSE_MS, pause } from "../support/stop_mark_fixture.ts";

afterEach(disposeFixtures);

describe("the stop mark set by an abort", () => {
    it("holds the newest entry of a busy lead of an In progress job", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("lead");
        await fixture.waitUntilBusy(lead);
        await fixture.waitUntilSteady(lead);
        const newest = await fixture.host.readNewestEntryId(lead);

        await abortWithAwaited(fixture.host, lead);

        assert.ok(newest !== null);
        assert.equal(await fixture.stoppedOf(lead), newest);
    });

    it("is set on a parked lead that is idle", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("idle");
        const [child] = await fixture.invokeParked(lead);
        await fixture.waitUntilBusy(child as string);
        assert.ok((await readConversationMeta(fixture.host, lead))?.parked !== null);
        await fixture.waitUntilIdle(lead);

        await abortWithAwaited(fixture.host, lead);

        assert.equal(await fixture.stoppedOf(lead), await fixture.host.readNewestEntryId(lead));
        assert.equal(await fixture.stoppedOf(child as string), undefined);
    });

    it("is set on an idle lead that only awaits a report", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("idle");
        await fixture.waitUntilIdle(lead);
        const [child] = await fixture.invokeAwaited(lead);
        await fixture.waitUntilBusy(child as string);
        await fixture.waitUntilIdle(lead);
        const before = await readConversationMeta(fixture.host, lead);
        assert.equal(before?.parked, null);
        assert.deepEqual(before?.awaiting, [child]);

        await abortWithAwaited(fixture.host, lead);

        assert.equal(await fixture.stoppedOf(lead), await fixture.host.readNewestEntryId(lead));
    });

    it("is set on an idle lead that only has input queued", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("idle");
        await fixture.waitUntilIdle(lead);
        await fixture.queueInput(lead);
        const before = await readConversationMeta(fixture.host, lead);
        assert.equal(before?.parked, null);
        assert.deepEqual(before?.awaiting, []);

        await abortWithAwaited(fixture.host, lead);

        assert.equal(await fixture.stoppedOf(lead), await fixture.host.readNewestEntryId(lead));
    });

    it("is not set on an idle lead", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("idle");
        await fixture.waitUntilIdle(lead);

        await abortWithAwaited(fixture.host, lead);

        assert.equal(await fixture.stoppedOf(lead), undefined);
    });

    it("is not set when the job is not In progress", async () => {
        const fixture = await openFixture("blocked");
        const lead = await fixture.start("lead");
        await fixture.waitUntilBusy(lead);

        await abortWithAwaited(fixture.host, lead);

        assert.equal(await fixture.stoppedOf(lead), undefined);
    });

    it("is not set on a conversation that is not a lead", async () => {
        const fixture = await openFixture();
        const member = await fixture.start("member", false);
        await fixture.waitUntilBusy(member);

        await abortWithAwaited(fixture.host, member);

        assert.equal(await fixture.stoppedOf(member), undefined);
    });

    it("is not set by the abort of the job's conversations", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("lead");
        await fixture.waitUntilBusy(lead);

        await abortJobConversations(fixture.host, "job-1");

        assert.equal(await fixture.stoppedOf(lead), undefined);
    });
});

describe("isStopMarkLive", () => {
    it("is false for a document with no mark", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("idle");
        await fixture.waitUntilIdle(lead);
        const meta = await readConversationMeta(fixture.host, lead);
        assert.ok(meta !== undefined);

        assert.equal(await isStopMarkLive(fixture.host, lead, meta), false);
    });

    it("is true until an input entry follows the marked entry", async () => {
        const fixture = await openFixture();
        const lead = await fixture.start("lead");
        await fixture.waitUntilBusy(lead);
        await abortWithAwaited(fixture.host, lead);
        const marked = await readConversationMeta(fixture.host, lead);
        assert.ok(marked?.stopped !== undefined);
        assert.equal(await isStopMarkLive(fixture.host, lead, marked), true);

        await submitInput(fixture.host, lead, { content: "idle again", requestId: "r-again", busyMode: "followUp" });

        let live = true;
        for (let attempt = 0; attempt < POLL_ATTEMPTS && live; attempt++) {
            live = await isStopMarkLive(fixture.host, lead, marked);
            if (live) await pause(POLL_PAUSE_MS);
        }
        assert.equal(live, false);
    });
});
