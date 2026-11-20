/**
 * The mail daemon component (S-009): the `mail` and `mail_account` configuration sections, the startup checks of steps
 * 5 and 6, and the start of each account at step 8: the removal of the secrets of accounts the file no longer holds,
 * then a login check in the background that never holds readiness back.
 */

import {
    type AccountClock,
    type AccountStatusHub,
    type CheckOutcome,
    createAccountStatusHub,
} from "../accounts/account_status.ts";
import { type AccountAuth, type ProviderEndpoints, REAL_PROVIDER_ENDPOINTS } from "../accounts/providers.ts";
import { createSecretsStore, type SecretsStore } from "../accounts/secrets_store.ts";
import { type AccountsLayer, CredentialFailure, createAccountsLayer } from "../accounts/sign_in.ts";
import type { AgentsComponent } from "../agents/agents_component.ts";
import { ConfigError, type ConfigSection } from "../config/config_file.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import type { JobsComponent } from "../jobs/jobs_component.ts";
import { mailOperations } from "../service/mail_operations.ts";
import type { Operation } from "../service/operations.ts";
import { openImap } from "./imap_client.ts";
import { createIntake } from "./intake.ts";
import { accountKey, checkNotice, type MailAccount, MailRuleError } from "./mail_model.ts";
import { mailAccountSection, mailSection } from "./mail_section.ts";
import { createMailToolsExtension } from "./mail_tools_extension.ts";
import { checkSmtpLogin } from "./smtp_client.ts";
import { createToolConnections } from "./tool_connection.ts";

const MAIL_OWNER = "mail";

const SCOPES: Record<string, readonly string[]> = {
    google: ["https://mail.google.com/"],
    microsoft: [
        "offline_access",
        "https://outlook.office.com/IMAP.AccessAsUser.All",
        "https://outlook.office.com/SMTP.Send",
    ],
    microsoft_app: ["https://outlook.office365.com/.default"],
};

/** The points of a mail write at which a test may stop the daemon. */
export type MailWritePoint = "mail-saved" | "mail-routed" | "mail-sending" | "mail-sent";

export type MailComponentOptions = {
    agents: AgentsComponent;
    jobs: JobsComponent;
    logger: Logger;
    clock?: AccountClock;
    /** The providers' OAuth endpoints; a test passes the fake provider's. */
    oauthEndpoints?: ProviderEndpoints;
    /** Test only: called after each write point. */
    afterWrite?: (point: MailWritePoint) => Promise<void>;
};

/** What the account operations ask of the running accounts. */
export type MailControl = {
    /** Ends the account's check and starts it again from the file's current settings. */
    restartAccount(name: string): Promise<void>;
    stopAccount(name: string): void;
};

export type MailComponent = {
    component: DaemonComponent;
    sections: readonly ConfigSection<unknown>[];
    // biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
    operations: Operation<ServiceContext, any, any>[];
    accountStatus: AccountStatusHub;
    accounts: AccountsLayer;
    control: MailControl;
};

const realClock: AccountClock = {
    now: () => new Date(),
    wait: (until, signal) =>
        new Promise<void>((resolve) => {
            const done = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", done);
                resolve();
            };
            const timer = setTimeout(done, Math.max(0, until.getTime() - Date.now()));
            signal.addEventListener("abort", done, { once: true });
            if (signal.aborted) done();
        }),
};

function authOf(account: MailAccount): AccountAuth {
    return {
        key: accountKey(account.name),
        kind: account.auth,
        login: account.login,
        ...(account.clientId !== undefined && { clientId: account.clientId }),
        ...(account.tenant !== undefined && { tenant: account.tenant }),
        ...(account.passwordCommand !== undefined && { passwordCommand: account.passwordCommand }),
    };
}

/** The secrets store lives under the state directory, which the daemon knows only once it has taken ownership. */
function lateSecretsStore(open: () => SecretsStore | undefined): SecretsStore {
    const store = (): SecretsStore => {
        const opened = open();
        if (opened === undefined) throw new Error("the secrets store is used before the daemon prepared its files");
        return opened;
    };
    return {
        read: (key) => store().read(key),
        write: (key, secret) => store().write(key, secret),
        remove: (key) => store().remove(key),
        keys: () => store().keys(),
        removeAllExcept: (keys) => store().removeAllExcept(keys),
    };
}

function outcomeOfFailure(error: unknown): CheckOutcome {
    if (error instanceof CredentialFailure) return { kind: error.kind, message: error.message };
    return { kind: "failing", message: error instanceof Error ? error.message : "the login check failed" };
}

export async function createMailComponent(options: MailComponentOptions): Promise<MailComponent> {
    const { agents, logger } = options;
    const clock = options.clock ?? realClock;
    let secrets: SecretsStore | undefined;
    const lateStore = lateSecretsStore(() => secrets);
    const accountStatus = createAccountStatusHub({ clock });
    const accounts = createAccountsLayer({
        secrets: lateStore,
        status: accountStatus,
        endpoints: options.oauthEndpoints ?? REAL_PROVIDER_ENDPOINTS,
        clock,
    });
    const checks = new Map<string, AbortController>();
    let context: ServiceContext | undefined;

    const toolConnections = createToolConnections({
        account: (name) => context?.config.current(mailAccountSection).find((entry) => entry.name === name),
        status: (name) => accountStatus.get(MAIL_OWNER, name)?.status,
        credential: (account) => accounts.credentialFor(authOf(account), SCOPES[account.auth] ?? []),
    });

    const intake = createIntake({
        context: () => {
            if (context === undefined) throw new Error("intake runs only while the mail component is started");
            return context;
        },
        jobs: options.jobs.options,
        credential: (account) => accounts.credentialFor(authOf(account), SCOPES[account.auth] ?? []),
        clock,
        logger,
        fail: (name, message) => accountStatus.report(MAIL_OWNER, name, { kind: "failing", message }),
        // The status has no last error without a status, so the error is reported and the account is ready again.
        noteError: (name, message) => {
            accountStatus.report(MAIL_OWNER, name, { kind: "failing", message });
            accountStatus.report(MAIL_OWNER, name, { kind: "ready" });
        },
        ...(options.afterWrite && { afterWrite: options.afterWrite }),
    });

    const endCheck = (name: string): void => {
        checks.get(name)?.abort();
        checks.delete(name);
    };

    async function login(account: MailAccount, signal: AbortSignal): Promise<CheckOutcome> {
        try {
            const auth = authOf(account);
            const credential = await accounts.credentialFor(auth, SCOPES[account.auth] ?? []);
            const imap = await openImap({
                host: account.imapHost,
                port: account.imapPort,
                security: account.imapSecurity,
                credential,
                idleSeconds: account.checkIntervalSeconds,
                signal,
            });
            await imap.logout();
            if (account.kind === "owned" && account.smtpHost !== undefined && account.smtpPort !== undefined) {
                const smtp = await checkSmtpLogin({
                    host: account.smtpHost,
                    port: account.smtpPort,
                    security: account.smtpSecurity,
                    credential,
                    signal,
                });
                if (!smtp.ok) return { kind: "failing", message: smtp.message };
            }
            return { kind: "ready" };
        } catch (error) {
            logger.debug("mail login check failed", { account: account.name, cause: outcomeOfFailure(error).kind });
            return outcomeOfFailure(error);
        }
    }

    /** Runs the account's login check without waiting; the outcome goes to the hub unless the check was ended. */
    function runCheck(account: MailAccount): void {
        endCheck(account.name);
        const controller = new AbortController();
        checks.set(account.name, controller);
        void login(account, controller.signal).then((outcome) => {
            if (controller.signal.aborted) return;
            checks.delete(account.name);
            accountStatus.report(MAIL_OWNER, account.name, outcome);
            if (outcome.kind === "ready" && account.kind === "owned") intake.start(account);
        });
    }

    async function startAccount(account: MailAccount): Promise<void> {
        const needsSignIn = await accounts.needsSignIn(authOf(account));
        accountStatus.start(MAIL_OWNER, account.name, {
            checkIntervalSeconds: account.checkIntervalSeconds,
            needsSignIn,
            retry: () => runCheck(account),
        });
        if (!needsSignIn) runCheck(account);
    }

    const stopAccount = (name: string): void => {
        endCheck(name);
        void intake.stop(name);
        void toolConnections.close(name);
        accountStatus.stop(MAIL_OWNER, name);
    };

    const control: MailControl = {
        async restartAccount(name) {
            stopAccount(name);
            const account = context?.config.current(mailAccountSection).find((entry) => entry.name === name);
            if (account !== undefined) await startAccount(account);
        },
        stopAccount,
    };

    const component: DaemonComponent = {
        name: "mail",
        extensions: [createMailToolsExtension({ connections: () => toolConnections })],
        async prepareFiles({ dirs }) {
            secrets = createSecretsStore({ secretsDir: dirs.secretsDir });
            return undefined;
        },
        async checkModels(ctx) {
            agents.runtime().catalog.addReferenceSource({
                name: "mail",
                referrersOf: (role) =>
                    ctx.config
                        .current(mailAccountSection)
                        .filter((account) => account.kind === "owned" && account.triageRole === role)
                        .map((account) => account.name),
            });
        },
        async ensureWorkspaces(ctx) {
            const { catalog } = agents.runtime();
            const configured = ctx.config.current(mailAccountSection);
            for (const account of configured) {
                const { triageRole } = account;
                if (account.kind !== "owned" || triageRole === undefined || catalog.get(triageRole) !== undefined) {
                    continue;
                }
                throw new ConfigError(
                    ctx.dirs.configFile,
                    `the role "${triageRole}" does not exist`,
                    `mail_account.${account.name}.triage_role`,
                );
            }
            const notice = ctx.config.current(mailSection);
            if (notice === undefined) return;
            try {
                checkNotice(notice, configured);
            } catch (error) {
                if (!(error instanceof MailRuleError)) throw error;
                throw new ConfigError(ctx.dirs.configFile, error.reason, `mail.${error.key}`);
            }
        },
        async start(ctx) {
            context = ctx;
            const configured = ctx.config.current(mailAccountSection);
            await accounts.removeUnknownAccounts(configured.map((account) => accountKey(account.name)));
            for (const account of configured) await startAccount(account);
        },
        async stop() {
            for (const name of [...checks.keys()]) endCheck(name);
            await intake.stopAll();
            await toolConnections.closeAll();
            for (const account of accountStatus.list(MAIL_OWNER)) accountStatus.stop(MAIL_OWNER, account.name);
            context = undefined;
        },
    };

    return {
        component,
        sections: [mailSection, mailAccountSection],
        operations: mailOperations({ agents, accounts, secrets: lateStore, accountStatus, control }),
        accountStatus,
        accounts,
        control,
    };
}
