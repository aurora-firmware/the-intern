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
};

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
