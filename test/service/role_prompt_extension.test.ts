import assert from "node:assert/strict";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type FauxProviderRegistration, type FauxResponseFactory, fauxAssistantMessage } from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createLogger, type LogFields } from "../../src/daemon/logger.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { type HarnessHost, openHarnessHost } from "../../src/host/harness_host.ts";
import { changeSeat, createSeatedConversation, type JobLinks, type SeatActor } from "../../src/host/seating.ts";
import { createRolePromptExtension, ROLE_PROMPT_EXTENSION_NAME } from "../../src/prompt/role_prompt_extension.ts";
import type { Seat } from "../../src/roles/role_model.ts";
import { commonPromptPath, roleInstructionPath } from "../../src/skills/internal_folder.ts";
import { createDiagnosticLog, type DiagnosticLog } from "../../src/skills/skill_discovery.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(10_000);
const COMMON = "COMMON-TEXT";
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
    const dataDir = join(env.root, "data");
    await mkdir(join(dataDir, "instructions", "roles"), { recursive: true });
    await writeFile(commonPromptPath(dataDir), COMMON);
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
    const logged: { message: string; fields: LogFields | undefined }[] = [];
    const logger = createLogger({ stream: { write: () => true } });
    const recordingLogger = {
        ...logger,
        error: (message: string, fields?: LogFields) => logged.push({ message, fields }),
    };
    const diagnostics = createDiagnosticLog(recordingLogger);
    const reports: (readonly string[])[] = [];
    const countingDiagnostics: DiagnosticLog = {
        report(list) {
            reports.push(list);
            diagnostics.report(list);
        },
    };
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models,
        harnessSettings: {},
        extensions: [
            createRolePromptExtension({
                dataDir: () => dataDir,
                searchPaths: () => [],
                defaultsOf: () => new Set(),
                diagnostics: countingDiagnostics,
            }),
        ],
        defaultCwd: process.cwd(),
        logger,
    });
    hosts.push(host);
    const model = `${fake.getModel().provider}/${fake.getModel().id}`;
    const seatFor = async (role: string, overrides: Partial<Seat> = {}): Promise<Seat> => {
        await writeFile(roleInstructionPath(dataDir, role), `Instructions of ${role}.`);
        await writeSkill(join(dataDir, "skills"), `${role}-role-skill`);
        return {
            role,
            model,
            workspace: await writeWorkspace(env.root, `ws-${role}`),
            instructions: "",
            tools: [],
            skills: [`${role}-role-skill`],
            ...overrides,
        };
    };
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
    return { host, prompts, logged, reports, dataDir, model, seatFor, say, seatConversation };
}

describe("the role prompt extension", () => {
    it("is named intern.role-prompt", () => {
        assert.equal(ROLE_PROMPT_EXTENSION_NAME, "intern.role-prompt");
    });

    it("sends byte-identical system prompts while no instruction file, enabled set or skill folder changes", async () => {
        const { prompts, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));

        await say(id);
        await say(id);
        await say(id);

        assert.equal(prompts.length, 3);
        assert.match(prompts[0], /Instructions of developer\./);
        assert.equal(prompts[1], prompts[0]);
        assert.equal(prompts[2], prompts[0]);
    });

    it("sends the common prompt before the role instructions", async () => {
        const { prompts, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));

        await say(id);

        assert.ok(prompts[0].indexOf(COMMON) >= 0);
        assert.ok(prompts[0].indexOf(COMMON) < prompts[0].indexOf("Instructions of developer."));
    });

    it("sends the edited common prompt in the next request without a seat change", async () => {
        const { prompts, dataDir, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));
        await say(id);

        await writeFile(commonPromptPath(dataDir), "EDITED-COMMON");
        await say(id);

        assert.match(prompts[0], new RegExp(COMMON));
        assert.match(prompts[1], /EDITED-COMMON/);
        assert.equal(prompts[1].includes(COMMON), false);
    });

    it("sends the edited role file in the next request without a seat change", async () => {
        const { prompts, dataDir, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));
        await say(id);

        await writeFile(roleInstructionPath(dataDir, "developer"), "Edited instructions.");
        await say(id);

        assert.match(prompts[1], /Edited instructions\./);
        assert.equal(prompts[1].includes("Instructions of developer."), false);
    });

    it("lists the skills the agent enables and leaves out a skill in the catalog that it doesn't", async () => {
        const { prompts, dataDir, seatFor, say, seatConversation } = await createFixture();
        await writeSkill(join(dataDir, "skills"), "unused-skill");
        const id = await seatConversation(await seatFor("developer"));

        await say(id);

        assert.match(prompts[0], /developer-role-skill/);
        assert.equal(prompts[0].includes("unused-skill"), false);
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

    it("sends only the common prompt to a conversation that has no seat document", async () => {
        const { host, prompts, seatFor, say } = await createFixture();
        const seat = await seatFor("developer");

        const id = await host.createConversation({ agent: { model: seat.model, cwd: seat.workspace } });
        await say(id);

        assert.deepEqual(JSON.parse(prompts[0]), [["intern-common", `<intern-common>\n${COMMON}\n</intern-common>`]]);
    });

    it("leaves out a missing common prompt, logs one diagnostic and still answers", async () => {
        const { prompts, logged, dataDir, seatFor, say, seatConversation } = await createFixture();
        await rm(commonPromptPath(dataDir));
        const id = await seatConversation(await seatFor("developer"));

        await say(id);
        await say(id);

        assert.equal(prompts.length, 2);
        assert.equal(prompts[0].includes("intern-common"), false);
        assert.match(prompts[0], /Instructions of developer\./);
        assert.equal(logged.length, 1);
        assert.match(logged[0].message, /common\.md/);
    });

    it("reads the parts once for the sections of one request", async () => {
        const { reports, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));

        await say(id);

        assert.equal(reports.length, 1);
    });

    it("reads the parts again for the next request", async () => {
        const { reports, seatFor, say, seatConversation } = await createFixture();
        const id = await seatConversation(await seatFor("developer"));

        await say(id);
        await say(id);

        assert.equal(reports.length, 2);
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
