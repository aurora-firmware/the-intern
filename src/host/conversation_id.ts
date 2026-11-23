/**
 * The one reading of a conversation id from text. An id is the digits of a pi-durable conversation id with no leading
 * zero, which is how the product writes every id it hands out. Any other spelling of the number ("07", "7.0") names no
 * conversation, so a comparison of two id strings, a lookup keyed by one and the conversation it resolves to always
 * agree.
 */
import type { ConversationId } from "@earendil-works/pi-durable";

/** The conversation id the text spells, or `undefined` when the text is not the canonical spelling of one. */
export function parseConversationId(text: string): ConversationId | undefined {
    if (!/^\d+$/.test(text)) return undefined;
    const id = Number(text);
    return String(id) === text ? (id as ConversationId) : undefined;
}

/** For an id the product wrote itself: a text that is not a canonical id here is a defect, not missing input. */
export function toConversationId(text: string): ConversationId {
    const id = parseConversationId(text);
    if (id === undefined) throw new Error(`"${text}" is not a conversation id`);
    return id;
}
