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
import { readFile } from "node:fs/promises";
import { join, sep } from "node:path";
import { after, before, describe, it } from "node:test";
import type { BobResult } from "../support/bob_process.ts";
import {
    ACCESS_TOKEN_SECONDS,
    createAccounts,
    filesUnder,
    jobWith,
    PASSWORD,
    PASSWORD_ADDRESS,
    rawMail,
    SECRET_DIR,
    signInGoogle,
    startWorld,
    until,
    type World,
} from "../support/mail_secrets_world.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(180_000);
const BEYOND_EXPIRY_MS = 2 * ACCESS_TOKEN_SECONDS * 1000;
const REFRESH_ROUNDS = 2;

type Place = { label: string; content: Buffer };

type Scenario = {
    secrets: Map<string, string>;
    issuedTokens: Set<string>;
    places: Place[];
    instanceFiles: string[];
    secretsDir: string;
    jsonOutputs: BobResult[];
    refreshes: number;
};

const refreshRequests = (world: World) =>
    world.oauth.requests().filter((request) => request.body.grant_type === "refresh_token").length;

/** Takes mail in on the password account, sends the result reply, and sends a mail through the tool on the OAuth one. */
async function takeInAndSend(world: World): Promise<{ numbers: string[] }> {
    await until("intake to watch both inboxes", () =>
        (world.log.join("").match(/mail intake watching/g) ?? []).length >= 2 ? true : undefined,
    );
    world.passwordServer.deliver(PASSWORD_ADDRESS, rawMail("A result"));
    const resultJob = await jobWith(world, "A result", "done");
    await until("the result reply to arrive", () => (world.passwordServer.received().length >= 1 ? true : undefined));
    await world.invoke("jobs.create", { text: "B sending", role: "sorter" });
    const sendJob = await jobWith(world, "B sending", "done");
    await until("the mail to be sent", () => (world.oauthServer.received().length >= 1 ? true : undefined));
    return { numbers: [resultJob.number, sendJob.number] };
}

/** Moves the clock past the access token's life, so the next checks refresh it; returns how many refreshes ran. */
async function refreshTokens(world: World): Promise<number> {
    const before = refreshRequests(world);
    let moment = world.clock.now().getTime();
    for (let round = 0; round < REFRESH_ROUNDS; round++) {
        moment += BEYOND_EXPIRY_MS;
        world.clock.set(new Date(moment));
        await world.invoke("mail.accounts.test", { name: "gmail" });
        await world.acceptStoredToken("gmail");
        await world.invoke("mail.accounts.test", { name: "gmail" });
    }
    return refreshRequests(world) - before;
}

/** Exports, follows both jobs, runs the `--json` commands, stops the daemon and reads every place to search. */
async function gather(world: World, numbers: string[], refreshes: number): Promise<Scenario> {
    const { env, outputs } = world;
    const exported = join(env.root, "exported.db");
    const exportResult = await world.bob(["export", exported]);
    assert.equal(exportResult.status, 0, exportResult.stderr);
    const feeds = await Promise.all(numbers.map((number) => world.bob(["jobs", "follow", number, "--json"])));
    for (const feed of feeds) assert.equal(feed.status, 0, feed.stderr);
    const jsonOutputs = await Promise.all([
        world.bob(["mail", "show", "intern", "--json"]),
        world.bob(["mail", "show", "gmail", "--json"]),
        world.bob(["mail", "list", "--json"]),
        world.bob(["status", "--json"]),
    ]);
    const status = JSON.stringify(await world.invoke("daemon.status", {}));
    await world.daemon.stop();

    const instanceFiles = (
        await Promise.all([env.configDir, env.stateDir, env.dataDir, env.runtimeDir].map(filesUnder))
    ).flat();
    const database = instanceFiles.filter((path) => /\.(sqlite|db)$|-wal$/.test(path));
    assert.ok(database.length > 0, `no database file found among: ${instanceFiles.join(", ")}`);
    const fromFiles = async (label: string, paths: string[]): Promise<Place> => ({
        label,
        content: Buffer.concat(await Promise.all(paths.map((path) => readFile(path)))),
    });
    const text = (label: string, value: string): Place => ({ label, content: Buffer.from(value) });
    return {
        secrets: world.secrets,
        issuedTokens: world.issuedTokens,
        places: [
            await fromFiles("the database file", database),
            await fromFiles("the export", [exported]),
            text("the daemon's log", world.log.join("")),
            text("the recorded feed", feeds.map((feed) => feed.stdout + feed.stderr).join("\n")),
            text("command output", outputs.map((result) => result.stdout + result.stderr).join("\n")),
            text("the daemon status", status),
            text("the fake model's requests", world.modelRequests.join("\n")),
        ],
        instanceFiles,
        secretsDir: join(env.stateDir, SECRET_DIR) + sep,
        jsonOutputs,
        refreshes,
    };
}

async function runScenario(cleanups: (() => Promise<unknown>)[]): Promise<Scenario> {
    const world = await startWorld(cleanups);
    await createAccounts(world);
    await signInGoogle(world);
    const { numbers } = await takeInAndSend(world);
    const refreshes = await refreshTokens(world);
    return gather(world, numbers, refreshes);
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

    it("took in, sent, refreshed and exported with every issued token to search for", () => {
        // The sign-in issued one pair of tokens, and each refresh another.
        assert.ok(scenario.issuedTokens.size >= 2 * (1 + REFRESH_ROUNDS), `${scenario.issuedTokens.size} tokens`);
        for (const token of scenario.issuedTokens) {
            assert.ok([...scenario.secrets.values()].includes(token), "an issued token is among the secrets");
        }
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
