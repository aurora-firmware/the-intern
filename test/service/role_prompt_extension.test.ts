import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, openHarnessHost } from "../../src/host/harness_host.ts";
import { changeSeat, createSeatedConversation, type JobLinks, type SeatActor } from "../../src/host/seating.ts";
import { createRolePromptExtension, ROLE_PROMPT_EXTENSION_NAME } from "../../src/prompt/role_prompt_extension.ts";
import { createWorkspaceContextLoader } from "../../src/prompt/workspace_context.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 10_000;
const PREAMBLE = "PREAMBLE-TEXT";
const job: JobLinks = { jobId: "job-1", isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 };
const actor: SeatActor = { kind: "team_member", wayIn: "cli" };

const fakes: FauxProviderRegistration[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

// The fake model's transcript drops system messages. pi-durable sends the sections of the first system message whole
// and later ones as replacements by name, with null removing a section; the prompt in effect is the fold of them.
function systemTextOf(context: { messages: readonly object[] }): string {
    const inEffect = new Map<string, string>();
    for (const message of context.messages) {
        if (!("role" in message) || message.role !== "system") continue;
        const changes = (message as { sections?: Record<string, string | null> }).sections ?? {};
        for (const [key, text] of Object.entries(changes)) {
            if (text === null) inEffect.delete(key);
            else inEffect.set(key, text);
        }
    }
    return JSON.stringify([...inEffect]);
}

async function writeSkill(folder: string, name: string): Promise<string> {
    const dir = join(folder, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: Skill called ${name}.\n---\n\nBody of ${name}.\n`,
    );
    return dir;
}

async function writeWorkspace(root: string, name: string): Promise<string> {
    const workspace = join(root, name);
    await mkdir(workspace, { recursive: true });
    await writeFile(join(workspace, "AGENTS.md"), `Context of ${name}.\n`);
    await writeSkill(join(workspace, ".pi", "skills"), `${name}-skill`);
    return workspace;
}

async function createFixture() {
    const env = await createHermeticEnv();
    envs.push(env);
    const prompts: string[] = [];
    const fake = registerFauxProvider();
    const answer: FauxResponseFactory = async (context) => {
        fake.appendResponses([answer]);
        prompts.push(systemTextOf(context));
        return fauxAssistantMessage("ok");
    };
    fake.setResponses([answer]);
    fakes.push(fake);
    const implementation = getApiProvider(fake.api);
    assert.ok(implementation);
    const models = createModels();
    models.setProvider(
        createProvider({
            id: fake.getModel().provider,
            auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
            models: fake.models,
            api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
        }),
    );
    const logger = createLogger({ stream: { write: () => true } });
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models,
        harnessSettings: {},
        extensions: [
            createRolePromptExtension({ preamble: PREAMBLE, loader: createWorkspaceContextLoader({ logger }) }),
        ],
        defaultCwd: process.cwd(),
        logger,
    });
    hosts.push(host);
    const seatFor = async (role: string, overrides: Partial<Seat> = {}): Promise<Seat> => ({
        role,
        model: `${fake.getModel().provider}/${fake.getModel().id}`,
        workspace: await writeWorkspace(env.root, `ws-${role}`),
        instructions: `Instructions of ${role}.`,
        tools: [],
        skills: [await writeSkill(join(env.root, "role-skills"), `${role}-role-skill`)],
        ...overrides,
    });
    let turn = 0;
    const say = async (conversationId: string): Promise<void> => {
        turn += 1;
        const submission = await submitInput(host, conversationId, {
            content: `turn ${turn}`,
            requestId: `r${turn}`,
            busyMode: "reject",
        });
        await waitForSubmission(host, submission.submissionId, WAIT_MS);
    };
    const seatConversation = async (seat: Seat) =>
        (await createSeatedConversation(host, { scope: "start-job", key: "k1", job, seat, actor })).conversationId;
    return { host, prompts, seatFor, say, seatConversation };
}

describe("the role prompt extension", () => {
    it("is named intern.role-prompt", () => {
        assert.equal(ROLE_PROMPT_EXTENSION_NAME, "intern.role-prompt");
    });

    it("sends the same system prompt on two consecutive turns while the seat is unchanged", async () => {
        const { prompts, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));

        await say(id);
        await say(id);

        assert.equal(prompts.length, 2);
        assert.match(prompts[0], /Instructions of developer\./);
        assert.equal(prompts[1], prompts[0]);
    });

    it("sends the preamble before the role instructions", async () => {
        const { prompts, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));

        await say(id);

        assert.ok(prompts[0].indexOf(PREAMBLE) >= 0);
        assert.ok(prompts[0].indexOf(PREAMBLE) < prompts[0].indexOf("Instructions of developer."));
    });

    it("sends the new role and workspace and nothing of the previous seat after a seat change", async () => {
        const { host, prompts, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));
        await say(id);

        await changeSeat(host, id, { seat: await seatFor("reviewer"), actor });
        await say(id);

        const afterChange = prompts[1];
        for (const expected of [
            "Instructions of reviewer.",
            "reviewer-role-skill",
            "Context of ws-reviewer",
            "ws-reviewer-skill",
        ]) {
            assert.ok(afterChange.includes(expected), `${expected} is sent`);
        }
        for (const gone of [
            "Instructions of developer.",
            "developer-role-skill",
            "Context of ws-developer",
            "ws-developer-skill",
        ]) {
            assert.equal(afterChange.includes(gone), false, `${gone} is not sent`);
        }
    });

    it("sends only the preamble to a conversation that has no seat document", async () => {
        const { host, prompts, seatFor, say } = await createFixture();
        const seat = await seatFor("developer");

        const id = await host.createConversation({ agent: { model: seat.model, cwd: seat.workspace } });
        await say(id);

        assert.deepEqual(JSON.parse(prompts[0]), [
            ["intern-preamble", `<intern-preamble>\n${PREAMBLE}\n</intern-preamble>`],
        ]);
    });

    it("keeps sending the instructions the agent was seated with when the team role changes later", async () => {
        const { prompts, seatFor, say, seatConversation } = await createFixture();
        const role = { instructions: "Original instructions." };
        const id = await seatConversation(await seatFor("developer", { instructions: role.instructions }));
        await say(id);

        role.instructions = "Edited instructions.";
        await say(id);

        assert.match(prompts[1], /Original instructions\./);
        assert.equal(prompts[1].includes("Edited instructions."), false);
    });
});
