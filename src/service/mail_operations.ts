/**
 * The mail account and notice settings operations (S-009 REQ-001 to REQ-003, REQ-013): `mail.accounts.list`, `get`,
 * `create`, `change` and `remove`, and `mail.notices.get` and `set`. A write checks the rules, stores the secret it
 * carries and writes the configuration file as one step of the configuration store's queue, then starts the account
 * afresh or stops it. No result holds a secret.
 */
import type { AccountStatusHub, AccountStatusKind } from "../accounts/account_status.ts";
import type { AccountAuth, Credential } from "../accounts/providers.ts";
import type { SecretsStore } from "../accounts/secrets_store.ts";
import type { AccountsLayer, SignInStart } from "../accounts/sign_in.ts";
import type { AgentsComponent } from "../agents/agents_component.ts";
import { ConfigValueError } from "../config/config_file.ts";
import { ConfigChangeRefused } from "../config/config_writer.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { openImap } from "../mail/imap_client.ts";
import { accountKey, checkNotice, type MailAccount, type MailNotice, MailRuleError } from "../mail/mail_model.ts";
import { mailAccountSection, mailSection } from "../mail/mail_section.ts";
import { checkSmtpLogin } from "../mail/smtp_client.ts";
import { asRecord, requireString } from "./job_record_operations.ts";
import { defineOperation, ServiceError } from "./operations.ts";

const MAIL_OWNER = "mail";
const SECRET_KEYS = ["password", "clientSecret"] as const;
const CHECK_IDLE_SECONDS = 60;
const SIGN_IN_KINDS: readonly string[] = ["google", "microsoft"];

const SCOPES: Record<string, readonly string[]> = {
    google: ["https://mail.google.com/"],
    microsoft: [
        "offline_access",
        "https://outlook.office.com/IMAP.AccessAsUser.All",
        "https://outlook.office.com/SMTP.Send",
    ],
    microsoft_app: ["https://outlook.office365.com/.default"],
};

/** What the account operations need of the mail component. */
export type MailOperationsDeps = {
    agents: Pick<AgentsComponent, "runtime">;
    accounts: Pick<AccountsLayer, "setSecret" | "removeAccount" | "credentialFor" | "startSignIn">;
    /** The store the secrets are kept in; a refused write puts back what it held before the call. */
    secrets: Pick<SecretsStore, "read" | "write">;
    accountStatus: Pick<AccountStatusHub, "get" | "report">;
    control: { restartAccount(name: string): Promise<void>; stopAccount(name: string): void };
};

/** An account's settings with its status, last error and last check; it has no field for a secret. */
export type MailAccountView = MailAccount & {
    status: AccountStatusKind;
    lastError?: { message: string; at: string };
    lastCheck?: string;
};

export type MailNoticeView = { to?: string; from?: string };

/** One server's answer to a login check: `message` is the server's own words when it refused. */
export type ServerCheck = { ok: boolean; message?: string };
export type MailTestResult = { imap: ServerCheck; smtp?: ServerCheck };

type Secrets = { password?: string; clientSecret?: string };
type Change = { name: string; table: Record<string, unknown>; secrets: Secrets };

function nonEmptySecret(record: Record<string, unknown>, key: (typeof SECRET_KEYS)[number]): string | undefined {
    const value = record[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string" || value === "") throw new Error(`${key} must be a non-empty string`);
    return value;
}

function parseWrite(raw: unknown): Change {
    const { password, clientSecret, ...table } = asRecord(raw);
    const secrets: Secrets = {};
    const given = { password, clientSecret };
    for (const key of SECRET_KEYS) {
        const value = nonEmptySecret(given, key);
        if (value !== undefined) secrets[key] = value;
    }
    return { name: requireString(table, "name"), table, secrets };
}

const parseName = (raw: unknown): { name: string } => ({ name: requireString(asRecord(raw), "name") });

async function mappingRefusals<T>(action: () => Promise<T>): Promise<T> {
    try {
        return await action();
    } catch (error) {
        if (error instanceof ConfigValueError || error instanceof MailRuleError) {
            throw new ServiceError("invalid_input", error.message);
        }
        if (error instanceof ConfigChangeRefused) {
            const codes = { invalid: "invalid_input", conflict: "conflict", write_failed: "internal" } as const;
            throw new ServiceError(codes[error.kind], error.message);
        }
        throw error;
    }
}

// The section's own parser applies every rule of REQ-001, unknown keys included, to the table of one account.
const parseAccount = (table: Record<string, unknown>): MailAccount =>
    mailAccountSection.parse([table])[0] as MailAccount;

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

const hasSmtp = (account: MailAccount): boolean =>
    account.kind === "owned" && account.smtpHost !== undefined && account.smtpPort !== undefined;

const failureMessage = (error: unknown): string =>
    error instanceof Error && error.message !== "" ? error.message : "the login failed";

const hasSecrets = (secrets: Secrets): boolean => Object.keys(secrets).length > 0;

export function mailOperations({ agents, accounts, secrets, accountStatus, control }: MailOperationsDeps) {
    const missing = (name: string) => new ServiceError("not_found", `There is no mail account named "${name}".`);

    const view = (account: MailAccount): MailAccountView => {
        const state = accountStatus.get(MAIL_OWNER, account.name);
        return {
            ...account,
            status: state?.status ?? "connecting",
            ...(state?.lastError && {
                lastError: { message: state.lastError.message, at: state.lastError.at.toISOString() },
            }),
            ...(state?.lastCheck && { lastCheck: state.lastCheck.toISOString() }),
        };
    };

    const checkRules = (ctx: ServiceContext, account: MailAccount, next: MailAccount[]): void => {
        const { triageRole } = account;
        if (triageRole !== undefined && agents.runtime().catalog.get(triageRole) === undefined) {
            throw new ServiceError(
                "invalid_input",
                `triage_role: account ${account.name}: the role "${triageRole}" does not exist.`,
            );
        }
        const notice = ctx.config.current(mailSection);
        if (notice !== undefined) checkNotice(notice, next);
    };

    // The secret goes to the store before the file is written, so a stored account never lacks the secret it was
    // given. The store's fingerprint check comes after this step, so a refused write puts the old secret back.
    const writeAccounts = async (
        ctx: ServiceContext,
        name: string,
        newSecrets: Secrets,
        change: (current: MailAccount[]) => MailAccount[],
    ): Promise<MailAccount> => {
        const key = accountKey(name);
        let written: MailAccount | undefined;
        let hasStoredSecret = false;
        let previous: Awaited<ReturnType<typeof secrets.read>>;
        try {
            await ctx.config.update(mailAccountSection, async (current) => {
                const next = change(current);
                written = next.find((account) => account.name === name) as MailAccount;
                checkRules(ctx, written, next);
                if (hasSecrets(newSecrets)) {
                    previous = await secrets.read(key);
                    hasStoredSecret = true;
                    await accounts.setSecret(key, newSecrets);
                }
                return next;
            });
        } catch (error) {
            if (hasStoredSecret) {
                if (previous === undefined) await accounts.removeAccount(key);
                else await secrets.write(key, previous);
            }
            throw error;
        }
        await control.restartAccount(name);
        return written as MailAccount;
    };

    const listOperation = defineOperation<ServiceContext, Record<string, never>, { accounts: MailAccountView[] }>({
        name: "mail.accounts.list",
        kind: "read",
        parse: () => ({}),
        run: async ({ config }) => ({ accounts: config.current(mailAccountSection).map(view) }),
    });

    const getOperation = defineOperation<ServiceContext, { name: string }, { account: MailAccountView }>({
        name: "mail.accounts.get",
        kind: "read",
        parse: parseName,
        run: async ({ config }, { name }) => {
            const account = config.current(mailAccountSection).find((candidate) => candidate.name === name);
            if (account === undefined) throw missing(name);
            return { account: view(account) };
        },
    });

    const createOperation = defineOperation<ServiceContext, Change, { account: MailAccountView }>({
        name: "mail.accounts.create",
        kind: "control",
        parse: parseWrite,
        run: (ctx, { name, table, secrets: newSecrets }) =>
            mappingRefusals(async () => {
                const created = await writeAccounts(ctx, name, newSecrets, (current) => {
                    const account = parseAccount(table);
                    if (current.some((candidate) => candidate.name === account.name)) {
                        throw new ServiceError("conflict", `There is already a mail account named "${account.name}".`);
                    }
                    return [...current, account];
                });
                return { account: view(created) };
            }),
    });

    // A value absent from the change stays; `null` removes an optional key, so the rules decide what that leaves.
    const mergeChange = (account: MailAccount, table: Record<string, unknown>): Record<string, unknown> => {
        const merged = { ...(mailAccountSection.serialize([account]) as Record<string, unknown>[])[0] };
        for (const [key, value] of Object.entries(table)) {
            if (key === "kind" && value !== account.kind) {
                throw new ServiceError("invalid_input", `kind: account ${account.name}: it can't be changed.`);
            }
            if (value === null) delete merged[key];
            else if (value !== undefined) merged[key] = value;
        }
        return merged;
    };

    const changeOperation = defineOperation<ServiceContext, Change, { account: MailAccountView }>({
        name: "mail.accounts.change",
        kind: "control",
        parse: parseWrite,
        run: (ctx, { name, table, secrets: newSecrets }) =>
            mappingRefusals(async () => {
                const changed = await writeAccounts(ctx, name, newSecrets, (current) => {
                    const account = current.find((candidate) => candidate.name === name);
                    if (account === undefined) throw missing(name);
                    const next = parseAccount(mergeChange(account, table));
                    return current.map((candidate) => (candidate === account ? next : candidate));
                });
                return { account: view(changed) };
            }),
    });

    const removeOperation = defineOperation<ServiceContext, { name: string }, Record<string, never>>({
        name: "mail.accounts.remove",
        kind: "control",
        parse: parseName,
        run: ({ config, jobStore }, { name }) =>
            mappingRefusals(async () => {
                let address = name;
                await config.update(mailAccountSection, (current) => {
                    const removed = current.find((candidate) => candidate.name === name);
                    if (removed === undefined) throw missing(name);
                    address = removed.address;
                    if (config.current(mailSection)?.from === name) {
                        throw new ServiceError(
                            "conflict",
                            `The mail account "${name}" sends the notice mail; clear the notice settings first.`,
                        );
                    }
                    return current.filter((candidate) => candidate.name !== name);
                });
                await accounts.removeAccount(accountKey(name));
                // The sender only takes `owed` rows, so an account added again under the name never sends these.
                await jobStore.writeMail((tx) => tx.markAccountRemoved(name, address));
                control.stopAccount(name);
                return {};
            }),
    });

    const noticeView = (notice: MailNotice | undefined): MailNoticeView =>
        notice === undefined ? {} : { to: notice.to, from: notice.from };

    const getNoticeOperation = defineOperation<ServiceContext, Record<string, never>, { notice: MailNoticeView }>({
        name: "mail.notices.get",
        kind: "read",
        parse: () => ({}),
        run: async ({ config }) => ({ notice: noticeView(config.current(mailSection)) }),
    });

    const setNoticeOperation = defineOperation<ServiceContext, MailNoticeView, { notice: MailNoticeView }>({
        name: "mail.notices.set",
        kind: "control",
        parse: (raw) => {
            const { to, from } = asRecord(raw);
            if ((to === undefined) !== (from === undefined)) throw new Error("to and from are given together");
            if (to === undefined) return {};
            return { to: requireString({ to }, "to"), from: requireString({ from }, "from") };
        },
        run: ({ config }, { to, from }) =>
            mappingRefusals(async () => {
                const notice = to === undefined || from === undefined ? undefined : { to, from };
                await config.update(mailSection, () => {
                    if (notice !== undefined) checkNotice(notice, config.current(mailAccountSection));
                    return notice;
                });
                return { notice: noticeView(notice) };
            }),
    });

    const checkImap = async (account: MailAccount, credential: Credential): Promise<ServerCheck> => {
        try {
            const imap = await openImap({
                host: account.imapHost,
                port: account.imapPort,
                security: account.imapSecurity,
                credential,
                idleSeconds: CHECK_IDLE_SECONDS,
            });
            await imap.logout();
            return { ok: true };
        } catch (error) {
            return { ok: false, message: failureMessage(error) };
        }
    };

    const checkSmtp = async (account: MailAccount, credential: Credential): Promise<ServerCheck | undefined> => {
        if (!hasSmtp(account)) return undefined;
        return checkSmtpLogin({
            host: account.smtpHost as string,
            port: account.smtpPort as number,
            security: account.smtpSecurity,
            credential,
        });
    };

    const testOperation = defineOperation<ServiceContext, { name: string }, MailTestResult>({
        name: "mail.accounts.test",
        kind: "control",
        parse: parseName,
        run: async ({ config }, { name }) => {
            const account = config.current(mailAccountSection).find((candidate) => candidate.name === name);
            if (account === undefined) throw missing(name);
            let credential: Credential;
            try {
                credential = await accounts.credentialFor(authOf(account), SCOPES[account.auth] ?? []);
            } catch (error) {
                const failed = { ok: false, message: failureMessage(error) };
                return { imap: failed, ...(hasSmtp(account) && { smtp: failed }) };
            }
            const smtp = await checkSmtp(account, credential);
            return { imap: await checkImap(account, credential), ...(smtp !== undefined && { smtp }) };
        },
    });

    const signInOperation = defineOperation<ServiceContext, { name: string }, SignInStart>({
        name: "mail.accounts.signin",
        kind: "control",
        parse: parseName,
        run: async ({ config }, { name }) => {
            const account = config.current(mailAccountSection).find((candidate) => candidate.name === name);
            if (account === undefined) throw missing(name);
            if (!SIGN_IN_KINDS.includes(account.auth)) {
                throw new ServiceError(
                    "invalid_input",
                    `The mail account "${name}" uses auth ${account.auth}, which has no sign-in.`,
                );
            }
            return accounts.startSignIn(authOf(account), SCOPES[account.auth] ?? [], () => {
                // Nobody awaits the callback, so a failed restart goes to the account's status, where the team member sees it.
                control.restartAccount(name).catch((error: unknown) => {
                    accountStatus.report(MAIL_OWNER, name, { kind: "failing", message: failureMessage(error) });
                });
            });
        },
    });

    return [
        listOperation,
        getOperation,
        createOperation,
        changeOperation,
        removeOperation,
        getNoticeOperation,
        setNoticeOperation,
        testOperation,
        signInOperation,
    ];
}
