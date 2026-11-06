/**
 * The patient client passes a subscription through to the wrapped client with its options (T-223): the follower owns
 * a subscription, and an abort signal must reach the transport.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { patientClient } from "../../src/cli/patient_client.ts";
import type { Client, SubscribeOptions } from "../../src/client/client.ts";

type Seen = { method: string; options: SubscribeOptions | undefined };

/** A client whose subscriptions record the options they were given, and yield one snapshot. */
function recordingClient(seen: Seen[]): Client {
    async function* ended(method: string, options: SubscribeOptions | undefined) {
        seen.push({ method, options });
        yield { snapshot: null };
        return { end: "stopped" };
    }
    return {
        invoke: () => assert.fail("no call is made"),
        subscribe: (_scope: unknown, options?: SubscribeOptions) => ended("subscribe", options),
        subscribeConversations: (_ids: unknown, options?: SubscribeOptions) => ended("subscribeConversations", options),
    } as unknown as Client;
}

describe("patientClient subscriptions", () => {
    it("passes the same options object on to the wrapped client for both methods", async () => {
        const seen: Seen[] = [];
        const options: SubscribeOptions = { signal: new AbortController().signal };
        const patient = patientClient(recordingClient(seen), { onNotice: () => {} });

        await patient.subscribe({ scope: "instance" }, options).next();
        await patient.subscribeConversations(["c1"], options).next();

        assert.deepEqual(
            seen.map((entry) => entry.method),
            ["subscribe", "subscribeConversations"],
        );
        assert.ok(seen.every((entry) => entry.options === options));
    });

    it("passes undefined on when the caller gives no options", async () => {
        const seen: Seen[] = [];
        const patient = patientClient(recordingClient(seen), { onNotice: () => {} });

        await patient.subscribe({ scope: "instance" }).next();
        await patient.subscribeConversations(["c1"]).next();

        assert.ok(seen.every((entry) => entry.options === undefined));
        assert.equal(seen.length, 2);
    });
});
