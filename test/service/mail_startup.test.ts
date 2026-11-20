/**
 * The mail component at startup (S-009 REQ-001, REQ-002, REQ-005, REQ-013: AC-001.2, AC-002.1, AC-002.2, AC-013.2):
 * the account checks, the status of each account, and the removal of the secrets of accounts the file no longer holds.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createAgentsComponent } from "../../src/agents/agents_component.ts";
import { type RunningDaemon, runDaemon, type ServiceContext } from "../../src/daemon/daemon.ts";
import { createLogger } from "../../src/daemon/logger.ts";
import { createJobsComponent } from "../../src/jobs/jobs_component.ts";
import { createMailComponent, type MailComponent } from "../../src/mail/mail_component.ts";
import { mailAccountSection } from "../../src/mail/mail_section.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_TIMEOUT_MS = scaled(10_000);
const POLL_INTERVAL_MS = 10;
const OWNER_ONLY_DIR_MODE = 0o700;
const ADDRESS = "bob@example.test";
const PASSWORD = "s3cret";
const SLOW_GREETING_MS = scaled(60_000);

const envs: HermeticEnv[] = [];
const daemons: RunningDaemon[] = [];
const servers: FakeMailServer[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.stop();
    for (const server of servers.splice(0)) await server.stop();
    for (const env of envs.splice(0)) await env.dispose();
});

async function mailServer(): Promise<FakeMailServer> {
    const server = await startFakeMailServer();
    server.addAccount({ address: ADDRESS, login: ADDRESS, password: PASSWORD });
    servers.push(server);
    return server;
}

const accountToml = (server: FakeMailServer, extra = ""): string =>
    `[[mail_account]]
name = "work"
kind = "owned"
address = "${ADDRESS}"
imap_host = "127.0.0.1"
imap_port = ${server.imapPort}
imap_security = "none"
smtp_host = "127.0.0.1"
smtp_port = ${server.smtpPort}
smtp_security = "none"
auth = "password_command"
password_command = ["${process.execPath}", "-e", "process.stdout.write('${PASSWORD}')"]
${extra}`;

type Rig = {
    env: HermeticEnv;
    daemon: RunningDaemon;
    mail: MailComponent;
    logs(): string;
    context(): ServiceContext;
    status(): Promise<{ mailAccounts: { name: string; status: string }[] }>;
    until(description: string, condition: () => boolean | Promise<boolean>): Promise<void>;
};

async function startRig(configToml: (env: HermeticEnv) => string, before?: (env: HermeticEnv) => Promise<void>) {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(join(env.configDir, "config.toml"), configToml(env));
    await before?.(env);
    let logs = "";
    const logger = createLogger({
        stream: {
            write: (chunk) => {
                logs += chunk;
                return true;
            },
        },
    });
    const agents = await createAgentsComponent({ logger });
    const jobs = await createJobsComponent({ agents, logger, turnEndRule: false });
    const mail = await createMailComponent({ agents, jobs, logger });
    let captured: ServiceContext | undefined;
    const daemon = runDaemon({
        flags: { configDir: env.configDir, stateDir: env.stateDir, dataDir: env.dataDir, runtimeDir: env.runtimeDir },
        env: env.env,
        homeDir: env.root,
        logger,
        workerThreadCount: 1,
        sections: [...agents.sections, ...mail.sections],
        components: [
            agents.component,
            jobs.component,
            mail.component,
            {
                name: "probe",
                start: async (ctx) => {
                    captured = ctx;
                },
            },
        ],
        operations: [...agents.operations, ...jobs.operations, ...mail.operations],
        accountStatus: mail.accountStatus,
    });
    daemons.push(daemon);
    const until: Rig["until"] = async (description, condition) => {
        const deadline = Date.now() + WAIT_TIMEOUT_MS;
        while (!(await condition())) {
            if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}; logs: ${logs}`);
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
        }
    };
    const rig: Rig = {
        env,
        daemon,
        mail,
        logs: () => logs,
        context: () => {
            assert.ok(captured, "the daemon has started");
            return captured;
        },
        status: async () =>
            (await daemon.catalogue.invoke(
                "daemon.status",
                {},
                {
                    actor: { kind: "team_member", wayIn: "command line" },
                },
            )) as Awaited<ReturnType<Rig["status"]>>,
        until,
    };
    return rig;
}

const statusOf = async (rig: Rig, name: string): Promise<string | undefined> =>
    (await rig.status()).mailAccounts.find((account) => account.name === name)?.status;

describe("the mail component at startup", () => {
    it("lists an account with a password command and turns it ready after it logs in (AC-002.1)", async () => {
        const server = await mailServer();
        const rig = await startRig(() => accountToml(server));

        await rig.until("the daemon to be ready", () => rig.daemon.phase() === "ready");
        await rig.until("the account to be ready", async () => (await statusOf(rig, "work")) === "ready");
    });

    it("turns an account failing when the server refuses the command's password", async () => {
        const server = await mailServer();
        const rig = await startRig(() => accountToml(server).replace(PASSWORD, "wrong"));

        await rig.until("the account to fail", async () => (await statusOf(rig, "work")) === "failing");
        assert.equal(rig.daemon.phase(), "ready");
    });

    it("becomes ready while the account is still connecting to a server that holds the greeting", async () => {
        const server = await mailServer();
        server.pause();
        const rig = await startRig(() => accountToml(server));

        await rig.until("the daemon to be ready", () => rig.daemon.phase() === "ready");
        assert.equal(await statusOf(rig, "work"), "connecting");
        server.resume();
        await rig.until("the account to be ready", async () => (await statusOf(rig, "work")) === "ready");
    });

    it("stops startup naming the account and the key of an unknown key (AC-002.2)", async () => {
        const server = await mailServer();
        const rig = await startRig(() => accountToml(server, 'bogus = "x"\n'));

        assert.equal(await rig.daemon.exited, 1);
        assert.match(rig.logs(), /work\.bogus/);
    });

    it("reports ready with a password account that has no password stored as needs_sign_in (AC-002.2)", async () => {
        const server = await mailServer();
        const rig = await startRig(() =>
            accountToml(server)
                .replace(/auth = .*\n/, 'auth = "password"\n')
                .replace(/password_command = .*\n/, ""),
        );

        await rig.until("the daemon to be ready", () => rig.daemon.phase() === "ready");
        assert.equal(await statusOf(rig, "work"), "needs_sign_in");
    });

    it("stops at step 6 naming notice_to when it is an owned account's address (AC-013.2)", async () => {
        const server = await mailServer();
        const rig = await startRig(
            () => `[mail]\nnotice_to = "${ADDRESS}"\nnotice_from = "work"\n\n${accountToml(server)}`,
        );

        assert.equal(await rig.daemon.exited, 1);
        assert.match(rig.logs(), /startup failed step=6/);
        assert.match(rig.logs(), /notice_to/);
    });

    it("stops at step 6 naming the key when an owned account's triage role doesn't exist (AC-013.2)", async () => {
        const server = await mailServer();
        const rig = await startRig(() => accountToml(server, 'triage_role = "ghost"\n'));

        assert.equal(await rig.daemon.exited, 1);
        assert.match(rig.logs(), /startup failed step=6/);
        assert.match(rig.logs(), /work\.triage_role/);
        assert.match(rig.logs(), /ghost/);
    });

    it("refuses roles.remove with conflict, naming the account, for a role an owned account triages with (AC-001.2)", async () => {
        const server = await mailServer();
        const rig = await startRig(() => accountToml(server));
        await rig.until("the daemon to be ready", () => rig.daemon.phase() === "ready");
        const invoke = (name: string, input: unknown) =>
            rig.daemon.catalogue.invoke(name, input, { actor: { kind: "team_member", wayIn: "command line" } });
        await invoke("roles.create", { name: "reviewer", instructions: "Review.", tools: ["read"], skills: [] });
        const accounts = rig.context().config.current(mailAccountSection);
        await rig.context().config.change(
            mailAccountSection,
            accounts.map((account) => ({ ...account, triageRole: "reviewer" })),
        );

        await assert.rejects(invoke("roles.remove", { name: "reviewer" }), {
            code: "conflict",
            message: /work/,
        });
    });

    it("removes the secrets of accounts the file no longer holds before any account starts (AC-005)", async () => {
        const server = await mailServer();
        const staleFile = (env: HermeticEnv) => join(env.stateDir, "secrets", "mail", "gone.json");
        let wasStaleKeptAtFirstStart: boolean | undefined;
        const rig = await startRig(
            () => accountToml(server),
            async (env) => {
                await mkdir(join(env.stateDir, "secrets", "mail"), { recursive: true, mode: OWNER_ONLY_DIR_MODE });
                await writeFile(staleFile(env), JSON.stringify({ password: "old" }), { mode: 0o600 });
            },
        );
        rig.mail.accountStatus.onChange(() => {
            wasStaleKeptAtFirstStart ??= existsSync(staleFile(rig.env));
        });

        await rig.until("the account to be ready", async () => (await statusOf(rig, "work")) === "ready");
        assert.equal(wasStaleKeptAtFirstStart, false);
        assert.equal(existsSync(staleFile(rig.env)), false);
    });

    it("closes the IMAP connection a check is still making when the daemon stops", async () => {
        const server = await mailServer();
        server.setSlow(SLOW_GREETING_MS);
        const rig = await startRig(() => accountToml(server));
        await rig.until("the check to hold a connection", () => server.openConnections() > 0);

        assert.equal(await rig.daemon.stop(), 0);

        await rig.until("the connection to close", () => server.openConnections() === 0);
    });

    it("closes the SMTP connection a check is still using when the daemon stops", async () => {
        const imapServer = await mailServer();
        const slowServer = await mailServer();
        slowServer.setSlow(SLOW_GREETING_MS);
        const rig = await startRig(() =>
            accountToml(imapServer).replace(`smtp_port = ${imapServer.smtpPort}`, `smtp_port = ${slowServer.smtpPort}`),
        );
        await rig.until("the check to hold the SMTP connection", () => slowServer.openConnections() > 0);

        assert.equal(await rig.daemon.stop(), 0);

        await rig.until("the connection to close", () => slowServer.openConnections() === 0);
        assert.equal(imapServer.openConnections(), 0);
    });
});
