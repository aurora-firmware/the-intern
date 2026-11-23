/**
 * The messages the Front desk page sent (S-006 REQ-008). A stop drops the messages still queued; the page names the
 * ones it sent and still holds, reading each one's state from `submissions.get`.
 */
export type SentMessage = { submissionId: string; text: string };

/** The state `submissions.get` gives: `queued`, `running`, `done` or `unanswered`. */
export type SubmissionStates = ReadonlyMap<string, string>;

/**
 * The sent messages that were queued before the stop and have no answer after it. The message the front desk was
 * answering also ends unanswered, but it was not queued: the stop ended it, and the page doesn't call it dropped.
 */
export const droppedMessages = (
    sent: readonly SentMessage[],
    before: SubmissionStates,
    after: SubmissionStates,
): SentMessage[] =>
    sent.filter(
        (message) => before.get(message.submissionId) === "queued" && after.get(message.submissionId) === "unanswered",
    );

/** The sent messages not settled yet: still queued or running, or whose state isn't known. */
export const unsettledMessages = (sent: readonly SentMessage[], states: SubmissionStates): SentMessage[] =>
    sent.filter((message) => {
        const state = states.get(message.submissionId);
        return state !== "done" && state !== "unanswered";
    });
