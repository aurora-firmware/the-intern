/**
 * The release of a conversation that waited for a model (ADR-014 decision 4): a run that starts with no new input and
 * continues from the transcript, which already holds the input a `no_model` run placed.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { GenerationTask, LiveDoc } from "@earendil-works/pi-durable";
import { toConversationId } from "./conversation_id.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";

const context = BACKGROUND_CONTEXT;

/**
 * Starts a run for the conversation with no input, in one host commit. Returns `false` and changes nothing when a run
 * is already active. It copies `startRun` of pi-durable 1.4.0 (`harness/generation.js`): a `pi.generation` task owned
 * by the conversation, taken as `pi.live.run` with no inputs (it leaves out the `submissionIds` telemetry, which has
 * nothing to list). It is written against that version, and each pi-durable
 * upgrade rechecks it (ADR-014 Consequences). When pi-durable offers a run start without input, use that instead.
 */
export async function startRunWithoutInput(host: HarnessHost, conversationId: string): Promise<boolean> {
    const id = toConversationId(conversationId);
    return internalHarness(host).commit(async (tx) => {
        const live = await tx.doc(LiveDoc, id);
        if (live.run !== undefined) return false;
        const taskId = await tx.createTask(
            GenerationTask,
            {},
            { ownership: { kind: "conversation" }, conversationId: id },
        );
        live.run = { taskId, inputs: [] };
        return true;
    }, context);
}
