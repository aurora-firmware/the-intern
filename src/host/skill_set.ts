/**
 * The enabled set of one agent (S-008 REQ-006; ADR-001 decision 4): the only path that enables or disables a skill
 * for a conversation. The document's set and the `intern.skills` entry that records the change are written in one
 * commit. The entry carries no model message, so it is no part of the model's context and no input entry.
 */
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { AgentDoc, configure, defineDoc, defineEntry } from "@earendil-works/pi-durable";
import { SKILL_TOOL_NAME } from "../roles/role_model.ts";
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

export const UPGRADES_KIND = "intern.upgrades";
export const ENABLED_SKILLS_UPGRADE = "enabled-skills";

// A daemon document (S-002 Definitions, "Database"): the upgrade writes that have finished.
export const upgradesDocument = defineDoc<{ done: string[] }>({
    kind: UPGRADES_KIND,
    version: 1,
    scope: "session",
    initial: () => ({ done: [] }),
    checkpointWhen: () => false,
});

/**
 * ADR-001 decision 4's one upgrade write. Each conversation whose document has no `enabledSkills` gets, in one commit
 * of its own, `defaultsOf(role)` and the `skill` tool in its stored seat and in its agent's tool selection; then
 * `enabled-skills` joins `intern.upgrades`. A run that stops before that record repeats the write only for the
 * documents still without the field. It delivers no input and appends no entry.
 */
export async function upgradeEnabledSkills(host: HarnessHost, defaultsOf: (role: string) => string[]): Promise<void> {
    const harness = internalHarness(host);
    const stored = await harness.snapshot(upgradesDocument, context);
    if (stored?.done.includes(ENABLED_SKILLS_UPGRADE)) return;
    for (const { id } of await host.listConversations()) {
        await harness.commit(async (tx) => {
            const meta = await tx.doc(conversationMetaDoc, toConversationId(id));
            if (meta.jobId === "" || meta.enabledSkills !== undefined) return;
            meta.enabledSkills = [...defaultsOf(meta.seat.role)];
            if (!meta.seat.tools.includes(SKILL_TOOL_NAME)) meta.seat.tools.push(SKILL_TOOL_NAME);
            const tools = (await tx.doc(AgentDoc, toConversationId(id))).tools;
            // An unset selection already enables every tool, and a `remove` selection never held `skill` back.
            if (Array.isArray(tools) && !tools.includes(SKILL_TOOL_NAME)) {
                await configure(tx, toConversationId(id), {
                    tools: [...tools, SKILL_TOOL_NAME].map((name) => ({ name }) as never),
                });
            }
        }, context);
    }
    await harness.commit(async (tx) => {
        const done = (await tx.doc(upgradesDocument)).done;
        if (!done.includes(ENABLED_SKILLS_UPGRADE)) done.push(ENABLED_SKILLS_UPGRADE);
    }, context);
}
