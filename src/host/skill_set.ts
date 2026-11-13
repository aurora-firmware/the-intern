/**
 * The enabled set of one agent (S-008 REQ-006; ADR-001 decision 4): the only path that enables or disables a skill
 * for a conversation. The document's set and the `intern.skills` entry that records the change are written in one
 * commit. The entry carries no model message, so it is no part of the model's context and no input entry.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineEntry } from "@earendil-works/pi-durable";
import { toConversationId } from "./conversation_id.ts";
import { type HarnessHost, internalHarness } from "./harness_host.ts";
import { inOpenConversation } from "./job_section.ts";
import { conversationMetaDoc, type SeatActor, SeatingError } from "./seating.ts";

export const SKILLS_RECORD_KIND = "intern.skills";

export type SkillsRecord = {
    actor: SeatActor;
    skill: string;
    change: "enabled" | "disabled";
    enabledSkills: string[];
};
export type SkillChange = { name: string; enable: boolean; actor: SeatActor };

const context = BACKGROUND_CONTEXT;
const skillsRecordEntry = defineEntry<SkillsRecord>(SKILLS_RECORD_KIND);

/**
 * Enables or disables the skill for the conversation and returns the new set. A name already in the set to enable,
 * or not in it to disable, commits nothing and returns the set. A document with no set reads as `defaultsOf(role)`
 * until this write. A closed conversation is refused with `ConversationClosedError`.
 */
export async function setEnabledSkill(
    host: HarnessHost,
    conversationId: string,
    change: SkillChange,
    defaultsOf: (role: string) => string[],
): Promise<string[]> {
    const id = toConversationId(conversationId);
    return inOpenConversation(host, conversationId, () =>
        internalHarness(host).commit(async (tx) => {
            const meta = await tx.doc(conversationMetaDoc, id);
            if (meta.jobId === "") {
                throw new SeatingError(`Conversation "${conversationId}" was not created by createSeatedConversation.`);
            }
            const current = meta.enabledSkills ?? defaultsOf(meta.seat.role);
            if (current.includes(change.name) === change.enable) return [...current];
            const next = change.enable ? [...current, change.name] : current.filter((name) => name !== change.name);
            meta.enabledSkills = next;
            const record: SkillsRecord = {
                actor: change.actor,
                skill: change.name,
                change: change.enable ? "enabled" : "disabled",
                enabledSkills: next,
            };
            await tx.appendEntry(skillsRecordEntry, id, { data: JSON.parse(JSON.stringify(record)) as never });
            return [...next];
        }, context),
    );
}
