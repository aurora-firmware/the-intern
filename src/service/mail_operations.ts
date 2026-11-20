/**
 * The mail account and notice settings operations (S-009 REQ-001 to REQ-003, REQ-013): `mail.accounts.list`, `get`,
 * `create`, `change` and `remove`, and `mail.notices.get` and `set`. A write checks the rules, stores the secret it
 * carries and writes the configuration file as one step of the configuration store's queue, then starts the account
 * afresh or stops it. No result holds a secret.
 */
import type { AccountStatusHub, AccountStatusKind } from "../accounts/account_status.ts";
import type { AccountsLayer } from "../accounts/sign_in.ts";
import type { AgentsComponent } from "../agents/agents_component.ts";
import { ConfigValueError } from "../config/config_file.ts";
import { ConfigChangeRefused } from "../config/config_writer.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { accountKey, checkNotice, type MailAccount, type MailNotice, MailRuleError } from "../mail/mail_model.ts";
import { mailAccountSection, mailSection } from "../mail/mail_section.ts";
import { asRecord, requireString } from "./job_record_operations.ts";
import { defineOperation, ServiceError } from "./operations.ts";

const MAIL_OWNER = "mail";
const SECRET_KEYS = ["password", "clientSecret"] as const;

/** What the account operations need of the mail component. */
export type MailOperationsDeps = {
    agents: Pick<AgentsComponent, "runtime">;
    accounts: Pick<AccountsLayer, "setSecret" | "removeAccount">;
    accountStatus: Pick<AccountStatusHub, "get">;
    control: { restartAccount(name: string): Promise<void>; stopAccount(name: string): void };
};

/** An account's settings with its status, last error and last check; it has no field for a secret. */
export type MailAccountView = MailAccount & {
    status: AccountStatusKind;
    lastError?: { message: string; at: string };
    lastCheck?: string;
};

export type MailNoticeView = { to?: string; from?: string };

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

const hasSecrets = (secrets: Secrets): boolean => Object.keys(secrets).length > 0;

export function mailOperations({ agents, accounts, accountStatus, control }: MailOperationsDeps) {
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
    // given. A refused create takes its secret back; nothing else holds that key.
    const writeAccounts = async (
        ctx: ServiceContext,
        name: string,
        secrets: Secrets,
        isNew: boolean,
        change: (current: MailAccount[]) => MailAccount[],
    ): Promise<MailAccount> => {
        let written: MailAccount | undefined;
        let hasStoredSecret = false;
        try {
            await ctx.config.update(mailAccountSection, async (current) => {
                const next = change(current);
                written = next.find((account) => account.name === name) as MailAccount;
                checkRules(ctx, written, next);
                if (hasSecrets(secrets)) {
                    await accounts.setSecret(accountKey(name), secrets);
                    hasStoredSecret = true;
                }
                return next;
            });
        } catch (error) {
            if (isNew && hasStoredSecret) await accounts.removeAccount(accountKey(name));
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
        run: (ctx, { name, table, secrets }) =>
            mappingRefusals(async () => {
                const created = await writeAccounts(ctx, name, secrets, true, (current) => {
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
        run: (ctx, { name, table, secrets }) =>
            mappingRefusals(async () => {
                const changed = await writeAccounts(ctx, name, secrets, false, (current) => {
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
        run: ({ config }, { name }) =>
            mappingRefusals(async () => {
                await config.update(mailAccountSection, (current) => {
                    if (!current.some((candidate) => candidate.name === name)) throw missing(name);
                    if (config.current(mailSection)?.from === name) {
                        throw new ServiceError(
                            "conflict",
                            `The mail account "${name}" sends the notice mail; clear the notice settings first.`,
                        );
                    }
                    return current.filter((candidate) => candidate.name !== name);
                });
                await accounts.removeAccount(accountKey(name));
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

    return [
        listOperation,
        getOperation,
        createOperation,
        changeOperation,
        removeOperation,
        getNoticeOperation,
        setNoticeOperation,
    ];
}
