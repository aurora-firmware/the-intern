/**
 * The `bob mail` commands against a daemon with the fake mail server (T-445, S-009 REQ-017, AC-017.1): `list`, `show`,
 * `test`, `notices`, `notices set`, `notices clear` and `remove` print what the requirement names, `--json` gives the
 * same data, no output holds the password, a refused call exits with S-005's code, and no command loads a daemon module.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { type BobResult, runBob } from "../support/bob_process.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";

const SRC = join(import.meta.dirname, "..", "..", "src");
const DAEMON_CODE = ["daemon/daemon.ts", "host/", "service/", "listeners/", "jobs/", "agents/"];
const PASSWORD = "s3cret-pw";
const ADDRESS = "intern@example.test";
const NOTICE_TO = "ann@example.net";

const rigs: MailRig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
});

async function readyRig(): Promise<MailRig> {
    const rig = await startMailRig({ accounts: [{ name: "intern", address: ADDRESS, password: PASSWORD }] });
    rigs.push(rig);
    await rig.waitForStatus("intern", "ready");
    return rig;
}

function bob(rig: MailRig, args: string[]): Promise<BobResult> {
    return runBob(args, { runtimeDir: rig.env.runtimeDir, env: rig.env.env });
}

function allOutput(...results: BobResult[]): string {
    return results.map((result) => result.stdout + result.stderr).join("\n");
}

// The rig's account gets its password from a `printf` command that holds it, and `show` prints the command as a
// setting; the password is no secret in that line, so the check looks at the rest of the output.
function withoutPasswordCommand(text: string): string {
    return text
        .split("\n")
        .filter((line) => !line.startsWith("Password command:"))
        .join("\n");
}

describe("bob mail", () => {
    it("lists each account with its name, address, kind, status and last check", async () => {
        const rig = await readyRig();

        const result = await bob(rig, ["mail", "list"]);

        assert.equal(result.status, 0, result.stderr);
        assert.match(result.stdout, new RegExp(`intern  ${ADDRESS}  owned  ready  checked 20`));
    });

    it("gives the accounts as JSON for list --json", async () => {
        const rig = await readyRig();

        const result = await bob(rig, ["mail", "list", "--json"]);

        assert.equal(result.status, 0, result.stderr);
        const answer = JSON.parse(result.stdout) as { accounts: { name: string; address: string; status: string }[] };
        assert.equal(answer.accounts.length, 1);
        assert.equal(answer.accounts[0]?.name, "intern");
        assert.equal(answer.accounts[0]?.address, ADDRESS);
        assert.equal(answer.accounts[0]?.status, "ready");
    });

    it("shows the settings of an account without its password, as text and as JSON", async () => {
        const rig = await readyRig();

        const text = await bob(rig, ["mail", "show", "intern"]);
        const json = await bob(rig, ["mail", "show", "intern", "--json"]);

        assert.equal(text.status, 0, text.stderr);
        assert.ok(text.stdout.includes(`Address: ${ADDRESS}`), text.stdout);
        assert.ok(text.stdout.includes("Status: ready"), text.stdout);
        assert.equal(json.status, 0, json.stderr);
        const answer = JSON.parse(json.stdout) as { account: { name: string; auth: string; password?: string } };
        assert.equal(answer.account.name, "intern");
        assert.equal(answer.account.auth, "password_command");
        assert.ok(!withoutPasswordCommand(allOutput(text)).includes(PASSWORD));
        assert.equal(answer.account.password, undefined);
    });

    it("tests the servers of an account, as text and as JSON", async () => {
        const rig = await readyRig();

        const text = await bob(rig, ["mail", "test", "intern"]);
        const json = await bob(rig, ["mail", "test", "intern", "--json"]);

        assert.equal(text.status, 0, text.stderr);
        assert.equal(text.stdout, "IMAP: ok\nSMTP: ok\n");
        assert.deepEqual(JSON.parse(json.stdout), { imap: { ok: true }, smtp: { ok: true } });
    });

    it("sets, shows and clears the notice settings", async () => {
        const rig = await readyRig();

        const unset = await bob(rig, ["mail", "notices"]);
        const set = await bob(rig, ["mail", "notices", "set", "--to", NOTICE_TO, "--from", "intern"]);
        const shown = await bob(rig, ["mail", "notices"]);
        const shownJson = await bob(rig, ["mail", "notices", "--json"]);
        const cleared = await bob(rig, ["mail", "notices", "clear"]);
        const afterClear = await bob(rig, ["mail", "notices", "--json"]);

        assert.equal(unset.stdout, "To: (none)\nFrom: (none)\n");
        assert.equal(set.status, 0, set.stderr);
        assert.equal(shown.stdout, `To: ${NOTICE_TO}\nFrom: intern\n`);
        assert.deepEqual(JSON.parse(shownJson.stdout), { notice: { to: NOTICE_TO, from: "intern" } });
        assert.equal(cleared.status, 0, cleared.stderr);
        assert.deepEqual(JSON.parse(afterClear.stdout), { notice: {} });
    });

    it("removes an account, as text and as JSON", async () => {
        const rig = await readyRig();

        const removed = await bob(rig, ["mail", "remove", "intern"]);
        const after = await bob(rig, ["mail", "list", "--json"]);

        assert.equal(removed.status, 0, removed.stderr);
        assert.equal(removed.stdout, "intern removed\n");
        assert.deepEqual(JSON.parse(after.stdout), { accounts: [] });
        assert.ok(!allOutput(removed, after).includes(PASSWORD));
    });

    it("exits 1 with the service's reason for an account that doesn't exist", async () => {
        const rig = await readyRig();

        const results = await Promise.all([
            bob(rig, ["mail", "show", "nobody"]),
            bob(rig, ["mail", "test", "nobody"]),
            bob(rig, ["mail", "remove", "nobody"]),
        ]);

        for (const result of results) {
            assert.equal(result.status, 1, result.stderr);
            assert.equal(result.stdout, "");
            assert.ok(result.stderr.includes("nobody"), result.stderr);
        }
    });

    it("exits 1 when the notice settings name an account that can't send", async () => {
        const rig = await readyRig();

        const result = await bob(rig, ["mail", "notices", "set", "--to", NOTICE_TO, "--from", "nobody"]);

        assert.equal(result.status, 1, result.stderr);
        assert.ok(result.stderr.includes("nobody"), result.stderr);
    });

    it("exits 1 when the account to remove sends the notice mail", async () => {
        const rig = await readyRig();
        await bob(rig, ["mail", "notices", "set", "--to", NOTICE_TO, "--from", "intern"]);

        const result = await bob(rig, ["mail", "remove", "intern"]);

        assert.equal(result.status, 1, result.stderr);
        assert.ok(result.stderr.includes("notice"), result.stderr);
    });

    it("exits 2 when notices set lacks --to or --from", async () => {
        const rig = await readyRig();

        const result = await bob(rig, ["mail", "notices", "set", "--to", NOTICE_TO]);

        assert.equal(result.status, 2, result.stderr);
        assert.ok(result.stderr.includes("--from"), result.stderr);
    });

    it("exits 2 for an action of notices other than set and clear", async () => {
        const rig = await readyRig();

        const result = await bob(rig, ["mail", "notices", "bogus"]);

        assert.equal(result.status, 2, result.stderr);
        assert.ok(result.stderr.includes("bogus"), result.stderr);
    });

    it("exits 3 when no daemon answers", async () => {
        const rig = await readyRig();
        await rig.stop();

        const result = await bob(rig, ["mail", "list"]);

        assert.equal(result.status, 3, result.stderr);
    });

    it("loads no daemon module other than the state layout when a mail command runs", async () => {
        const rig = await readyRig();

        const result = spawnSync(
            process.execPath,
            [
                "--import",
                join(SRC, "..", "test", "support", "module_trace.ts"),
                join(SRC, "cli", "bob.ts"),
                "mail",
                "list",
            ],
            { encoding: "utf8", env: { ...rig.env.env, BOB_RUNTIME_DIR: rig.env.runtimeDir } },
        );

        assert.equal(result.status, 0, result.stderr);
        const urls = result.stderr
            .split("\n")
            .filter((line) => line.startsWith("module-trace "))
            .map((line) => line.slice("module-trace ".length));
        assert.ok(
            urls.some((url) => url.endsWith("/cli/mail_commands.ts")),
            "the group was not loaded",
        );
        const daemonModules = urls.filter((url) => DAEMON_CODE.some((part) => url.includes(`${SRC}/${part}`)));
        assert.deepEqual(
            daemonModules.filter((url) => !url.endsWith("/daemon/state_layout.ts")),
            [],
        );
    });
});
