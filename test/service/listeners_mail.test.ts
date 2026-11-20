/**
 * The mail operations through both listeners of a real daemon process (S-009 Interfaces, REQ-020; S-003 REQ-003): each
 * of the nine `mail.*` operations answers over the local socket and the network listener as it answers in-process,
 * a refusal carries S-002's code, and no answer holds a password or client secret.
 */
import assert from "node:assert/strict";
import { type IncomingHttpHeaders, request } from "node:http";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { localSocketPath } from "../../src/listeners/socket_path.ts";
import type { ServiceErrorCode } from "../../src/service/operations.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { TEST_CA_FILE } from "../support/fake_mail_server.ts";
import { FAKE_OAUTH_CLIENT_SECRET } from "../support/fake_oauth_provider.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(120_000);
const STOP_TIMEOUT_MS = scaled(20_000);
const LOOPBACK = "127.0.0.1";
const CLOCK_START = "2026-03-02T09:00:00.000Z";
const SEEDED_ACCOUNT = "intern";
const SEEDED_ADDRESS = "intern@example.test";
/** The rig writes this one into the seeded account's `password_command`, which is configuration and shown as such. */
const SEEDED_PASSWORD = "seeded-pw";
const ACCOUNT_PASSWORD = "s3cret-pw";
const NOTICE_ADDRESS = "team@example.test";

/** The HTTP status S-003's Interfaces table gives each code, written out so a changed mapping is caught. */
const STATUS_OF: Record<ServiceErrorCode, number> = {
    invalid_input: 400,
    not_found: 404,
    busy: 409,
    conflict: 409,
    unavailable: 503,
    internal: 500,
};
/** What differs between calls by nature: the account's status and checks race the connection, a sign-in code is new each time. */
const VOLATILE_KEYS = new Set(["status", "lastError", "lastCheck", "code"]);

type Way = "in-process" | "local socket" | "network listener";
const WAYS: readonly Way[] = ["in-process", "local socket", "network listener"];
type Outcome = { status: number; body: { result?: unknown; error?: { code: ServiceErrorCode; message: string } } };
type Step = { operation: string; input: unknown; outcome: Outcome };
type Answered = { headers: IncomingHttpHeaders; status: number; body: Outcome["body"] };

let rig: MailRig;
let daemon: DaemonProcess;
let network: { host: string; port: number };
const runs = new Map<Way, Step[]>();

function post(target: object, operation: string, input: unknown): Promise<Answered> {
    return new Promise((resolve, reject) => {
        const call = request(
            {
                ...target,
                method: "POST",
                path: `/operations/${operation}`,
                headers: { "content-type": "application/json" },
            },
            (response) => {
                const chunks: Buffer[] = [];
                response.on("data", (chunk: Buffer) => chunks.push(chunk));
                response.once("end", () =>
                    resolve({
                        headers: response.headers,
                        status: response.statusCode ?? 0,
                        body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
                    }),
                );
                response.once("error", reject);
            },
        );
        call.once("error", reject);
        call.end(JSON.stringify(input));
    });
}

async function inProcess(operation: string, input: unknown): Promise<Outcome> {
    try {
        const result = await daemon.invoke(operation, input);
        return { status: 200, body: { result: JSON.parse(JSON.stringify(result)) } };
    } catch (error) {
        const { code, message } = error as { code: ServiceErrorCode; message: string };
        return { status: STATUS_OF[code], body: { error: { code, message } } };
    }
}

function caller(way: Way): (operation: string, input: unknown) => Promise<Outcome> {
    if (way === "in-process") return inProcess;
    const target = way === "local socket" ? { socketPath: localSocketPath(rig.env.runtimeDir) } : network;
    return async (operation, input) => {
        const { status, body } = await post(target, operation, input);
        return { status, body };
    };
}

function ownedInput(name: string, extra: Record<string, unknown>): Record<string, unknown> {
    return {
        name,
        kind: "owned",
        address: `${name}@example.test`,
        imap_host: LOOPBACK,
        imap_port: rig.server.imapPort,
        imap_security: "none",
        smtp_host: LOOPBACK,
        smtp_port: rig.server.smtpPort,
        smtp_security: "none",
        ...extra,
    };
}

/** Calls every operation, refusals included, as one way, on accounts of its own name so the ways do not collide. */
async function runScenario(way: Way): Promise<Step[]> {
    const slug = way.replace(" ", "-");
    const [plain, microsoft, app] = [`plain-${slug}`, `ms-${slug}`, `app-${slug}`];
    const call = caller(way);
    const steps: Step[] = [];
    const run = async (operation: string, input: unknown): Promise<void> => {
        steps.push({ operation, input, outcome: await call(operation, input) });
    };

    await run("mail.notices.get", {});
    await run("mail.accounts.create", ownedInput(plain, { auth: "password", password: ACCOUNT_PASSWORD }));
    await run("mail.accounts.create", ownedInput(microsoft, { auth: "microsoft", client_id: "client-1", tenant: "t" }));
    await run(
        "mail.accounts.create",
        ownedInput(app, {
            auth: "microsoft_app",
            client_id: "client-1",
            tenant: "t",
            clientSecret: FAKE_OAUTH_CLIENT_SECRET,
        }),
    );
    await run("mail.accounts.create", ownedInput(plain, { auth: "password", password: ACCOUNT_PASSWORD }));
    await run(
        "mail.accounts.create",
        ownedInput(`bad-${slug}`, { auth: "password", password: ACCOUNT_PASSWORD, check_interval_seconds: 5 }),
    );
    await run("mail.accounts.get", { name: plain });
    await run("mail.accounts.get", { name: "nobody" });
    await run("mail.accounts.change", { name: plain, allow: ["@example.com"], password: ACCOUNT_PASSWORD });
    await run("mail.accounts.change", { name: "nobody", allow: ["@example.com"] });
    await run("mail.accounts.list", {});
    await run("mail.notices.set", { to: NOTICE_ADDRESS, from: plain });
    await run("mail.notices.get", {});
    await run("mail.accounts.remove", { name: plain });
    await run("mail.notices.set", {});
    await run("mail.accounts.test", { name: SEEDED_ACCOUNT });
    await run("mail.accounts.test", { name: plain });
    await run("mail.accounts.test", { name: "nobody" });
    await run("mail.accounts.signin", { name: microsoft });
    await run("mail.accounts.signin", { name: plain });
    await run("mail.accounts.signin", { name: app });
    await run("mail.accounts.signin", { name: "nobody" });
    for (const name of [plain, microsoft, app, "nobody"]) await run("mail.accounts.remove", { name });
    await run("mail.accounts.list", {});
    return steps;
}

/** The step's outcome without what differs by nature, with the way's account names made alike. */
function comparable(way: Way, outcome: Outcome): unknown {
    const slug = way.replace(" ", "-");
    const text = JSON.stringify(outcome, (key, value) => (VOLATILE_KEYS.has(key) ? undefined : value));
    return JSON.parse(text.replaceAll(slug, "<way>"));
}

function stepsOf(way: Way): Step[] {
    const steps = runs.get(way);
    assert.ok(steps, `${way} has run the scenario`);
    return steps;
}

/** The daemon the rig started has no network listener, so it is replaced by one on the same directories that has. */
async function startWithListeners(): Promise<void> {
    rig = await startMailRig({
        accounts: [{ name: SEEDED_ACCOUNT, address: SEEDED_ADDRESS, password: SEEDED_PASSWORD }],
        clockStart: new Date(CLOCK_START),
    });
    const first = rig.process();
    first.signal("SIGTERM");
    await Promise.race([first.exited, sleep(STOP_TIMEOUT_MS, undefined, { ref: false })]);
    daemon = startDaemon({
        hermetic: { ...rig.env, env: { ...rig.env.env, NODE_EXTRA_CA_CERTS: TEST_CA_FILE } },
        mailClock: CLOCK_START,
        oauthEndpoints: rig.oauth.endpoints,
        networkListener: true,
    });
    await daemon.ready;
    network = { host: LOOPBACK, port: await daemon.networkPort() };
}

describe("the mail operations through both listeners", () => {
    before(
        async () => {
            await startWithListeners();
            for (const way of WAYS) runs.set(way, await runScenario(way));
        },
        { timeout: TEST_TIMEOUT_MS },
    );

    after(
        async () => {
            if (daemon) {
                daemon.signal("SIGTERM");
                await Promise.race([daemon.exited, sleep(STOP_TIMEOUT_MS, undefined, { ref: false })]);
                daemon.kill9();
            }
            if (rig) await rig.stop();
        },
        { timeout: TEST_TIMEOUT_MS },
    );

    it("answers each of the nine operations over both listeners as it does in-process (AC-1)", () => {
        const reached = new Set<string>();
        const inProcessSteps = stepsOf("in-process");
        for (const way of ["local socket", "network listener"] as const) {
            const steps = stepsOf(way);
            assert.equal(steps.length, inProcessSteps.length);
            steps.forEach((step, index) => {
                const expected = inProcessSteps[index];
                assert.equal(step.operation, expected?.operation);
                assert.equal(step.outcome.status, expected?.outcome.status, `${way}: ${step.operation} status`);
                assert.deepEqual(
                    comparable(way, step.outcome),
                    comparable("in-process", expected?.outcome as Outcome),
                    `${way}: ${step.operation} answer`,
                );
                if (step.outcome.status === 200) reached.add(step.operation);
            });
        }

        assert.deepEqual([...reached].sort(), [
            "mail.accounts.change",
            "mail.accounts.create",
            "mail.accounts.get",
            "mail.accounts.list",
            "mail.accounts.remove",
            "mail.accounts.signin",
            "mail.accounts.test",
            "mail.notices.get",
            "mail.notices.set",
        ]);
    });

    it("carries S-002's error code and its HTTP status on a refusal over both listeners (AC-2)", () => {
        const expectedCodes: [string, ServiceErrorCode][] = [
            ["mail.accounts.create", "conflict"],
            ["mail.accounts.create", "invalid_input"],
            ["mail.accounts.get", "not_found"],
            ["mail.accounts.change", "not_found"],
            ["mail.accounts.remove", "conflict"],
            ["mail.accounts.remove", "not_found"],
            ["mail.accounts.test", "not_found"],
            ["mail.accounts.signin", "invalid_input"],
            ["mail.accounts.signin", "not_found"],
        ];
        for (const way of WAYS) {
            const refused = stepsOf(way)
                .filter((step) => step.outcome.body.error !== undefined)
                .map((step) => [step.operation, step.outcome.body.error?.code] as const);
            assert.deepEqual(
                [...new Set(refused.map(([operation, code]) => `${operation} ${code}`))].sort(),
                expectedCodes.map(([operation, code]) => `${operation} ${code}`).sort(),
                way,
            );
            for (const step of stepsOf(way)) {
                const code = step.outcome.body.error?.code;
                if (code !== undefined) assert.equal(step.outcome.status, STATUS_OF[code], `${way}: ${step.operation}`);
            }
        }
    });

    it("holds no account password or client secret in any answer of either listener (AC-3)", () => {
        let secretsSent = 0;
        for (const way of ["local socket", "network listener"] as const) {
            for (const step of stepsOf(way)) {
                const input = JSON.stringify(step.input);
                if (input.includes(ACCOUNT_PASSWORD) || input.includes(FAKE_OAUTH_CLIENT_SECRET)) secretsSent++;
                const answer = JSON.stringify(step.outcome);
                for (const secret of [ACCOUNT_PASSWORD, FAKE_OAUTH_CLIENT_SECRET]) {
                    assert.equal(answer.includes(secret), false, `${way}: ${step.operation} holds a secret`);
                }
            }
        }

        assert.ok(secretsSent > 0, "the scenario sent secrets, so their absence from the answers means something");
    });
});
