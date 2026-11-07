/**
 * The client library over both listeners of a real daemon (S-003 REQ-009, AC-009.1, AC-009.2): calls answer as they
 * answer in-process, a failed call fails with the in-process code and message, a subscription yields the snapshot and
 * the deltas and ends with the reason, and a call cut by the daemon stopping fails as unavailable or unreachable.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { ClientError, UnreachableError } from "../../src/client/client.ts";
import type { Caller, Catalogue } from "../../src/service/operations.ts";
import {
    cleanupFixtures,
    type Fixture,
    LISTENERS,
    type Listener,
    readUntilEnd,
    startFixture,
    TEST_TIMEOUT_MS,
    until,
} from "../support/client_fixture.ts";
import type { FakeTranscript } from "../support/fake_model.ts";

const UNKNOWN_CONVERSATION = { conversationId: "999" };
const UNKNOWN_CONVERSATION_FEED = { scope: "conversation", conversationId: "999" } as const;
const INSTANCE_FEED = { scope: "instance" } as const;
const HOLD_INPUT = "hold";
/** Longer than the test; stopping the daemon aborts the held answer. */
const HOLD_DELAY_MS = 120_000;
/** Longer than the test, so only the daemon stopping ends the wait. */
const WAIT_LONGER_THAN_TEST_MS = 120_000;
const WATCHED_ROLE = { name: "watched", instructions: "Watch.", tools: ["read"], skills: [] };

afterEach(async () => {
    mock.restoreAll();
    await cleanupFixtures();
});

async function rejection(promise: Promise<unknown>): Promise<unknown> {
    return promise.then(
        (value) => assert.fail(`the call was answered with ${JSON.stringify(value)}`),
        (error: unknown) => error,
    );
}

/** The code and message an operation fails with in-process. */
async function inProcessFailure(fixture: Fixture, name: string, input: unknown) {
    const error = (await rejection(fixture.invoke(name, input))) as Error & { code: string };
    return { code: error.code, message: error.message };
}

describe("calls through the client over each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const listener of LISTENERS) {
        it(`returns the in-process daemon.status over the ${listener}`, async () => {
            const fixture = await startFixture();

            const status = await fixture.clientOver(listener).invoke("daemon.status");

            assert.deepEqual(status, await fixture.invoke("daemon.status", {}));
        });

        it(`fails over the ${listener} with ClientError carrying the in-process code and message`, async () => {
            const fixture = await startFixture();
            const inProcess = await inProcessFailure(fixture, "conversations.get", UNKNOWN_CONVERSATION);

            const error = await rejection(
                fixture.clientOver(listener).invoke("conversations.get", UNKNOWN_CONVERSATION),
            );

            assert.ok(error instanceof ClientError, `the call fails with ClientError, not ${error}`);
            assert.equal(inProcess.code, "not_found");
            assert.deepEqual({ code: error.code, message: error.message }, inProcess);
        });

        it(`fails a refused subscription over the ${listener} with the in-process code and message`, async () => {
            const fixture = await startFixture();
            const inProcess = await inProcessFailure(fixture, "feed.subscribe", UNKNOWN_CONVERSATION_FEED);

            const feed = fixture.clientOver(listener).subscribe(UNKNOWN_CONVERSATION_FEED);
            const error = await rejection(feed.next());

            assert.ok(error instanceof ClientError, `the subscription fails with ClientError, not ${error}`);
            assert.equal(inProcess.code, "not_found");
            assert.deepEqual({ code: error.code, message: error.message }, inProcess);
        });
    }
});

type InstanceDelta = { seq: number; type: string };

/** Counts the feed subscriptions the listeners open, from the moment it is called. */
function countSubscriptions(catalogue: Catalogue): { count: number } {
    const counted = { count: 0 };
    const invoke = catalogue.invoke.bind(catalogue);
    mock.method(catalogue, "invoke", (name: string, input: unknown, caller: Caller) => {
        if (name === "feed.subscribe") counted.count += 1;
        return invoke(name, input, caller);
    });
    return counted;
}

describe("a subscription through the client over each listener", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const listener of LISTENERS) {
        it(`yields the snapshot, then the deltas in order, and ends stopped over the ${listener}`, async () => {
            const fixture = await startFixture();
            const inProcess = (await fixture.invoke("feed.subscribe", INSTANCE_FEED)) as {
                snapshot: unknown;
                close(): void;
            };
            inProcess.close();
            const subscriptions = countSubscriptions(fixture.daemon.catalogue);
            const feed = fixture.clientOver(listener).subscribe(INSTANCE_FEED);

            const first = await feed.next();
            await fixture.invoke("roles.create", WATCHED_ROLE);
            const deltas: InstanceDelta[] = [];
            while (deltas.at(-1)?.type !== "settings_changed") {
                const read = await feed.next();
                assert.ok(!read.done && "delta" in read.value, `a delta follows, not ${JSON.stringify(read)}`);
                deltas.push(read.value.delta as InstanceDelta);
            }
            const [rest] = await Promise.all([readUntilEnd(feed), fixture.daemon.stop()]);
            const afterEnd = await feed.next();

            assert.deepEqual(first, { done: false, value: { snapshot: inProcess.snapshot } });
            assert.deepEqual(
                deltas.map((delta) => delta.seq),
                deltas.map((_, index) => index + 1),
            );
            assert.ok(rest.items.every((item) => typeof item === "object" && item !== null && "delta" in item));
            assert.deepEqual(rest.end, { end: "stopped" });
            assert.deepEqual(afterEnd, { done: true, value: undefined }, "the ended subscription stays ended");
            assert.equal(subscriptions.count, 1, "the client opened one subscription and no other");
        });
    }
});

/** Holds the answer to `HOLD_INPUT` back for `HOLD_DELAY_MS`; any other input is answered at once. */
function holdingDelay(transcript: FakeTranscript): number {
    return transcript.findLast((message) => message.role === "user")?.text === HOLD_INPUT ? HOLD_DELAY_MS : 0;
}

/**
 * Creates a job over the listener, waits until its lead conversation is idle, then submits the held input and returns
 * its id.
 */
async function heldSubmission(fixture: Fixture, listener: Listener): Promise<string> {
    const created = (await fixture.clientOver(listener).invoke("jobs.create", { text: "hello" })) as {
        leadConversation: string;
    };
    const conversationId = created.leadConversation;
    const isIdle = async () =>
        ((await fixture.invoke("conversations.get", { conversationId })) as { status: string }).status === "idle";
    await until(isIdle, `conversation ${conversationId} to be idle`);
    const submit = { conversationId, content: HOLD_INPUT, requestId: "held-request" };
    return ((await fixture.invoke("conversations.submit", submit)) as { submissionId: string }).submissionId;
}

/** Resolves once a listener has handed `submissions.wait` to the catalogue. */
function waitReachesCatalogue(catalogue: Catalogue): Promise<void> {
    const { promise, resolve } = Promise.withResolvers<void>();
    const invoke = catalogue.invoke.bind(catalogue);
    mock.method(catalogue, "invoke", (name: string, input: unknown, caller: Caller) => {
        if (name === "submissions.wait") resolve();
        return invoke(name, input, caller);
    });
    return promise;
}

describe("a call waiting in submissions.wait when the daemon stops", { timeout: TEST_TIMEOUT_MS }, () => {
    for (const listener of LISTENERS) {
        it(`fails over the ${listener} with ClientError unavailable or UnreachableError naming the target`, async () => {
            const fixture = await startFixture(holdingDelay);
            const submissionId = await heldSubmission(fixture, listener);
            const reached = waitReachesCatalogue(fixture.daemon.catalogue);

            const waiting = rejection(
                fixture
                    .clientOver(listener)
                    .invoke("submissions.wait", { submissionId, timeoutMs: WAIT_LONGER_THAN_TEST_MS }),
            );
            await reached;
            await fixture.daemon.stop();
            const error = await waiting;

            const isUnavailable = error instanceof ClientError && error.code === "unavailable";
            const isUnreachable = error instanceof UnreachableError && error.target === fixture.targetOf(listener);
            assert.ok(isUnavailable || isUnreachable, `the wait fails as unavailable or unreachable, not ${error}`);
        });
    }
});
