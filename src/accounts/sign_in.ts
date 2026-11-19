/**
 * The accounts layer (ADR-010 decision 1): every login asks it for a credential. It reads and writes the secrets store
 * and runs a password command; it knows no mail library.
 */
import { execFile } from "node:child_process";
import type { AccountClock, AccountStatusHub } from "./account_status.ts";
import { accessTokenFor, SignInNeededError } from "./oauth.ts";
import type { AccountAuth, Credential, ProviderEndpoints } from "./providers.ts";
import type { AccountSecret, SecretsStore } from "./secrets_store.ts";

const PASSWORD_COMMAND_TIMEOUT_MS = 30_000;
const PASSWORD_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;

export type CredentialFailureKind = "failing" | "needs_sign_in";

/** A login could not get its credential. The message never holds a command's output or a secret. */
export class CredentialFailure extends Error {
    kind: CredentialFailureKind;

    constructor(kind: CredentialFailureKind, message: string) {
        super(message);
        this.name = "CredentialFailure";
        this.kind = kind;
    }
}

export type AccountsLayerOptions = {
    secrets: SecretsStore;
    status: AccountStatusHub;
    endpoints: ProviderEndpoints;
    clock: AccountClock;
    /** The time a password command may run; 30 seconds unless a test shortens it. */
    passwordCommandTimeoutMs?: number;
};

export type AccountsLayer = {
    credentialFor(auth: AccountAuth, scopes: readonly string[]): Promise<Credential>;
    /** True when the auth needs a secret the store lacks. */
    needsSignIn(auth: AccountAuth): Promise<boolean>;
    setSecret(key: string, values: { password?: string; clientSecret?: string }): Promise<void>;
    removeAccount(key: string): Promise<void>;
    removeUnknownAccounts(keys: readonly string[]): Promise<void>;
    status: AccountStatusHub;
};

export function createAccountsLayer(options: AccountsLayerOptions): AccountsLayer {
    const { secrets, status, endpoints, clock } = options;
    const timeoutMs = options.passwordCommandTimeoutMs ?? PASSWORD_COMMAND_TIMEOUT_MS;

    async function credentialFor(auth: AccountAuth, scopes: readonly string[]): Promise<Credential> {
        switch (auth.kind) {
            case "password": {
                const password = (await secrets.read(auth.key))?.password;
                if (password === undefined) {
                    throw new CredentialFailure("needs_sign_in", `Account ${auth.key} has no stored password.`);
                }
                return { user: auth.login, password };
            }
            case "password_command":
                return { user: auth.login, password: await runPasswordCommand(auth, timeoutMs) };
            default:
                return { user: auth.login, accessToken: await oauthToken(auth, scopes) };
        }
    }

    async function oauthToken(auth: AccountAuth, scopes: readonly string[]): Promise<string> {
        try {
            return await accessTokenFor({ auth, scopes, secrets, endpoints, now: () => clock.now() });
        } catch (error) {
            if (error instanceof SignInNeededError) throw new CredentialFailure("needs_sign_in", error.message);
            const message = error instanceof Error ? error.message : `Account ${auth.key}: the sign-in failed.`;
            throw new CredentialFailure("failing", message);
        }
    }

    return {
        credentialFor,
        async needsSignIn(auth) {
            const secret: AccountSecret = (await secrets.read(auth.key)) ?? {};
            switch (auth.kind) {
                case "password":
                    return secret.password === undefined;
                case "password_command":
                    return false;
                case "microsoft_app":
                    return secret.clientSecret === undefined;
                default:
                    return secret.refreshToken === undefined;
            }
        },
        async setSecret(key, values) {
            const current = (await secrets.read(key)) ?? {};
            await secrets.write(key, { ...current, ...values });
        },
        removeAccount: (key) => secrets.remove(key),
        removeUnknownAccounts: (keys) => secrets.removeAllExcept(keys),
        status,
    };
}

// A failure names the exit status or the limit, never the command's output: the output is the password.
function runPasswordCommand(auth: AccountAuth, timeoutMs: number): Promise<string> {
    const [program, ...args] = auth.passwordCommand ?? [];
    if (program === undefined) {
        return Promise.reject(new CredentialFailure("failing", `Account ${auth.key} has no password command.`));
    }
    const prefix = `Account ${auth.key}: the password command`;
    return new Promise((resolve, reject) => {
        execFile(
            program,
            args,
            { timeout: timeoutMs, maxBuffer: PASSWORD_COMMAND_MAX_OUTPUT_BYTES, encoding: "buffer" },
            (error, stdout) => {
                if (error !== null) {
                    reject(new CredentialFailure("failing", `${prefix} ${describeFailure(error, timeoutMs)}.`));
                    return;
                }
                const password = withoutTrailingLineEnd(stdout.toString("utf8"));
                if (password === "") {
                    reject(new CredentialFailure("failing", `${prefix} printed nothing.`));
                    return;
                }
                resolve(password);
            },
        );
    });
}

function describeFailure(
    error: NodeJS.ErrnoException & { killed?: boolean; signal?: string | null },
    timeoutMs: number,
) {
    if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") return "printed over the 64 KiB limit";
    if (error.killed === true && typeof error.signal === "string") {
        return `ran over the time limit of ${timeoutMs / 1000} seconds`;
    }
    if (typeof error.code === "number") return `exited with status ${error.code}`;
    if (typeof error.signal === "string") return `ended on signal ${error.signal}`;
    return `could not be started (${error.code ?? "an unexpected error"})`;
}

function withoutTrailingLineEnd(text: string): string {
    if (text.endsWith("\r\n")) return text.slice(0, -2);
    if (text.endsWith("\n")) return text.slice(0, -1);
    return text;
}
