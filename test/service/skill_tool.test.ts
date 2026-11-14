/**
 * The `skill` tool (S-008 REQ-008, REQ-016): an agent loads the text of a skill enabled for it, or a file the skill
 * bundles, and a call that leaves the skill's folder or names a skill that isn't enabled is refused.
 */
import assert from "node:assert/strict";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { STOP_BOUND_MS } from "../../src/daemon/constants.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createDeskComponent } from "../../src/desk/desk_component.ts";
import { submitInput, waitForSubmission } from "../../src/host/conversation_control.ts";
import { toConversationId } from "../../src/host/conversation_id.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import {
    conversationMetaDoc,
    createSeatedConversation,
    type JobLinks,
    type SeatActor,
} from "../../src/host/seating.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { DEFAULT_SHIPPED_ROOT } from "../../src/skills/internal_folder.ts";
import { readCatalog } from "../../src/skills/skill_discovery.ts";
import {
    createSkillToolExtension,
    SKILL_TOOL_EXTENSION_NAME,
    SKILL_TOOL_NAME,
} from "../../src/skills/skill_tool_extension.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 10_000;
const MAX_LINES = 2000;
const MAX_BYTES = 50 * 1024;
const job: JobLinks = { jobId: "job-1", isLead: true, origin: { kind: "request", wayIn: "cli" }, depth: 0 };
const actor: SeatActor = { kind: "team_member", wayIn: "cli" };

type ToolResultSeen = { text: string; isError: boolean };
type ModelContext = Parameters<FauxResponseFactory>[0];

const fakes: FauxProviderRegistration[] = [];
const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];
const daemons: RunningDaemon[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        await Promise.race([daemon.stop(), new Promise((resolve) => setTimeout(resolve, STOP_BOUND_MS))]);
    }
    for (const host of hosts.splice(0)) await host.close();
    for (const fake of fakes.splice(0)) fake.unregister();
    for (const env of envs.splice(0)) await env.dispose();
});

const lastResultOf = (context: ModelContext): ToolResultSeen | undefined =>
    context.messages
        .flatMap((message) =>
            message.role === "toolResult"
                ? [
                      {
                          text: message.content.map((block) => (block.type === "text" ? block.text : "")).join(""),
                          isError: message.isError,
                      },
                  ]
                : [],
        )
        .at(-1);

const resultOf = (recorded: { result?: ToolResultSeen }): ToolResultSeen | undefined => recorded.result;

async function writeSkill(folder: string, name: string, body = `Body of ${name}.\n`): Promise<string> {
    const dir = join(folder, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: Skill called ${name}.\n---\n\n${body}`);
    return dir;
}

// The fake model makes the one call it is given and records the result the next request carries.
async function createFixture() {
    const env = await createHermeticEnv();
    envs.push(env);
    const skills = join(env.root, "skills");
    const workspace = join(env.root, "workspace");
    await mkdir(workspace);
    let call: { name: string; file?: string } | undefined;
    const recorded: { result?: ToolResultSeen } = {};
    const fake = registerFauxProvider();
    const respond: FauxResponseFactory = async () => {
        fake.appendResponses([respond]);
        if (call === undefined) return fauxAssistantMessage("idle");
        const made = call;
        call = undefined;
        return fauxAssistantMessage([fauxToolCall(SKILL_TOOL_NAME, made as never)], { stopReason: "toolUse" });
    };
    const answerAfterResult: FauxResponseFactory = async (context) => {
        fake.appendResponses([answerAfterResult]);
        recorded.result = lastResultOf(context);
        return fauxAssistantMessage("noted");
    };
    fake.setResponses([respond]);
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
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models,
        harnessSettings: {},
        extensions: [
            createSkillToolExtension({
                defaultsOf: (role) => new Set(role === "older" ? ["older-default"] : []),
                catalogFor: (path) =>
                    readCatalog({
                        dataDir: join(env.root, "data"),
                        shippedRoot: DEFAULT_SHIPPED_ROOT,
                        searchPaths: [skills],
                        workspace: path,
                    }),
            }),
        ],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
    const model = `${fake.getModel().provider}/${fake.getModel().id}`;
    const seatWith = async (enabled: string[], role = "gp") =>
        (
            await createSeatedConversation(host, {
                scope: "s",
                key: `k${role}${enabled.join()}`,
                job,
                seat: { role, model, workspace, tools: [SKILL_TOOL_NAME], skills: enabled },
                actor,
            })
        ).conversationId;
    // A document written before the enabled set has none.
    const dropEnabledSet = (conversationId: string) =>
        internalHarness(host).commit(async (tx) => {
            const meta = await tx.doc(conversationMetaDoc, toConversationId(conversationId));
            delete meta.enabledSkills;
        }, BACKGROUND_CONTEXT);
    let turn = 0;
    // One run: the model calls the tool once, then answers; the result is what the model saw after the call.
    const callSkill = async (conversationId: string, input: { name: string; file?: string }) => {
        call = input;
        recorded.result = undefined;
        fake.setResponses([respond, answerAfterResult]);
        turn += 1;
        const submission = await submitInput(host, conversationId, {
            content: `turn ${turn}`,
            requestId: `r${turn}`,
            busyMode: "reject",
        });
        const settled = await waitForSubmission(host, submission.submissionId, WAIT_MS);
        assert.equal(settled.state, "done");
        const result = resultOf(recorded);
        assert.ok(result, "the model saw a tool result");
        return result;
    };
    return { env, skills, workspace, seatWith, callSkill, dropEnabledSet };
}

describe("the skill tool extension", () => {
    it("is named intern.skill-tool and brings exactly the skill tool", () => {
        const extension = createSkillToolExtension({
            catalogFor: async () => ({}) as never,
            defaultsOf: () => new Set(),
        });

        assert.equal(SKILL_TOOL_EXTENSION_NAME, "intern.skill-tool");
        assert.equal(extension.name, SKILL_TOOL_EXTENSION_NAME);
        assert.deepEqual(
            extension.tools?.map((tool) => tool.name),
            [SKILL_TOOL_NAME],
        );
        assert.equal(SKILL_TOOL_NAME, "skill");
    });

    it("returns SKILL.md with its frontmatter for an enabled skill", async () => {
        const { skills, seatWith, callSkill } = await createFixture();
        await writeSkill(skills, "about-the-intern", "How the intern works.\n");
        const id = await seatWith(["about-the-intern"]);

        const result = await callSkill(id, { name: "about-the-intern" });

        assert.equal(result.isError, false);
        assert.match(result.text, /^---\nname: about-the-intern\ndescription: Skill called about-the-intern\.\n---/);
        assert.match(result.text, /How the intern works\./);
    });

    it("returns a file the skill bundles, relative to its folder", async () => {
        const { skills, seatWith, callSkill } = await createFixture();
        const folder = await writeSkill(skills, "bundled");
        await mkdir(join(folder, "scripts"));
        await writeFile(join(folder, "scripts", "run.sh"), "echo bundled\n");
        const id = await seatWith(["bundled"]);

        const result = await callSkill(id, { name: "bundled", file: "scripts/run.sh" });

        assert.equal(result.isError, false);
        assert.equal(result.text, "echo bundled\n");
    });

    it("reads a document with no enabled set as the role's default skills, as the prompt does", async () => {
        const { skills, seatWith, callSkill, dropEnabledSet } = await createFixture();
        await writeSkill(skills, "older-default", "DEFAULT-BODY\n");
        const id = await seatWith([], "older");
        await dropEnabledSet(id);

        const result = await callSkill(id, { name: "older-default" });

        assert.equal(result.isError, false);
        assert.match(result.text, /DEFAULT-BODY/);
    });

    it("refuses a skill that is not enabled for the agent, naming it and returning no file text", async () => {
        const { skills, seatWith, callSkill } = await createFixture();
        await writeSkill(skills, "secret", "SECRET-BODY\n");
        const id = await seatWith([]);

        const result = await callSkill(id, { name: "secret" });

        assert.equal(result.isError, true);
        assert.match(result.text, /secret/);
        assert.match(result.text, /not enabled/);
        assert.doesNotMatch(result.text, /SECRET-BODY/);
    });

    it("refuses a file that leaves the skill's folder, absolute or by `..`", async () => {
        const { skills, seatWith, callSkill } = await createFixture();
        await writeSkill(skills, "plain");
        await mkdir(join(skills, "instructions"));
        await writeFile(join(skills, "instructions", "common.md"), "OUTSIDE-TEXT\n");
        const id = await seatWith(["plain"]);

        const climbing = await callSkill(id, { name: "plain", file: "../instructions/common.md" });
        const absolute = await callSkill(id, { name: "plain", file: join(skills, "instructions", "common.md") });

        for (const result of [climbing, absolute]) {
            assert.equal(result.isError, true);
            assert.match(result.text, /inside the skill's folder/);
            assert.doesNotMatch(result.text, /OUTSIDE-TEXT/);
        }
    });

    it("refuses a missing file and a folder", async () => {
        const { skills, seatWith, callSkill } = await createFixture();
        const folder = await writeSkill(skills, "plain");
        await mkdir(join(folder, "scripts"));
        const id = await seatWith(["plain"]);

        const missing = await callSkill(id, { name: "plain", file: "nothing.md" });
        const directory = await callSkill(id, { name: "plain", file: "scripts" });

        assert.equal(missing.isError, true);
        assert.match(missing.text, /nothing\.md/);
        assert.match(missing.text, /no such file/);
        assert.equal(directory.isError, true);
        assert.match(directory.text, /scripts/);
        assert.match(directory.text, /not a file/);
    });

    it("refuses a bundled file that is a symbolic link out of the skill's folder", async () => {
        const { skills, seatWith, callSkill } = await createFixture();
        const folder = await writeSkill(skills, "linked");
        await symlink("/etc/passwd", join(folder, "passwd"));
        const id = await seatWith(["linked"]);

        const result = await callSkill(id, { name: "linked", file: "passwd" });

        assert.equal(result.isError, true);
        assert.match(result.text, /inside the skill's folder/);
        assert.doesNotMatch(result.text, /root:/);
    });

    it("refuses a SKILL.md that is a symbolic link out of the skill's folder", async () => {
        const { env, skills, seatWith, callSkill } = await createFixture();
        const outside = join(env.root, "outside.md");
        await writeFile(outside, "---\nname: hijacked\ndescription: Linked.\n---\n\nOUTSIDE-SKILL-TEXT\n");
        const folder = join(skills, "hijacked");
        await mkdir(folder, { recursive: true });
        await symlink(outside, join(folder, "SKILL.md"));
        const id = await seatWith(["hijacked"]);

        const result = await callSkill(id, { name: "hijacked" });

        assert.equal(result.isError, true);
        assert.match(result.text, /inside the skill's folder/);
        assert.doesNotMatch(result.text, /OUTSIDE-SKILL-TEXT/);
    });

    it("cuts a file longer than 2000 lines and says so", async () => {
        const { skills, seatWith, callSkill } = await createFixture();
        const lines = Array.from({ length: MAX_LINES + 50 }, (_, index) => `line ${index + 1}`);
        await writeSkill(skills, "long", `${lines.join("\n")}\n`);
        const id = await seatWith(["long"]);

        const result = await callSkill(id, { name: "long" });

        assert.equal(result.isError, false);
        assert.match(result.text, /line 1\d\d\d\n/);
        assert.doesNotMatch(result.text, new RegExp(`line ${MAX_LINES + 50}\\b`));
        assert.match(result.text, /\[Showing .*2000 lines/);
    });

    it("cuts a file larger than 50 KiB and says so", async () => {
        const { skills, seatWith, callSkill } = await createFixture();
        const wide = "x".repeat(1000);
        const lines = Array.from({ length: MAX_BYTES / 1000 + 20 }, () => wide);
        await writeSkill(skills, "wide", `${lines.join("\n")}\n`);
        const id = await seatWith(["wide"]);

        const result = await callSkill(id, { name: "wide" });

        assert.equal(result.isError, false);
        assert.ok(Buffer.byteLength(result.text) < MAX_BYTES + 500);
        assert.match(result.text, /\[Showing .*50KB/);
    });
});

describe("the skill tool in the front desk", () => {
    it("returns the SKILL.md of about-the-intern to the front desk's model", async () => {
        const env = await createHermeticEnv();
        envs.push(env);
        const searchPath = join(env.root, "search-path");
        await mkdir(searchPath, { mode: 0o700 });
        await chmod(searchPath, 0o700);
        await writeSkill(searchPath, "about-the-intern", "What the intern is.\n");
        await writeFile(join(env.configDir, "config.toml"), `[skills]\npaths = ["${searchPath}"]\n`);
        const fake = registerFauxProvider();
        fakes.push(fake);
        let seen: ToolResultSeen | undefined;
        const afterCall: FauxResponseFactory = async (context) => {
            seen = lastResultOf(context);
            return fauxAssistantMessage("read it");
        };
        const call: FauxResponseFactory = async () =>
            fauxAssistantMessage([fauxToolCall(SKILL_TOOL_NAME, { name: "about-the-intern" } as never)], {
                stopReason: "toolUse",
            });
        const provider = fake.getModel().provider;
        await writeFile(
            join(env.piAgentDir, "settings.json"),
            JSON.stringify({ defaultProvider: provider, defaultModel: fake.getModel().id }),
        );
        const quiet = createLogger({ stream: { write: () => true } });
        const agents = await createAgentsComponent({ logger: quiet });
        const jobs = await createJobsComponent({ agents, logger: quiet });
        const desk = await createDeskComponent({ agents, jobs, logger: quiet });
        const daemon = runDaemon({
            flags: {
                configDir: env.configDir,
                stateDir: env.stateDir,
                dataDir: env.dataDir,
                runtimeDir: env.runtimeDir,
            },
            env: env.env,
            homeDir: env.root,
            logger: quiet,
            sections: agents.sections,
            components: [agents.component, jobs.component, desk.component],
            operations: [...agents.operations, ...jobs.operations, ...desk.operations],
            prepareModels: (runtime) => {
                const implementation = getApiProvider(fake.api);
                assert.ok(implementation);
                runtime.models.registerNativeProvider(
                    createProvider({
                        id: provider,
                        auth: { apiKey: { name: "Fake", resolve: async () => ({ auth: {} }) } },
                        models: fake.models,
                        api: { stream: implementation.stream, streamSimple: implementation.streamSimple },
                    }),
                );
                return runtime.models;
            },
        });
        daemons.push(daemon);
        const deadline = Date.now() + WAIT_MS;
        while (daemon.phase() !== "ready") {
            assert.ok(Date.now() < deadline, "the daemon became ready");
            await new Promise((resolve) => setTimeout(resolve, 10));
        }
        const caller = { actor: { kind: "team_member" as const, wayIn: "command line" as const } };
        const { conversationId } = (await daemon.catalogue.invoke("desk.get", {}, caller)) as {
            conversationId: string;
        };
        fake.setResponses([call, afterCall]);

        const { submissionId } = (await daemon.catalogue.invoke(
            "conversations.submit",
            { conversationId, content: "what are you?", requestId: "ask-1" },
            caller,
        )) as { submissionId: string };
        const waited = (await daemon.catalogue.invoke(
            "submissions.wait",
            { submissionId, timeoutMs: WAIT_MS },
            caller,
        )) as {
            state: string;
        };

        assert.equal(waited.state, "done");
        assert.equal(seen?.isError, false);
        assert.match(seen?.text ?? "", /^---\nname: about-the-intern\n/);
        assert.match(seen?.text ?? "", /What the intern is\./);
    });
});
