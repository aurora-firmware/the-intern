/**
 * The ready wait (S-010 REQ-015): `daemon.status` through the client library over the registration's runtime
 * directory, until the daemon reports ready or 60 seconds pass. It imports the client library, not the host, a pi
 * package or the service layer (ADR-005 decision 2).
 */
import { createClient } from "../client/client.ts";
import { nodeTransport } from "../client/node_transport.ts";
import { readStartupReport, type StartupReport } from "../daemon/startup_report.ts";
import { localSocketPath } from "../daemon/state_layout.ts";
import type { ServiceRecord } from "./service_manager.ts";

export const READY_WAIT_MS = 60_000;

const POLL_INTERVAL_MS = 250;

/** What a probe learned from one `daemon.status` call: the phase and the daemon's version. */
export type DaemonAnswer = { phase: string; version: string };

/** Asks the daemon of the record for its status once; null when it can't be reached or doesn't answer. */
export type StatusProbe = (record: ServiceRecord) => Promise<DaemonAnswer | null>;

export type ReadyWaitResult = { ready: true; version: string } | { ready: false; report: StartupReport | undefined };

type StatusAnswer = { phase: string; versions: { intern: string } };

/** One `daemon.status` call over the local socket in the record's runtime directory. */
export const probeDaemonStatus: StatusProbe = async (record) => {
    const client = createClient(nodeTransport({ socketPath: localSocketPath(record.runtimeDir) }));
    try {
        const status = (await client.invoke("daemon.status", {})) as StatusAnswer;
        return { phase: status.phase, version: status.versions.intern };
    } catch {
        // The daemon is down, restarting or not yet listening: the caller decides what that means.
        return null;
    }
};

function pause(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The probe's answer, or null once `ms` pass: a daemon that accepts the call and never answers can't outlast the wait. */
async function probeWithin(probe: StatusProbe, record: ServiceRecord, ms: number): Promise<DaemonAnswer | null> {
    let timer: NodeJS.Timeout | undefined;
    const expiry = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), ms);
    });
    try {
        return await Promise.race([probe(record).catch(() => null), expiry]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Polls the daemon until its phase is `ready`, whatever the supervisor's restarts do in between. After the timeout it
 * returns the startup report the state directory holds, for the caller to classify.
 */
export async function waitForReady(
    record: ServiceRecord,
    options: { timeoutMs?: number; probe?: StatusProbe } = {},
): Promise<ReadyWaitResult> {
    const { timeoutMs = READY_WAIT_MS, probe = probeDaemonStatus } = options;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const answer = await probeWithin(probe, record, Math.max(deadline - Date.now(), 0));
        if (answer?.phase === "ready") return { ready: true, version: answer.version };
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await pause(Math.min(POLL_INTERVAL_MS, remaining));
    }
    return { ready: false, report: await readStartupReport(record.stateDir) };
}

/** The version of the daemon that answers, or null when none does. */
export async function readRunningVersion(record: ServiceRecord): Promise<string | null> {
    return (await probeDaemonStatus(record))?.version ?? null;
}
