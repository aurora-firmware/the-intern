/**
 * A test daemon process with the mail component, the fake mail server and the fake OAuth provider (S-009). The daemon
 * trusts the fake servers' certificate authority and runs the mail component on a clock the test moves, so a test
 * drives the account checks and their retries without waiting for real time.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type DaemonProcess, startDaemon } from "./daemon_process.ts";
import { type FakeMailServer, startFakeMailServer, TEST_CA_FILE } from "./fake_mail_server.ts";
import { FAKE_OAUTH_CLIENT_SECRET, type FakeOAuthProvider, startFakeOAuthProvider } from "./fake_oauth_provider.ts";
import { createHermeticEnv, type HermeticEnv } from "./hermetic_env.ts";
import { scaled } from "./time_scale.ts";

const WAIT_TIMEOUT_MS = scaled(20_000);
const STOP_TIMEOUT_MS = scaled(20_000);
const POLL_INTERVAL_MS = 10;
const OWNER_ONLY_DIR_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const ACCESS_TOKEN_SECONDS = 3600;
const LOOPBACK = "127.0.0.1";
const DEFAULT_CLOCK_START = "2026-03-02T09:00:00.000Z";

export type MailRigAccount = {
    name: string;
    address: string;
    /** The password the account's `password_command` prints, and the fake server accepts. Not used with `microsoftApp`. */
    password?: string;
    /**
     * Signs the account in with the Microsoft app flow against the fake provider: the rig stores the provider's client
     * secret for it before the start, so each check asks the provider for a token.
     */
    microsoftApp?: { clientId: string; tenant: string };
    /** `false` leaves the address out of the fake server, so its logins fail (true by default). */
    isKnownToServer?: boolean;
};

export type MailRigOptions = {
    /** Owned accounts written to `config.toml` before each start. The fake server serves one address, so one of them at most is known to it. */
    accounts: MailRigAccount[];
    /** The mail clock's first moment at each start; a fixed instant by default. */
    clockStart?: Date;
};

type JobRecord = { id: string; status: string; [field: string]: unknown };

export type MailRig = {
    env: HermeticEnv;
    server: FakeMailServer;
    oauth: FakeOAuthProvider;
    /** The daemon process now running. */
    process(): DaemonProcess;
    /** Settles when `daemon.status` lists the account with the status. */
    waitForStatus(name: string, status: string): Promise<void>;
    /** Settles with the first job in `jobs.list` the predicate accepts. */
    waitForJob(predicate: (job: JobRecord) => boolean, options?: { timeoutMs?: number }): Promise<JobRecord>;
    /** Puts a message in the address's inbox on the fake server. */
    deliver(address: string, raw: string | Buffer): void;
    /** Moves the daemon's mail clock; its waits that fall due end at once. */
    setClock(time: Date): Promise<void>;
    /** Stops the daemon and starts another on the same directories. */
    restart(): Promise<void>;
    /** Stops the daemon, the fake server and the provider, and removes the directories. Safe to call twice. */
    stop(): Promise<void>;
};

function authToml(account: MailRigAccount): string {
    if (account.microsoftApp) {
        const { clientId, tenant } = account.microsoftApp;
        return `auth = "microsoft_app"
client_id = ${JSON.stringify(clientId)}
tenant = ${JSON.stringify(tenant)}
`;
    }
    return `auth = "password_command"
password_command = ${JSON.stringify(["printf", "%s", account.password ?? ""])}
`;
}

function accountToml(account: MailRigAccount, server: FakeMailServer): string {
    const text = (value: string) => JSON.stringify(value);
    return `[[mail_account]]
name = ${text(account.name)}
kind = "owned"
address = ${text(account.address)}
imap_host = "${LOOPBACK}"
imap_port = ${server.imapPort}
imap_security = "none"
smtp_host = "${LOOPBACK}"
smtp_port = ${server.smtpPort}
smtp_security = "none"
${authToml(account)}`;
}

async function writeClientSecret(env: HermeticEnv, name: string): Promise<void> {
    const directory = join(env.stateDir, "secrets", "mail");
    await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await writeFile(join(directory, `${name}.json`), JSON.stringify({ clientSecret: FAKE_OAUTH_CLIENT_SECRET }), {
        mode: OWNER_ONLY_FILE_MODE,
    });
}

async function until<T>(description: string, timeoutMs: number, attempt: () => Promise<T | undefined>): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${description}`);
        await sleep(POLL_INTERVAL_MS);
    }
}

export async function startMailRig(options: MailRigOptions): Promise<MailRig> {
    const server = await startFakeMailServer();
    const oauth = await startFakeOAuthProvider({ accessTokenSeconds: ACCESS_TOKEN_SECONDS });
    const env = await createHermeticEnv();
    let current: DaemonProcess | undefined;
    let hasStopped = false;

    for (const account of options.accounts) {
        if (account.isKnownToServer === false) continue;
        server.addAccount({ address: account.address, login: account.address, password: account.password ?? "" });
    }
    for (const account of options.accounts) {
        if (account.microsoftApp) await writeClientSecret(env, account.name);
    }
    await writeFile(
        join(env.configDir, "config.toml"),
        options.accounts.map((account) => accountToml(account, server)).join("\n"),
    );

    const launch = async (): Promise<void> => {
        current = startDaemon({
            hermetic: { ...env, env: { ...env.env, NODE_EXTRA_CA_CERTS: TEST_CA_FILE } },
            mailClock: (options.clockStart ?? new Date(DEFAULT_CLOCK_START)).toISOString(),
            oauthEndpoints: oauth.endpoints,
        });
        await current.ready;
    };
    const requireProcess = (): DaemonProcess => {
        if (!current) throw new Error("the mail rig has no daemon process");
        return current;
    };
    const stopProcess = async (): Promise<void> => {
        const daemon = current;
        if (!daemon) return;
        daemon.signal("SIGTERM");
        const outcome = await Promise.race([daemon.exited, sleep(STOP_TIMEOUT_MS).then(() => "timeout" as const)]);
        if (outcome === "timeout") {
            daemon.kill9();
            await daemon.exited;
        }
    };
    const statusOf = async (name: string): Promise<string | undefined> => {
        const status = (await requireProcess().invoke("daemon.status", {})) as {
            mailAccounts: { name: string; status: string }[];
        };
        return status.mailAccounts.find((account) => account.name === name)?.status;
    };

    try {
        await launch();
    } catch (error) {
        await stopProcess();
        await Promise.all([server.stop(), oauth.stop()]);
        await env.dispose();
        throw error;
    }

    return {
        env,
        server,
        oauth,
        process: requireProcess,
        waitForStatus: (name, status) =>
            until(`account ${name} to be ${status}`, WAIT_TIMEOUT_MS, async () =>
                (await statusOf(name)) === status ? true : undefined,
            ).then(() => undefined),
        waitForJob: (predicate, waitOptions) =>
            until("a matching job", waitOptions?.timeoutMs ?? WAIT_TIMEOUT_MS, async () => {
                const { jobs } = (await requireProcess().invoke("jobs.list", {})) as { jobs: JobRecord[] };
                return jobs.find(predicate);
            }),
        deliver: (address, raw) => server.deliver(address, raw),
        setClock: async (time) => {
            await requireProcess().invoke("test.mail.clock.set", { time: time.toISOString() });
        },
        restart: async () => {
            await stopProcess();
            await launch();
        },
        stop: async () => {
            if (hasStopped) return;
            hasStopped = true;
            await stopProcess();
            await Promise.all([server.stop(), oauth.stop()]);
            await env.dispose();
        },
    };
}
