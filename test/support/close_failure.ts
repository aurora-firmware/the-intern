import type { HarnessHost } from "../../src/host/harness_host.ts";
import { internalHarness } from "../../src/host/harness_host.ts";

export interface CloseFailures {
    /** The nth closed-mark commit (1-based) rejects. */
    failMark?: number;
    /** Every `Conversation.abort()` call on this conversation rejects, so it keeps running. */
    failAbortOf?: string;
    /** Every `abortTask` call rejects, the stop of a running compaction included. */
    failCompactionAbort?: boolean;
    /** The nth `listConversations` call (1-based) and every later one rejects. */
    failListingFrom?: number;
}

export interface CloseFailureLog {
    /** The ids of the conversations whose `abort()` was called, in order. */
    aborts: string[];
}

/**
 * Makes the closed-mark commit, the conversation abort, the compaction stop or the listing reject, as a real storage
 * failure would. A throwing `afterWrite` hook can't do this: it stands in for a crash after the write.
 */
export function injectCloseFailures(host: HarnessHost, failures: CloseFailures): CloseFailureLog {
    const harness = internalHarness(host);
    const log: CloseFailureLog = { aborts: [] };
    let marks = 0;
    const commit = harness.commit.bind(harness);
    harness.commit = ((work: never, context: never) => {
        if ((new Error().stack ?? "").includes("closeConversation")) {
            marks++;
            if (marks === failures.failMark) return Promise.reject(new Error("injected mark failure"));
        }
        return commit(work, context);
    }) as typeof harness.commit;
    const conversation = harness.conversation.bind(harness);
    harness.conversation = (async (id: never, context: never) => {
        const found = await conversation(id, context);
        if (!found) return found;
        return new Proxy(found, {
            get(target, key) {
                if (key !== "abort") {
                    const value = Reflect.get(target, key);
                    return typeof value === "function" ? value.bind(target) : value;
                }
                return (...args: Parameters<typeof target.abort>) => {
                    log.aborts.push(String(id));
                    if (String(id) === failures.failAbortOf) return Promise.reject(new Error("injected abort failure"));
                    return target.abort(...args);
                };
            },
        });
    }) as typeof harness.conversation;
    if (failures.failCompactionAbort) {
        harness.abortTask = (() =>
            Promise.reject(new Error("injected compaction abort failure"))) as typeof harness.abortTask;
    }
    if (failures.failListingFrom !== undefined) {
        let calls = 0;
        const list = host.listConversations.bind(host);
        host.listConversations = () =>
            ++calls >= (failures.failListingFrom as number)
                ? Promise.reject(new Error("injected listing failure"))
                : list();
    }
    return log;
}
