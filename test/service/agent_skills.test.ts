/**
 * Enabling and disabling a skill for one running agent (S-008 REQ-006, AC-006.1, AC-006.2, AC-006.5): the change applies
 * from the agent's next model request, touches no other agent, resets on a seat change, is refused for a closed or
 * unknown conversation and for a skill the agent's workspace supplies, and is recorded with the team member as actor.
 */
import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { FakeReply, FakeTranscript } from "../support/fake_model.ts";
import { type SkillsRig, startSkillsRig } from "../support/skills_rig.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const CODE_REVIEW = "code-review";
const TEAM_MEMBER = { kind: "team_member", wayIn: "command line" };

const rigs: SkillsRig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
});

const refusal = (code: string, message?: RegExp) => (error: unknown) =>
    error instanceof Error &&
    (error as { code?: string }).code === code &&
    (message === undefined || message.test(error.message));

type Started = { rig: SkillsRig; toolResults: string[]; skillFolder: string };

/** A rig whose model calls `skill` for `code-review` on the user text "use it" and otherwise answers "ok". */
async function start(): Promise<Started> {
    const toolResults: string[] = [];
    const reply = (transcript: FakeTranscript): FakeReply => {
        const last = transcript.at(-1);
        if (last?.role === "toolResult") {
            toolResults.push(last.text);
            return "ok";
        }
        if (last?.text === "use it") return { toolCall: { name: "skill", arguments: { name: CODE_REVIEW } } };
        return "ok";
    };
    const rig = await startSkillsRig({ reply });
    rigs.push(rig);
    const skillFolder = await rig.writeSkill(join(rig.dirs.dataDir, "skills"), CODE_REVIEW, "Review code.");
    return { rig, toolResults, skillFolder };
}

async function until(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await condition())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        await sleep(POLL_MS);
    }
}

async function startJob(rig: SkillsRig, role: string, text: string): Promise<{ id: string; lead: string }> {
    const job = (await rig.invoke("jobs.create", { text, role })) as { id: string; leadConversation: string };
    await until(async () => (await rig.systemPrompts(job.leadConversation)).length > 0, `the first request of ${text}`);
    return { id: job.id, lead: job.leadConversation };
}

async function say(rig: SkillsRig, conversationId: string, content: string): Promise<string> {
    const before = (await rig.systemPrompts(conversationId)).length;
    await rig.invoke("conversations.submit", { conversationId, content, requestId: `request-${content}` });
    await until(async () => (await rig.systemPrompts(conversationId)).length > before, `the request for ${content}`);
    return (await rig.systemPrompts(conversationId)).at(-1) as string;
}

/** The skill names the last skill listing of a request's system text holds: the one the request's own sections made. */
const listedIn = (prompt: string): string[] =>
    [...(prompt.split("<available_skills>").at(-1) ?? "").matchAll(/<name>([^<]*)<\/name>/g)].map(
        (match) => match[1] as string,
    );

const enabledOf = async (rig: SkillsRig, conversation: string): Promise<string[]> =>
    ((await rig.invoke("skills.list", { conversation })) as { skills: { name: string; enabled: boolean }[] }).skills
        .filter((skill) => skill.enabled)
        .map((skill) => skill.name);

describe("skills.enable for one running agent", () => {
    it("lists the skill in that agent's next request, lets skill return its text and leaves another agent alone", async () => {
        const { rig, toolResults } = await start();
        const first = await startJob(rig, "bob", "first job");
        const second = await startJob(rig, "bob", "second job");
        assert.doesNotMatch(await say(rig, first.lead, "before"), /<name>code-review<\/name>/);

        const result = (await rig.invoke("skills.enable", { name: CODE_REVIEW, conversation: first.lead })) as {
            enabledSkills: string[];
        };

        assert.ok(result.enabledSkills.includes(CODE_REVIEW));
        assert.match(await say(rig, first.lead, "after"), /<name>code-review<\/name>/);
        assert.doesNotMatch(await say(rig, second.lead, "after"), /<name>code-review<\/name>/);
        await say(rig, first.lead, "use it");
        await until(() => toolResults.length > 0, "the skill tool result");
        assert.match(toolResults[0] as string, /Body of code-review/);
    });

    it("records the enable in the conversation's entries with the team member as actor", async () => {
        const { rig } = await start();
        const { lead } = await startJob(rig, "bob", "job");

        const { enabledSkills } = (await rig.invoke("skills.enable", { name: CODE_REVIEW, conversation: lead })) as {
            enabledSkills: string[];
        };

        const { entries } = (await rig.invoke("conversations.entries", {
            conversationId: lead,
            limit: 500,
        })) as { entries: { kind: string; data: unknown }[] };
        const recorded = entries.filter((entry) => entry.kind === "intern.skills");
        assert.deepEqual(
            recorded.map((entry) => entry.data),
            [{ actor: TEAM_MEMBER, skill: CODE_REVIEW, change: "enabled", enabledSkills }],
        );
    });

    it("resets the set to the new role's defaults when the agent is handed off to gp", async () => {
        const { rig } = await start();
        const { lead } = await startJob(rig, "bob", "job");
        await rig.invoke("skills.enable", { name: CODE_REVIEW, conversation: lead });
        assert.ok((await enabledOf(rig, lead)).includes(CODE_REVIEW));

        await rig.invoke("conversations.seat", { conversationId: lead, role: "gp" });

        const enabled = await enabledOf(rig, lead);
        assert.ok(enabled.includes("carry-out-a-part"));
        assert.ok(!enabled.includes(CODE_REVIEW));
    });

    it("refuses a name the agent's catalog doesn't hold, and an unknown conversation, as not found", async () => {
        const { rig } = await start();
        const { lead } = await startJob(rig, "bob", "job");

        await assert.rejects(
            rig.invoke("skills.enable", { name: "no-such-skill", conversation: lead }),
            refusal("not_found"),
        );
        await assert.rejects(
            rig.invoke("skills.enable", { name: CODE_REVIEW, conversation: "0" }),
            refusal("not_found"),
        );
        await assert.rejects(
            rig.invoke("skills.disable", { name: CODE_REVIEW, conversation: "0" }),
            refusal("not_found"),
        );
    });

    it("refuses with conflict naming the conversation as closed once its job is done", async () => {
        const { rig } = await start();
        const { id, lead } = await startJob(rig, "bob", "job");
        await rig.invoke("jobs.update", { job: id, definitionOfDone: "The work is done." });
        await rig.invoke("jobs.complete", { job: id, justification: "Finished." });

        await assert.rejects(
            rig.invoke("skills.enable", { name: CODE_REVIEW, conversation: lead }),
            refusal("conflict", /closed/),
        );
        await assert.rejects(
            rig.invoke("skills.disable", { name: "carry-out-a-part", conversation: lead }),
            refusal("conflict", /closed/),
        );
    });

    it("refuses a call that names both a role and a conversation, or neither", async () => {
        const { rig } = await start();
        const { lead } = await startJob(rig, "bob", "job");

        await assert.rejects(
            rig.invoke("skills.enable", { name: CODE_REVIEW, role: "bob", conversation: lead }),
            refusal("invalid_input"),
        );
        await assert.rejects(rig.invoke("skills.enable", { name: CODE_REVIEW }), refusal("invalid_input"));
    });
});

describe("skills.disable for one running agent", () => {
    it("removes a skill from that agent's set and lists it no more", async () => {
        const { rig } = await start();
        const { lead } = await startJob(rig, "gp", "job");
        await rig.invoke("skills.enable", { name: CODE_REVIEW, conversation: lead });
        assert.deepEqual(listedIn(await say(rig, lead, "before")), ["carry-out-a-part", CODE_REVIEW]);

        const result = (await rig.invoke("skills.disable", { name: "carry-out-a-part", conversation: lead })) as {
            enabledSkills: string[];
        };

        assert.deepEqual(result.enabledSkills, ["bob-command-line", CODE_REVIEW]);
        assert.deepEqual(listedIn(await say(rig, lead, "after")), [CODE_REVIEW]);
    });

    it("refuses a skill the agent's workspace supplies as invalid input", async () => {
        const { rig } = await start();
        const { lead } = await startJob(rig, "gp", "job");
        const workspace = join(rig.dirs.dataDir, "workspaces", "gp");
        await rig.writeSkill(join(workspace, ".pi", "skills"), "lint", "Lint the code.");

        await assert.rejects(
            rig.invoke("skills.disable", { name: "lint", conversation: lead }),
            refusal("invalid_input"),
        );
    });

    it("allows disabling a name in the set that the catalog no longer holds", async () => {
        const { rig, skillFolder } = await start();
        const { lead } = await startJob(rig, "bob", "job");
        await rig.invoke("skills.enable", { name: CODE_REVIEW, conversation: lead });
        await rm(skillFolder, { recursive: true });

        const result = (await rig.invoke("skills.disable", { name: CODE_REVIEW, conversation: lead })) as {
            enabledSkills: string[];
        };

        assert.ok(!result.enabledSkills.includes(CODE_REVIEW));
    });
});
