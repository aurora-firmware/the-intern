/**
 * The `bob mail create`, `change` and `signin` commands against a daemon with the fake mail server (T-446, S-009
 * REQ-017, AC-017.1): a secret typed on a terminal is not echoed or printed, `--secret-stdin` reads it from standard
 * input, no flag carries it, `--allow` and `--disallow` change the allowlist, `signin` prints the code and address and
 * exits 0 once the account is `ready`, and a refused call exits with S-005's code with `--json` giving the same data.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type BobResult, runBob, spawnBob } from "../support/bob_process.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { hasScript, runInPty } from "../support/pty.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(60_000);
const ADDRESS = "intern@example.test";
const PASSWORD = "s3cret-pw";
const CLOCK_START = Date.parse("2026-03-02T09:00:00.000Z");
const CLOCK_STEP_MS = 2 * 60 * 60 * 1000;
const DEVICE_POLL_STEP_MS = 10_000;
const POLL_MS = 20;

const rigs: MailRig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
});

async function emptyRig(): Promise<MailRig> {
    const rig = await startMailRig({ accounts: [] });
    rigs.push(rig);
    rig.server.addAccount({ address: ADDRESS, login: ADDRESS, password: PASSWORD });
    return rig;
}

function bob(rig: MailRig, args: string[], stdin?: string): Promise<BobResult> {
    return runBob(args, { runtimeDir: rig.env.runtimeDir, env: rig.env.env, ...(stdin !== undefined && { stdin }) });
}

function serverFlags(rig: MailRig): string[] {
    return [
        "--kind",
        "owned",
        "--address",
        ADDRESS,
        "--imap-host",
        "127.0.0.1",
        "--imap-port",
        String(rig.server.imapPort),
        "--imap-security",
        "none",
        "--smtp-host",
        "127.0.0.1",
        "--smtp-port",
        String(rig.server.smtpPort),
        "--smtp-security",
        "none",
    ];
}

const createArgs = (rig: MailRig, name = "intern"): string[] => [
    "mail",
    "create",
    name,
    ...serverFlags(rig),
    "--auth",
    "password",
];

async function allowOf(rig: MailRig, name = "intern"): Promise<string[]> {
    const answer = JSON.parse((await bob(rig, ["mail", "show", name, "--json"])).stdout) as {
        account: { allow: string[] };
    };
    return answer.account.allow;
}

async function createMicrosoftAccount(rig: MailRig): Promise<void> {
    const created = await bob(rig, [
        "mail",
        "create",
        "work",
        ...serverFlags(rig),
        "--auth",
        "microsoft",
        "--client-id",
        "client-1",
        "--tenant",
        "contoso",
    ]);
    assert.equal(created.status, 0, created.stderr);
}

describe("bob mail create", () => {
    it("creates the account from the password typed on a terminal and echoes and prints nothing of it", {
        skip: !hasScript(),
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await emptyRig();
        const session = runInPty(createArgs(rig), { runtimeDir: rig.env.runtimeDir });

        await session.waitFor("stderr", "Password: ");
        session.write(`${PASSWORD}\r`);
        const status = await session.exited;

        assert.equal(status, 0, session.stderr());
        assert.ok(!session.output().includes(PASSWORD), "the password was echoed");
        assert.ok(!session.stderr().includes(PASSWORD));
        await rig.waitForStatus("intern", "ready");
        const config = await readFile(join(rig.env.configDir, "config.toml"), "utf8");
        assert.ok(!config.includes(PASSWORD));
    });

    it("reads the secret from standard input with --secret-stdin and prints the account as text and as JSON", async () => {
        const rig = await emptyRig();

        const text = await bob(rig, [...createArgs(rig), "--secret-stdin"], `${PASSWORD}\n`);
        const json = await bob(rig, [...createArgs(rig, "second"), "--secret-stdin", "--json"], `${PASSWORD}\n`);

        assert.equal(text.status, 0, text.stderr);
        assert.ok(text.stdout.includes("intern"), text.stdout);
        assert.equal(json.status, 0, json.stderr);
        assert.equal((JSON.parse(json.stdout) as { account: { name: string } }).account.name, "second");
        await rig.waitForStatus("intern", "ready");
        assert.ok(!(text.stdout + text.stderr + json.stdout + json.stderr).includes(PASSWORD));
    });

    it("reads no environment variable as the secret", async () => {
        const rig = await emptyRig();

        const result = await runBob(createArgs(rig), {
            runtimeDir: rig.env.runtimeDir,
            env: { ...rig.env.env, BOB_PASSWORD: PASSWORD, PASSWORD, BOB_SECRET: PASSWORD },
        });

        assert.equal(result.status, 2, result.stderr);
        assert.ok(result.stderr.includes("--secret-stdin"), result.stderr);
    });

    it("refuses a password flag as a usage error", async () => {
        const rig = await emptyRig();

        const result = await bob(rig, [...createArgs(rig), "--password", PASSWORD]);

        assert.equal(result.status, 2, result.stderr);
    });

    it("exits 2 for a port that is not a number", async () => {
        const rig = await emptyRig();

        const result = await bob(rig, [...createArgs(rig), "--imap-port", "abc", "--secret-stdin"], PASSWORD);

        assert.equal(result.status, 2, result.stderr);
        assert.ok(result.stderr.includes("--imap-port"), result.stderr);
    });

    it("creates an account with a password command and needs no secret", async () => {
        const rig = await emptyRig();
        const args = ["mail", "create", "cmd", ...serverFlags(rig), "--auth", "password_command"];

        const result = await bob(rig, [...args, "--password-command", "printf", "--password-command", PASSWORD]);

        assert.equal(result.status, 0, result.stderr);
        await rig.waitForStatus("cmd", "ready");
    });

    it("exits 1 with the service's reason when the account exists, and gives the refusal as the code it names", async () => {
        const rig = await emptyRig();
        await bob(rig, [...createArgs(rig), "--secret-stdin"], PASSWORD);

        const result = await bob(rig, [...createArgs(rig), "--secret-stdin"], PASSWORD);

        assert.equal(result.status, 1, result.stderr);
        assert.ok(result.stderr.includes("conflict"), result.stderr);
        assert.ok(!result.stderr.includes(PASSWORD));
    });
});

describe("bob mail change", () => {
    it("adds an entry with --allow and removes it with --disallow", async () => {
        const rig = await emptyRig();
        await bob(rig, [...createArgs(rig), "--secret-stdin"], PASSWORD);

        const added = await bob(rig, [
            "mail",
            "change",
            "intern",
            "--allow",
            "@example.com",
            "--allow",
            "a@example.org",
        ]);
        const afterAdd = await allowOf(rig);
        const removed = await bob(rig, ["mail", "change", "intern", "--disallow", "@example.com"]);
        const afterRemove = await allowOf(rig);

        assert.equal(added.status, 0, added.stderr);
        assert.deepEqual(afterAdd, ["@example.com", "a@example.org"]);
        assert.equal(removed.status, 0, removed.stderr);
        assert.deepEqual(afterRemove, ["a@example.org"]);
    });

    it("changes a setting and gives the account as JSON", async () => {
        const rig = await emptyRig();
        await bob(rig, [...createArgs(rig), "--secret-stdin"], PASSWORD);

        const result = await bob(rig, ["mail", "change", "intern", "--check-interval", "120", "--json"]);

        assert.equal(result.status, 0, result.stderr);
        const answer = JSON.parse(result.stdout) as { account: { checkIntervalSeconds: number } };
        assert.equal(answer.account.checkIntervalSeconds, 120);
    });

    it("stores a new secret read from standard input with --new-secret --secret-stdin", async () => {
        const rig = await emptyRig();
        await bob(rig, [...createArgs(rig), "--secret-stdin"], "wrong-password");
        await rig.waitForStatus("intern", "failing");

        const result = await bob(rig, ["mail", "change", "intern", "--new-secret", "--secret-stdin"], PASSWORD);

        assert.equal(result.status, 0, result.stderr);
        assert.ok(!(result.stdout + result.stderr).includes(PASSWORD));
        await rig.waitForStatus("intern", "ready");
    });

    it("exits 1 for an account that doesn't exist", async () => {
        const rig = await emptyRig();

        const result = await bob(rig, ["mail", "change", "nobody", "--allow", "@example.com"]);

        assert.equal(result.status, 1, result.stderr);
        assert.ok(result.stderr.includes("nobody"), result.stderr);
    });
});

describe("bob mail signin", () => {
    it("prints the code and address of a microsoft account and exits 0 once it is ready", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await emptyRig();
        await createMicrosoftAccount(rig);
        const child = spawnBob(["mail", "signin", "work"], { runtimeDir: rig.env.runtimeDir, env: rig.env.env });

        await child.waitFor("stdout", "enter the code ");
        const code = /enter the code (\S+)\./.exec(child.stdout())?.[1] as string;
        assert.ok(child.stdout().includes(`${rig.oauth.endpoints.microsoftBase}/devicelogin`), child.stdout());
        rig.oauth.enterCode(code);
        await rig.setClock(new Date(CLOCK_START + DEVICE_POLL_STEP_MS));
        let clock = CLOCK_START;
        let isDone = false;
        const exited = child.exited.finally(() => {
            isDone = true;
        });
        while (!isDone) {
            const token = await storedToken(rig, "work");
            if (token !== undefined) {
                // The login check retries after a pause on the mail clock, so the clock moves once the token is known.
                rig.server.acceptToken(ADDRESS, token);
                clock += CLOCK_STEP_MS;
                await rig.setClock(new Date(clock));
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }

        assert.equal(await exited, 0, child.stderr());
    });

    it("prints the reason and exits 1 when the sign-in of an account that needs it ends without the code entered", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await emptyRig();
        await createMicrosoftAccount(rig);
        const child = spawnBob(["mail", "signin", "work", "--json"], {
            runtimeDir: rig.env.runtimeDir,
            env: rig.env.env,
        });
        await child.waitFor("stdout", "devicelogin");

        // The code expires on the mail clock; nobody entered it.
        await rig.setClock(new Date(CLOCK_START + CLOCK_STEP_MS));

        assert.equal(await child.exited, 1, child.stderr());
        assert.ok(child.stderr().includes("The sign-in of work failed: "), child.stderr());
        assert.ok(child.stderr().includes("the code expired"), child.stderr());
        const lines = child.stdout().trim().split("\n");
        assert.equal((JSON.parse(lines[0] as string) as { kind: string }).kind, "device_code");
        const last = JSON.parse(lines.at(-1) as string) as { type: string; name: string; status: string };
        assert.deepEqual([last.type, last.name, last.status], ["mail_account_status", "work", "needs_sign_in"]);
    });

    it("exits 1 with the service's reason for an account that has no sign-in, and for one that doesn't exist", async () => {
        const rig = await emptyRig();
        await bob(rig, [...createArgs(rig), "--secret-stdin"], PASSWORD);

        const noSignIn = await bob(rig, ["mail", "signin", "intern"]);
        const missing = await bob(rig, ["mail", "signin", "nobody"]);

        assert.equal(noSignIn.status, 1, noSignIn.stderr);
        assert.ok(noSignIn.stderr.includes("no sign-in"), noSignIn.stderr);
        assert.equal(missing.status, 1, missing.stderr);
        assert.equal(noSignIn.stdout, "");
    });

    it("exits 3 when no daemon answers", async () => {
        const rig = await emptyRig();
        await rig.stop();

        const result = await bob(rig, ["mail", "signin", "work"]);

        assert.equal(result.status, 3, result.stderr);
    });
});

async function storedToken(rig: MailRig, name: string): Promise<string | undefined> {
    try {
        const file = join(rig.env.stateDir, "secrets", "mail", `${name}.json`);
        return (JSON.parse(await readFile(file, "utf8")) as { accessToken?: string }).accessToken;
    } catch {
        return undefined;
    }
}
