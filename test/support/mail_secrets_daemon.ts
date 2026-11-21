/**
 * The daemon behind `test/support/mail_secrets_world.ts` (T-450): the agents, jobs and mail components and the local
 * socket in this process, over a fake model that follows a script chosen by a key in the first message of its job.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { getApiProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createMailComponent } from "../../src/mail/mail_component.ts";
import type { FakeOAuthProvider } from "./fake_oauth_provider.ts";
import type { HermeticEnv } from "./hermetic_env.ts";
import type { TestClock } from "./schedule_rig.ts";
import { scaled } from "./time_scale.ts";

const WAIT_MS = scaled(30_000);
const POLL_MS = 20;
export const RECIPIENT = "ana@example.test";

type Call = { name: string; arguments: Record<string, unknown>; id: string };

const call = (name: string, arguments_: Record<string, unknown>, id: string): Call => ({
    name,
    arguments: arguments_,
    id,
});

const SCRIPTS: Record<string, Call[]> = {
    "A result": [
        call("mark_request", { marked: true }, "call-mark"),
        call("update_job", { definitionOfDone: "The change is made" }, "call-define"),
        call("complete_job", { justification: "Done", mailText: "The change is made." }, "call-complete"),
    ],
    "B sending": [
        call("mail_send", { account: "gmail", to: [RECIPIENT], subject: "Hello", text: "Here it is." }, "call-send"),
        call("update_job", { definitionOfDone: "The mail is sent" }, "call-define-send"),
        call("complete_job", { justification: "Sent" }, "call-complete-send"),
    ],
};

const textOf = (content: unknown): string =>
    typeof content === "string"
        ? content
        : (content as { type: string; text?: string }[]).map((part) => part.text ?? "").join("");

export async function until<T>(what: string, attempt: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await sleep(POLL_MS);
    }
}

export function scriptedModel(fake: FauxProviderRegistration, modelRequests: string[]): FauxResponseFactory {
    const respond: FauxResponseFactory = async (context) => {
        fake.appendResponses([respond]);
        modelRequests.push(JSON.stringify(context));
        const first = context.messages.find((message) => message.role === "user");
        const text = first === undefined ? "" : textOf(first.content);
        const key = Object.keys(SCRIPTS).find((candidate) => text.includes(candidate));
        if (key === undefined) return fauxAssistantMessage("done");
        const next = (SCRIPTS[key] as Call[])[context.messages.filter((m) => m.role === "assistant").length];
        if (next === undefined) return fauxAssistantMessage("finished");
        return fauxAssistantMessage([fauxToolCall(next.name, next.arguments as never, { id: next.id })], {
            stopReason: "toolUse",
        });
    };
    return respond;
}

export async function startDaemon(parts: {
    env: HermeticEnv;
    fake: FauxProviderRegistration;
    log: string[];
    clock: TestClock;
    oauth: FakeOAuthProvider;
}): Promise<RunningDaemon> {
    const { env, fake, log, clock, oauth } = parts;
    const logger = createLogger({ verbose: true, stream: { write: (line) => log.push(String(line)) > 0 } });
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
    const mail = await createMailComponent({ agents, jobs, logger, clock, oauthEndpoints: oauth.endpoints });
    const provider = fake.getModel().provider;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        sections: [...agents.sections, ...mail.sections],
        components: [agents.component, jobs.component, mail.component, createLocalSocketComponent()],
        operations: [...agents.operations, ...jobs.operations, ...mail.operations],
        accountStatus: mail.accountStatus,
        prepareModels: (runtime) => {
            const implementation = getApiProvider(fake.api);
            if (!implementation) throw new Error("the fake model's api is not registered");
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
    await until("the daemon to be ready", () => (daemon.phase() === "ready" ? true : undefined));
    return daemon;
}

export async function writeConfig(env: HermeticEnv, fake: FauxProviderRegistration): Promise<void> {
    const settings = { defaultProvider: fake.getModel().provider, defaultModel: "model-one" };
    await writeFile(join(env.piAgentDir, "settings.json"), JSON.stringify(settings));
    await writeFile(
        join(env.configDir, "config.toml"),
        '[roles.sorter]\ninstructions = "Send mail."\ntools = ["read", "mail"]\n',
    );
}
