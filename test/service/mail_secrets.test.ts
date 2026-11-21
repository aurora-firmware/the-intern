/**
 * No secret leaves the secrets store (T-450, S-009 REQ-020, AC-020.1; S-002 REQ-018, AC-018.1): one account with a
 * password and one with Google OAuth are set up through `bob mail create --secret-stdin` and `bob mail signin`; mail is
 * taken in, a result reply and a send through the tool go out, the access token is refreshed under the test clock and
 * the database is exported. Then every place a secret could leak to is searched for each secret the run used: the
 * database file's bytes, the export, the daemon's log, the feed of the jobs, the output of every command and every
 * request the fake model received. The instance directories hold credential strings only inside `secrets/`.
 * The daemon runs in this process, so the fake model's requests and the daemon's log can be read whole.
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import {
    type FauxProviderRegistration,
    type FauxResponseFactory,
    fauxAssistantMessage,
    fauxToolCall,
} from "@earendil-works/pi-ai";
import { getApiProvider, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { createProvider } from "@earendil-works/pi-ai/models";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createLocalSocketComponent } from "../../src/listeners/local_socket.ts";
import { createMailComponent } from "../../src/mail/mail_component.ts";
import type { Caller } from "../../src/service/operations.ts";
import { type BobResult, runBob, spawnBob } from "../support/bob_process.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import {
    FAKE_OAUTH_CLIENT_SECRET,
    type FakeOAuthProvider,
    startFakeOAuthProvider,
} from "../support/fake_oauth_provider.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { createTestClock, type TestClock } from "../support/schedule_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(180_000);
const WAIT_MS = scaled(30_000);
const POLL_MS = 20;
const PASSWORD_ADDRESS = "intern@example.test";
const OAUTH_ADDRESS = "work@example.test";
const SENDER = "ann@example.test";
const RECIPIENT = "ana@example.test";
const PASSWORD = "pw-4f7a91c3e0d2";
const CLOCK_START = Date.parse("2026-03-02T09:00:00.000Z");
const ACCESS_TOKEN_SECONDS = 3600;
const BEYOND_EXPIRY_MS = 2 * ACCESS_TOKEN_SECONDS * 1000;
const RETRY_STEP_MS = 31 * 60 * 1000;
const REFRESH_ROUNDS = 2;
const SECRET_DIR = "secrets";
const cliCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

type Call = { name: string; arguments: Record<string, unknown>; id: string };
type JobView = { number: string; status: string; request: { text: string } };
type Place = { label: string; content: Buffer };

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

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until<T>(what: string, attempt: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await sleep(POLL_MS);
    }
}

async function filesUnder(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await filesUnder(path)));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
}

type Stored = { password?: string; clientSecret?: string; accessToken?: string; refreshToken?: string };

type Scenario = {
    secrets: Map<string, string>;
    places: Place[];
    instanceFiles: string[];
    secretsDir: string;
    jsonOutputs: BobResult[];
    refreshes: number;
};

/** Runs the whole scenario once and gathers what the three tests look at. */
async function runScenario(cleanups: (() => Promise<unknown>)[]): Promise<Scenario> {
    const env = await createHermeticEnv();
    cleanups.push(() => env.dispose());
    const passwordServer = await startFakeMailServer();
    cleanups.push(() => passwordServer.stop());
    passwordServer.addAccount({ address: PASSWORD_ADDRESS, login: PASSWORD_ADDRESS, password: PASSWORD });
    const oauthServer = await startFakeMailServer();
    cleanups.push(() => oauthServer.stop());
    oauthServer.addAccount({ address: OAUTH_ADDRESS, login: OAUTH_ADDRESS, password: "unused" });
    const oauth = await startFakeOAuthProvider({ accessTokenSeconds: ACCESS_TOKEN_SECONDS });
    cleanups.push(() => oauth.stop());
    const clock = createTestClock(new Date(CLOCK_START));

    const secrets = new Map<string, string>([
        ["password", PASSWORD],
        ["client secret", FAKE_OAUTH_CLIENT_SECRET],
    ]);
    const modelRequests: string[] = [];
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    cleanups.push(async () => fake.unregister());
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
    fake.setResponses([respond]);
    await writeConfig(env, fake);

    const log: string[] = [];
    const daemon = await startDaemon(env, fake, { log, clock, endpoints: oauth.endpoints });
    cleanups.push(() => daemon.stop());
    const invoke = (name: string, input: unknown) => daemon.catalogue.invoke(name, input, cliCaller);

    const outputs: BobResult[] = [];
    const bob = async (args: string[], stdin?: string): Promise<BobResult> => {
        const result = await runBob(args, {
            runtimeDir: env.runtimeDir,
            env: env.env,
            ...(stdin !== undefined && { stdin }),
        });
        outputs.push(result);
        return result;
    };
    const storedSecret = async (name: string): Promise<Stored> => {
        try {
            const stored = JSON.parse(await readFile(join(env.stateDir, SECRET_DIR, "mail", `${name}.json`), "utf8"));
            for (const key of ["accessToken", "refreshToken"] as const) {
                if (typeof stored[key] === "string")
                    secrets.set(`${name} ${key} ${stored[key].slice(0, 6)}`, stored[key]);
            }
            return stored as Stored;
        } catch {
            return {};
        }
    };
    const statusOf = async (name: string): Promise<string | undefined> => {
        const { mailAccounts } = (await invoke("daemon.status", {})) as {
            mailAccounts: { name: string; status: string }[];
        };
        return mailAccounts.find((account) => account.name === name)?.status;
    };
    const acceptStoredToken = async (name: string): Promise<void> => {
        const token = await until("the access token to be stored", async () => (await storedSecret(name)).accessToken);
        oauthServer.acceptToken(OAUTH_ADDRESS, token);
    };

    await createAccounts({ bob, passwordServer, oauthServer, statusOf });
    await signInGoogle({ env, bob, outputs, oauth, clock, storedSecret, acceptStoredToken, statusOf });
    await until("intake to watch both inboxes", () =>
        (log.join("").match(/mail intake watching/g) ?? []).length >= 2 ? true : undefined,
    );

    passwordServer.deliver(PASSWORD_ADDRESS, rawMail("A result"));
    const resultJob = await jobWith(invoke, "A result", "done");
    await until("the result reply to arrive", () => (passwordServer.received().length >= 1 ? true : undefined));
    const created = (await invoke("jobs.create", { text: "B sending", role: "sorter" })) as JobView;
    const sendJob = await jobWith(invoke, "B sending", "done");
    await until("the mail to be sent", () => (oauthServer.received().length >= 1 ? true : undefined));
    assert.equal(sendJob.number, created.number);

    let refreshes = oauth.requests().filter((request) => request.body.grant_type === "refresh_token").length;
    let moment = clock.now().getTime();
    for (let round = 0; round < REFRESH_ROUNDS; round++) {
        moment += BEYOND_EXPIRY_MS;
        clock.set(new Date(moment));
        await invoke("mail.accounts.test", { name: "gmail" });
        await acceptStoredToken("gmail");
        await invoke("mail.accounts.test", { name: "gmail" });
    }
    refreshes = oauth.requests().filter((request) => request.body.grant_type === "refresh_token").length - refreshes;
    await storedSecret("gmail");
    for (const request of oauth.requests()) {
        if (request.body.refresh_token)
            secrets.set(`refresh token ${request.body.refresh_token.slice(0, 6)}`, request.body.refresh_token);
    }

    const exported = join(env.root, "exported.db");
    const exportResult = await bob(["export", exported]);
    assert.equal(exportResult.status, 0, exportResult.stderr);
    const feeds = await Promise.all([resultJob, sendJob].map((job) => bob(["jobs", "follow", job.number, "--json"])));
    for (const feed of feeds) assert.equal(feed.status, 0, feed.stderr);
    const jsonOutputs = await Promise.all([
        bob(["mail", "show", "intern", "--json"]),
        bob(["mail", "show", "gmail", "--json"]),
        bob(["mail", "list", "--json"]),
        bob(["status", "--json"]),
    ]);
    const status = JSON.stringify(await invoke("daemon.status", {}));

    await daemon.stop();
    const instanceFiles = (
        await Promise.all([env.configDir, env.stateDir, env.dataDir, env.runtimeDir].map(filesUnder))
    ).flat();
    const database = instanceFiles.filter(
        (path) => path.endsWith(".sqlite") || path.endsWith(".db") || path.endsWith("-wal"),
    );
    assert.ok(database.length > 0, `no database file found among: ${instanceFiles.join(", ")}`);
    const asPlace = async (label: string, paths: string[]): Promise<Place> => ({
        label,
        content: Buffer.concat(await Promise.all(paths.map((path) => readFile(path)))),
    });
    const text = (label: string, value: string): Place => ({ label, content: Buffer.from(value) });
    return {
        secrets,
        places: [
            await asPlace("the database file", database),
            await asPlace("the export", [exported]),
            text("the daemon's log", log.join("")),
            text("the recorded feed", feeds.map((feed) => feed.stdout + feed.stderr).join("\n")),
            text("command output", outputs.map((result) => result.stdout + result.stderr).join("\n")),
            text("the daemon status", status),
            text("the fake model's requests", modelRequests.join("\n")),
        ],
        instanceFiles,
        secretsDir: join(env.stateDir, SECRET_DIR) + sep,
        jsonOutputs: jsonOutputs,
        refreshes,
    };
}

const rawMail = (subject: string): string =>
    `From: ${SENDER}\r\nTo: ${PASSWORD_ADDRESS}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replaceAll(" ", "-")}@example.test>\r\n\r\nplease look\r\n`;

async function jobWith(
    invoke: (name: string, input: unknown) => Promise<unknown>,
    key: string,
    status: string,
): Promise<JobView> {
    return until(`the job "${key}" to be ${status}`, async () => {
        const { jobs } = (await invoke("jobs.list", {})) as { jobs: JobView[] };
        return jobs.find((job) => job.request.text.includes(key) && job.status === status);
    });
}

async function writeConfig(env: HermeticEnv, fake: FauxProviderRegistration): Promise<void> {
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: fake.getModel().provider, defaultModel: "model-one" }),
    );
    await writeFile(
        join(env.configDir, "config.toml"),
        '[roles.sorter]\ninstructions = "Send mail."\ntools = ["read", "mail"]\n',
    );
}

type StartOptions = { log: string[]; clock: TestClock; endpoints: FakeOAuthProvider["endpoints"] };

async function startDaemon(
    env: HermeticEnv,
    fake: FauxProviderRegistration,
    options: StartOptions,
): Promise<RunningDaemon> {
    const logger = createLogger({ verbose: true, stream: { write: (line) => options.log.push(String(line)) > 0 } });
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
    const mail = await createMailComponent({
        agents,
        jobs,
        logger,
        clock: options.clock,
        oauthEndpoints: options.endpoints,
    });
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

type Setup = {
    bob(args: string[], stdin?: string): Promise<BobResult>;
    passwordServer: FakeMailServer;
    oauthServer: FakeMailServer;
    statusOf(name: string): Promise<string | undefined>;
};

const serverFlags = (server: FakeMailServer, address: string): string[] => [
    ...["--kind", "owned", "--address", address],
    ...["--imap-host", "127.0.0.1", "--imap-port", String(server.imapPort), "--imap-security", "none"],
    ...["--smtp-host", "127.0.0.1", "--smtp-port", String(server.smtpPort), "--smtp-security", "none"],
];

/** The password account through `bob mail create --secret-stdin`, and the Google account that then needs its sign-in. */
async function createAccounts(setup: Setup): Promise<void> {
    const password = await setup.bob(
        [
            "mail",
            "create",
            "intern",
            ...serverFlags(setup.passwordServer, PASSWORD_ADDRESS),
            "--auth",
            "password",
            "--secret-stdin",
        ],
        `${PASSWORD}\n`,
    );
    assert.equal(password.status, 0, password.stderr);
    const google = await setup.bob(
        [
            ...["mail", "create", "gmail", ...serverFlags(setup.oauthServer, OAUTH_ADDRESS)],
            ...["--auth", "google", "--client-id", "client-1", "--secret-stdin"],
        ],
        `${FAKE_OAUTH_CLIENT_SECRET}\n`,
    );
    assert.equal(google.status, 0, google.stderr);
    await until("the password account to be ready", async () =>
        (await setup.statusOf("intern")) === "ready" ? true : undefined,
    );
}

type SignIn = {
    env: HermeticEnv;
    bob(args: string[]): Promise<BobResult>;
    outputs: BobResult[];
    oauth: FakeOAuthProvider;
    clock: TestClock;
    storedSecret(name: string): Promise<Stored>;
    acceptStoredToken(name: string): Promise<void>;
    statusOf(name: string): Promise<string | undefined>;
};

/** `bob mail signin` with the provider answering the loopback address; the login check retries on the test clock. */
async function signInGoogle(sign: SignIn): Promise<void> {
    const child = spawnBob(["mail", "signin", "gmail", "--json"], {
        runtimeDir: sign.env.runtimeDir,
        env: sign.env.env,
    });
    await child.waitFor("stdout", "address");
    const start = JSON.parse(child.stdout().split("\n")[0] as string) as { address: string };
    await sign.oauth.answerGoogle(start.address);
    let isDone = false;
    const exited = child.exited.finally(() => {
        isDone = true;
    });
    let moment = sign.clock.now().getTime();
    while (!isDone) {
        if ((await sign.storedSecret("gmail")).accessToken !== undefined) {
            await sign.acceptStoredToken("gmail");
            if ((await sign.statusOf("gmail")) === "failing") {
                moment += RETRY_STEP_MS;
                sign.clock.set(new Date(moment));
            }
        }
        await sleep(POLL_MS);
    }
    const status = await exited;
    sign.outputs.push({ status, stdout: child.stdout(), stderr: child.stderr() });
    assert.equal(status, 0, child.stderr());
}

describe("no secret leaves the secrets store (AC-020.1)", () => {
    let scenario: Scenario;
    const cleanups: (() => Promise<unknown>)[] = [];

    before(
        async () => {
            scenario = await runScenario(cleanups);
        },
        { timeout: TEST_TIMEOUT_MS },
    );

    after(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    it("took in, sent, refreshed and exported with tokens of its own to search for", () => {
        const labels = [...scenario.secrets.keys()];
        assert.ok(
            labels.some((label) => label.startsWith("gmail accessToken")),
            "an access token was issued",
        );
        assert.ok(
            labels.some((label) => label.startsWith("refresh token")),
            "a refresh token was used",
        );
        assert.ok(scenario.refreshes >= REFRESH_ROUNDS, `${scenario.refreshes} refreshes ran`);
        for (const place of scenario.places) assert.ok(place.content.length > 0, `${place.label} is empty`);
    });

    it("finds no secret in the database file, the export, the log, the feed, command output or the model's requests (AC-1)", () => {
        for (const place of scenario.places) {
            for (const [label, secret] of scenario.secrets) {
                assert.ok(!place.content.includes(secret), `${place.label} holds the ${label}`);
            }
        }
    });

    it("holds no credential string outside secrets/ in the instance directories (AC-2)", async () => {
        const outside = scenario.instanceFiles.filter((path) => !path.startsWith(scenario.secretsDir));
        assert.ok(outside.length > 0);
        for (const path of outside) {
            const bytes = await readFile(path);
            for (const [label, secret] of scenario.secrets) {
                assert.ok(!bytes.includes(secret), `${path} holds the ${label}`);
            }
        }
        const kept = scenario.instanceFiles.filter((path) => path.startsWith(scenario.secretsDir));
        const keptBytes = Buffer.concat(await Promise.all(kept.map((path) => readFile(path))));
        assert.ok(keptBytes.includes(PASSWORD), "the secrets store holds the password");
    });

    it("holds no secret in bob mail show, bob mail list and the status with --json (AC-3)", () => {
        assert.equal(scenario.jsonOutputs.length, 4);
        for (const output of scenario.jsonOutputs) {
            assert.equal(output.status, 0, output.stderr);
            assert.doesNotThrow(() => JSON.parse(output.stdout));
            for (const [label, secret] of scenario.secrets) {
                assert.ok(!(output.stdout + output.stderr).includes(secret), `a --json output holds the ${label}`);
            }
        }
    });
});
