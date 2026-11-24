/**
 * The `daemon.status` operation (S-002 Status, REQ-003, REQ-011, REQ-020): the daemon's phase, versions, instance
 * directories and worker-thread capacity. It is allowed in every phase so it can report `starting` until ready.
 */
import type { AccountStatusKind, AccountStatusView } from "../accounts/account_status.ts";
import type { AdmissionSnapshot } from "../admission/admission.ts";
import type { InstanceDirs } from "../daemon/state_layout.ts";
import type { Versions } from "../host/versions.ts";
import { type DaemonPhase, defineOperation } from "./operations.ts";

export type StatusSources = {
    phase(): DaemonPhase;
    startedAt: Date;
    versions: Versions;
    dirs: InstanceDirs;
    admission(): AdmissionSnapshot;
    /** The mail accounts' status views; a daemon without an account status hub has none. */
    mailAccounts?(): AccountStatusView[];
    /** `null` until the model runtime opens and while pi agent's settings name a default model. */
    noDefaultModel?(): { piAgentDir: string } | null;
};

export type NoDefaultModelStatus = { piAgentDir: string; message: string };

export type MailAccountStatus = {
    name: string;
    status: AccountStatusKind;
    lastError?: { message: string; at: string };
    lastCheck?: string;
};

export type DaemonStatus = {
    phase: DaemonPhase;
    startedAt: string;
    versions: Versions;
    instance: { configDir: string; stateDir: string; dataDir: string; runtimeDir: string };
    workerThreads: { count: number; inUse: number; waiting: { conversationId: string; position: number }[] };
    mailAccounts: MailAccountStatus[];
    noDefaultModel: NoDefaultModelStatus | null;
};

export const statusOperation = defineOperation<{ status: StatusSources }, Record<string, never>, DaemonStatus>({
    name: "daemon.status",
    kind: "read",
    phases: ["starting", "ready", "stopping"],
    parse: () => ({}),
    async run({ status }) {
        const admission = status.admission();
        const { configDir, stateDir, dataDir, runtimeDir } = status.dirs;
        return {
            phase: status.phase(),
            startedAt: status.startedAt.toISOString(),
            versions: status.versions,
            instance: { configDir, stateDir, dataDir, runtimeDir },
            workerThreads: {
                count: admission.capacity,
                inUse: admission.active.length,
                waiting: admission.waiting,
            },
            mailAccounts: (status.mailAccounts?.() ?? []).map(mailAccountStatusOf),
            noDefaultModel: noDefaultModelStatusOf(status.noDefaultModel?.() ?? null),
        };
    },
});

function mailAccountStatusOf({ name, status, lastError, lastCheck }: AccountStatusView): MailAccountStatus {
    return {
        name,
        status,
        ...(lastError && { lastError: { message: lastError.message, at: lastError.at.toISOString() } }),
        ...(lastCheck && { lastCheck: lastCheck.toISOString() }),
    };
}

function noDefaultModelStatusOf(missing: { piAgentDir: string } | null): NoDefaultModelStatus | null {
    if (!missing) return null;
    const { piAgentDir } = missing;
    return {
        piAgentDir,
        message:
            `pi agent names no default model in ${piAgentDir}. Run \`pi\`, sign in with /login, and choose a default ` +
            "model with /model when pi asks. Roles that have their own model still run.",
    };
}
