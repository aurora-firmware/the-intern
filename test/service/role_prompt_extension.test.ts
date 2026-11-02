import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { loadConfig } from "../../src/config/config_file.ts";
import { createConfigStore } from "../../src/config/config_writer.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, openHarnessHost } from "../../src/host/harness_host.ts";
import { changeSeat, createSeatedConversation, type JobLinks, type SeatActor } from "../../src/host/seating.ts";
import { createRolePromptExtension, ROLE_PROMPT_EXTENSION_NAME } from "../../src/prompt/role_prompt_extension.ts";
import { createWorkspaceContextLoader } from "../../src/prompt/workspace_context.ts";
import { createRoleCatalog } from "../../src/roles/role_catalog.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { rolesSection, workspacesSection } from "../../src/roles/roles_section.ts";
import { createWorkspaceRegistry } from "../../src/workspaces/workspace_registry.ts";
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

// The team's role catalog, stored in a configuration file, with the fake model as pi agent's default model.
async function createCatalog(root: string, model: string) {
    const file = join(root, "config.toml");
    const dataDir = join(root, "catalog-data");
    await mkdir(dataDir, { mode: 0o700 });
    const sections = [rolesSection, workspacesSection];
    const config = createConfigStore(file, sections, await loadConfig(file, sections));
    const workspaces = createWorkspaceRegistry({
        config,
        dataDir,
        account: { uid: process.getuid?.() ?? 0 },
        defaultWorkspaceUsers: () => [],
    });
    const catalog = createRoleCatalog({
        config,
        shipped: [],
        workspaces,
        dataDir,
        models: { checkModelChoice: () => ({ ok: true }), defaultChoice: () => ({ model }) },
    });
    const registerWorkspace = async (name: string): Promise<string> => {
        const workspace = await writeWorkspace(root, name);
        // A workspace is registered only when no one but the service account can reach it.
        await chmod(workspace, 0o700);
        await workspaces.register(workspace);
        return workspace;
    };
    return Object.assign(catalog, { registerWorkspace });
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
    const realLoader = createWorkspaceContextLoader({ logger });
    const loadedSeats: Seat[] = [];
    const recordingLoader = {
        load(seat: Seat) {
            loadedSeats.push(seat);
            return realLoader.load(seat);
        },
    };
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models,
        harnessSettings: {},
        extensions: [createRolePromptExtension({ preamble: PREAMBLE, loader: recordingLoader })],
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
    const seatConversation = async (seat: Seat, key = "k1", links: JobLinks = job) =>
        (await createSeatedConversation(host, { scope: "start-job", key, job: links, seat, actor })).conversationId;
    const model = `${fake.getModel().provider}/${fake.getModel().id}`;
    return { host, prompts, loadedSeats, model, root: env.root, seatFor, say, seatConversation };
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

    it("keeps sending the instructions and skills the agent was seated with when the team role changes later", async () => {
        const { prompts, model, root, say, seatConversation } = await createFixture();
        const catalog = await createCatalog(root, model);
        await catalog.create({
            name: "developer",
            instructions: "Instructions of developer.",
            tools: [],
            skills: [await writeSkill(join(root, "role-skills"), "developer-role-skill")],
            workspace: await catalog.registerWorkspace("ws-developer"),
        });
        const seatedId = await seatConversation(catalog.seatFor("developer"), "seated-before");
        await say(seatedId);

        await catalog.change("developer", {
            instructions: "Edited instructions.",
            skills: [await writeSkill(join(root, "role-skills"), "edited-role-skill")],
        });
        await say(seatedId);
        const seatedAfterId = await seatConversation(catalog.seatFor("developer"), "seated-after");
        await say(seatedAfterId);

        const [, seatedPrompt, newcomerPrompt] = prompts;
        // An agent seated after the change gets the edited role, so the change reached the running system.
        assert.match(newcomerPrompt, /Edited instructions\./);
        assert.match(newcomerPrompt, /edited-role-skill/);
        assert.match(seatedPrompt, /Instructions of developer\./);
        assert.match(seatedPrompt, /developer-role-skill/);
        assert.equal(seatedPrompt.includes("Edited instructions."), false);
        assert.equal(seatedPrompt.includes("edited-role-skill"), false);
    });

    it("loads the seat's workspace once for the sections of one request", async () => {
        const { loadedSeats, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));

        await say(id);

        assert.equal(loadedSeats.length, 1);
    });

    it("loads the seat's workspace again for the next request", async () => {
        const { loadedSeats, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));

        await say(id);
        await say(id);

        assert.equal(loadedSeats.length, 2);
    });

    it("sends the lead duty to a lead whatever role is seated, and keeps it after a reseat", async () => {
        const { host, prompts, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));
        await say(id);

        await changeSeat(host, id, { seat: await seatFor("reviewer"), actor });
        await say(id);

        assert.match(prompts[0], /intern-lead-duty/);
        assert.match(prompts[0], /definition of done/);
        assert.match(prompts[1], /intern-lead-duty/);
        assert.match(prompts[1], /Instructions of reviewer\./);
    });

    it("leaves the lead duty out of an invoked conversation", async () => {
        const { prompts, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"), "invoked", { ...job, isLead: false, depth: 1 });

        await say(id);

        assert.match(prompts[0], /Instructions of developer\./);
        assert.equal(prompts[0].includes("intern-lead-duty"), false);
    });
});
