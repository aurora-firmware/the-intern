/**
 * The instance behind `test/service/mail_secrets.test.ts` (T-450): a daemon in this process with the agents, jobs and
 * mail components, its local socket, two fake mail servers, the fake OAuth provider, a scripted fake model and the mail
 * clock the test moves. It runs in this process, not in a daemon child, so the test reads the fake model's requests and
 * the daemon's log whole and can script a `mail_send` call. The world gathers every secret the run uses: the password,
 * the client secret and every token the provider issues, taken from the provider's answers as they pass.
 */
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { registerFauxProvider } from "@earendil-works/pi-ai/compat";
import type { RunningDaemon } from "../../src/daemon/daemon.ts";
import type { Caller } from "../../src/service/operations.ts";
import { type BobResult, runBob, spawnBob } from "./bob_process.ts";
import { type FakeMailServer, startFakeMailServer } from "./fake_mail_server.ts";
import { FAKE_OAUTH_CLIENT_SECRET, type FakeOAuthProvider, startFakeOAuthProvider } from "./fake_oauth_provider.ts";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";
import { scriptedModel, startDaemon, until, writeConfig } from "./mail_secrets_daemon.ts";
import { createTestClock, type TestClock } from "./schedule_rig.ts";

export { until };

import { scaled } from "./time_scale.ts";

const _WAIT_MS = scaled(30_000);
const POLL_MS = 20;
const CLOCK_START = Date.parse("2026-03-02T09:00:00.000Z");
const RETRY_STEP_MS = 31 * 60 * 1000;
export const ACCESS_TOKEN_SECONDS = 3600;
export const PASSWORD = "pw-4f7a91c3e0d2";
export const SECRET_DIR = "secrets";
export const PASSWORD_ADDRESS = "intern@example.test";
export const OAUTH_ADDRESS = "work@example.test";
const SENDER = "ann@example.test";
const cliCaller: Caller = { actor: { kind: "team_member", wayIn: "command line" } };

type JobView = { number: string; status: string; request: { text: string } };
type Stored = { password?: string; clientSecret?: string; accessToken?: string; refreshToken?: string };

export type World = {
    env: HermeticEnv;
    passwordServer: FakeMailServer;
    oauthServer: FakeMailServer;
    oauth: FakeOAuthProvider;
    clock: TestClock;
    daemon: RunningDaemon;
    /** The daemon's verbose log, line by line. */
    log: string[];
    /** The whole of each request the fake model received, as JSON. */
    modelRequests: string[];
    /** Every secret of the run by a label that does not give the secret away. */
    secrets: Map<string, string>;
    /** The access and refresh tokens the provider issued, taken from its answers. */
    issuedTokens: Set<string>;
    /** What every `bob` command printed. */
    outputs: BobResult[];
    invoke(name: string, input: unknown): Promise<unknown>;
    bob(args: string[], stdin?: string): Promise<BobResult>;
    storedSecret(name: string): Promise<Stored>;
    statusOf(name: string): Promise<string | undefined>;
    /** Tells the OAuth account's mail server the access token the daemon stored. */
    acceptStoredToken(name: string): Promise<void>;
};

export async function filesUnder(dir: string): Promise<string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await filesUnder(path)));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
}

export const rawMail = (subject: string): string =>
    `From: ${SENDER}\r\nTo: ${PASSWORD_ADDRESS}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replaceAll(" ", "-")}@example.test>\r\n\r\nplease look\r\n`;

/** The labelled secret goes in under its first six characters, so two tokens never share a label. */
function noteSecret(secrets: Map<string, string>, kind: string, value: string): void {
    secrets.set(`${kind} ${value.slice(0, 6)}`, value);
}

/** Replaces `fetch` with one that notes each token in the answers of the provider's endpoints; returns the undo. */
function recordIssuedTokens(world: Pick<World, "secrets" | "issuedTokens">, endpoints: string[]): () => void {
    const original = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
        const response = await original(input, init);
        const url = input instanceof Request ? input.url : String(input);
        if (!endpoints.some((endpoint) => url.startsWith(endpoint))) return response;
        const body = (await response.clone().json()) as Record<string, unknown>;
        for (const key of ["access_token", "refresh_token"] as const) {
            const token = body[key];
            if (typeof token !== "string") continue;
            world.issuedTokens.add(token);
            noteSecret(world.secrets, `issued ${key}`, token);
        }
        return response;
    };
    return () => {
        globalThis.fetch = original;
    };
}

async function startMailServer(address: string, password: string, stops: (() => Promise<unknown>)[]) {
    const server = await startFakeMailServer();
    stops.push(() => server.stop());
    server.addAccount({ address, login: address, password });
    return server;
}

/** Starts everything; each part's stop is pushed on `cleanups`, to run last first. */
export async function startWorld(cleanups: (() => Promise<unknown>)[]): Promise<World> {
    const env = await createHermeticEnv();
    cleanups.push(() => env.dispose());
    const passwordServer = await startMailServer(PASSWORD_ADDRESS, PASSWORD, cleanups);
    const oauthServer = await startMailServer(OAUTH_ADDRESS, "unused", cleanups);
    const oauth = await startFakeOAuthProvider({ accessTokenSeconds: ACCESS_TOKEN_SECONDS });
    cleanups.push(() => oauth.stop());
    const fake = registerFauxProvider({ models: [{ id: "model-one", reasoning: true }] });
    cleanups.push(async () => fake.unregister());
    const modelRequests: string[] = [];
    fake.setResponses([scriptedModel(fake, modelRequests)]);
    await writeConfig(env, fake);

    const secrets = new Map<string, string>();
    noteSecret(secrets, "password", PASSWORD);
    noteSecret(secrets, "client secret", FAKE_OAUTH_CLIENT_SECRET);
    const issuedTokens = new Set<string>();
    const partial = { secrets, issuedTokens };
    const undoFetch = recordIssuedTokens(partial, [oauth.endpoints.googleToken, oauth.endpoints.microsoftBase]);
    cleanups.push(async () => undoFetch());
    const clock = createTestClock(new Date(CLOCK_START));
    const log: string[] = [];
    const daemon = await startDaemon({ env, fake, log, clock, oauth });
    cleanups.push(() => daemon.stop());
    const outputs: BobResult[] = [];
    const invoke = (name: string, input: unknown) => daemon.catalogue.invoke(name, input, cliCaller);
    const storedSecret = async (name: string): Promise<Stored> => {
        try {
            return JSON.parse(await readFile(join(env.stateDir, SECRET_DIR, "mail", `${name}.json`), "utf8"));
        } catch {
            return {};
        }
    };
    return {
        env,
        passwordServer,
        oauthServer,
        oauth,
        clock,
        daemon,
        log,
        modelRequests,
        ...partial,
        outputs,
        invoke,
        async bob(args, stdin) {
            const options = { runtimeDir: env.runtimeDir, env: env.env, ...(stdin !== undefined && { stdin }) };
            const result = await runBob(args, options);
            outputs.push(result);
            return result;
        },
        storedSecret,
        async statusOf(name) {
            const status = (await invoke("daemon.status", {})) as { mailAccounts: { name: string; status: string }[] };
            return status.mailAccounts.find((account) => account.name === name)?.status;
        },
        async acceptStoredToken(name) {
            const token = await until(
                "the access token to be stored",
                async () => (await storedSecret(name)).accessToken,
            );
            oauthServer.acceptToken(OAUTH_ADDRESS, token);
        },
    };
}

const serverFlags = (server: FakeMailServer, address: string): string[] => [
    ...["--kind", "owned", "--address", address],
    ...["--imap-host", "127.0.0.1", "--imap-port", String(server.imapPort), "--imap-security", "none"],
    ...["--smtp-host", "127.0.0.1", "--smtp-port", String(server.smtpPort), "--smtp-security", "none"],
];

/** The password account through `bob mail create --secret-stdin`, and the Google account that then needs its sign-in. */
export async function createAccounts(world: World): Promise<void> {
    const password = await world.bob(
        [
            ...["mail", "create", "intern", ...serverFlags(world.passwordServer, PASSWORD_ADDRESS)],
            ...["--auth", "password", "--secret-stdin"],
        ],
        `${PASSWORD}\n`,
    );
    assert.equal(password.status, 0, password.stderr);
    const google = await world.bob(
        [
            ...["mail", "create", "gmail", ...serverFlags(world.oauthServer, OAUTH_ADDRESS)],
            ...["--auth", "google", "--client-id", "client-1", "--secret-stdin"],
        ],
        `${FAKE_OAUTH_CLIENT_SECRET}\n`,
    );
    assert.equal(google.status, 0, google.stderr);
    await until("the password account to be ready", async () =>
        (await world.statusOf("intern")) === "ready" ? true : undefined,
    );
}

/** `bob mail signin` with the provider answering the loopback address; the login check retries on the test clock. */
export async function signInGoogle(world: World): Promise<void> {
    const child = spawnBob(["mail", "signin", "gmail", "--json"], {
        runtimeDir: world.env.runtimeDir,
        env: world.env.env,
    });
    await child.waitFor("stdout", "address");
    const start = JSON.parse(child.stdout().split("\n")[0] as string) as { address: string };
    await world.oauth.answerGoogle(start.address);
    let isDone = false;
    const exited = child.exited.finally(() => {
        isDone = true;
    });
    let moment = world.clock.now().getTime();
    while (!isDone) {
        if ((await world.storedSecret("gmail")).accessToken !== undefined) {
            await world.acceptStoredToken("gmail");
            if ((await world.statusOf("gmail")) === "failing") {
                moment += RETRY_STEP_MS;
                world.clock.set(new Date(moment));
            }
        }
        await sleep(POLL_MS);
    }
    const status = await exited;
    world.outputs.push({ status, stdout: child.stdout(), stderr: child.stderr() });
    assert.equal(status, 0, child.stderr());
}

/** The first job whose request text holds the key and whose status is the given one. */
export function jobWith(world: World, key: string, status: string): Promise<JobView> {
    return until(`the job "${key}" to be ${status}`, async () => {
        const { jobs } = (await world.invoke("jobs.list", {})) as { jobs: JobView[] };
        return jobs.find((job) => job.request.text.includes(key) && job.status === status);
    });
}
