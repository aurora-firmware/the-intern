/**
 * The abort of the Done jobs' conversations at startup repair (S-004 REQ-018, S-002 REQ-002 step 7). pi-durable's
 * `Conversation.abort()` turns scheduling on, so the first abort of a repair would let other conversations' runs send
 * model requests before their own abort. This marks the work for abort without turning scheduling on and without
 * waiting for it to end; the daemon resumes the host afterwards and then waits for the marked conversations to settle.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { TaskId } from "@earendil-works/pi-durable";
import { requireConversation } from "./conversation_control.ts";
import { toConversationId } from "./conversation_id.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import { abortRunningCompactions, closeJobConversations } from "./invocation.ts";

const context = BACKGROUND_CONTEXT;

// Marks the live tasks that are neither background nor owned by another marked task: the owner's abort reaches the
// tasks below it, and a blocking compaction aborted alone would fail the run that owns it.
async function markLiveTasks(host: HarnessHost, conversationIds: string[]): Promise<void> {
    const harness = internalHarness(host);
    const inJob = new Set(conversationIds.map((id) => toConversationId(id)));
    const { tasks } = await harness.inspect(context);
    const ofJob = tasks
        .map((task) => task.record)
        .filter((record) => inJob.has(record.conversationId) && !record.background);
    const markedIds = new Set<TaskId>(ofJob.map((record) => record.id));
    for (const record of ofJob) {
        if (record.owner === undefined || !markedIds.has(record.owner)) await harness.abortTask(record.id, context);
    }
}

/**
 * Closes the job's conversations, then marks their running work for abort. The closing commit already settles every
 * queued item of their inboxes, so no queued input remains to withdraw. Never resumes scheduling and never waits for a
 * run to end. Returns the conversations, for `waitForMarkedConversations`.
 */
export async function markJobConversationsForAbort(host: HarnessHost, jobId: string): Promise<string[]> {
    const ofJob = await closeJobConversations(host, jobId);
    await abortRunningCompactions(host, ofJob);
    await markLiveTasks(host, ofJob);
    return ofJob;
}

/** Waits until the conversations are idle. Call it after `host.resume()`: marked work ends only once scheduling is on. */
export async function waitForMarkedConversations(host: HarnessHost, conversationIds: string[]): Promise<void> {
    for (const id of conversationIds) await (await requireConversation(host, id)).waitForIdle(context);
}
