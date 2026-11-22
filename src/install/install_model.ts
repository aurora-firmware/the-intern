/**
 * The decisions of the installation commands (S-010), kept pure: this module imports nothing, so version order, the
 * platform check, the refusals and the confirmation are tested without a machine (architecture.md, Module rule,
 * Installation). The commands gather the facts and act on the decision.
 */

export type Version = {
    major: number;
    minor: number;
    patch: number;
    /** The dot-separated pre-release identifiers; empty for a release. */
    preRelease: string[];
};

const VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const NUMERIC_IDENTIFIER = /^\d+$/;

/** Reads `X.Y.Z` with an optional `-pre.release` part; anything else is undefined. */
export function parseVersion(text: string): Version | undefined {
    const match = VERSION_PATTERN.exec(text);
    if (match === null) return undefined;
    return {
        major: Number(match[1]),
        minor: Number(match[2]),
        patch: Number(match[3]),
        preRelease: match[4] === undefined ? [] : match[4].split("."),
    };
}

function compareIdentifiers(a: string, b: string): number {
    const isNumericA = NUMERIC_IDENTIFIER.test(a);
    const isNumericB = NUMERIC_IDENTIFIER.test(b);
    if (isNumericA && isNumericB) return Math.sign(Number(a) - Number(b));
    if (isNumericA) return -1;
    if (isNumericB) return 1;
    return a < b ? -1 : a > b ? 1 : 0;
}

function comparePreRelease(a: string[], b: string[]): number {
    if (a.length === 0 || b.length === 0) return Math.sign(b.length - a.length);
    for (let index = 0; index < Math.min(a.length, b.length); index++) {
        const result = compareIdentifiers(a[index], b[index]);
        if (result !== 0) return result;
    }
    return Math.sign(a.length - b.length);
}

/** Semantic order: negative when `a` is older than `b`, positive when newer, zero when equal. */
export function compareVersions(a: Version, b: Version): number {
    return (
        Math.sign(a.major - b.major) ||
        Math.sign(a.minor - b.minor) ||
        Math.sign(a.patch - b.patch) ||
        comparePreRelease(a.preRelease, b.preRelease)
    );
}

export type PlatformFacts = {
    platform: string;
    arch: string;
    hasGlibc: boolean;
    hasSystemd: boolean;
    uid: number;
};

export type PlatformCheck = { ok: true; platform: "linux-x64" | "darwin-arm64" } | { ok: false; reason: string };

/** The install script's rules (S-010 REQ-003): Linux x64 with glibc and systemd, macOS arm64, never root. */
export function checkPlatform(facts: PlatformFacts): PlatformCheck {
    if (facts.uid === 0) return { ok: false, reason: "run as a regular user, not root" };
    if (facts.platform === "linux") {
        if (facts.arch !== "x64") return { ok: false, reason: `Linux ${facts.arch} isn't supported; only Linux x64` };
        if (!facts.hasGlibc) return { ok: false, reason: "Linux without glibc isn't supported" };
        if (!facts.hasSystemd) return { ok: false, reason: "Linux without systemd isn't supported" };
        return { ok: true, platform: "linux-x64" };
    }
    if (facts.platform === "darwin") {
        if (facts.arch !== "arm64")
            return { ok: false, reason: `macOS ${facts.arch} isn't supported; only macOS arm64` };
        return { ok: true, platform: "darwin-arm64" };
    }
    return { ok: false, reason: `${facts.platform} isn't supported; only Linux x64 and macOS arm64` };
}

export type UpgradeFacts = {
    /** Whether `service.json` exists, so the service is registered. */
    hasServiceFile: boolean;
    /** The label the registration holds. */
    serviceLabel: string;
    /** The pid in the owner lock, when a daemon owns the instance. */
    ownerLockPid: number | undefined;
    /** The startup report's pid and the label it carries, when there is one (ADR-012 decision 6). */
    startupReport: { pid: number; label: string | undefined } | undefined;
    currentVersion: Version;
    askedVersion: Version;
};

export type UpgradeDecision = { kind: "refuse"; reason: string } | { kind: "already" } | { kind: "proceed" };

/** S-010 REQ-006's refusals and its "already" case. A second upgrade or rollback is refused by `install.lock`. */
export function decideUpgrade(facts: UpgradeFacts): UpgradeDecision {
    if (!facts.hasServiceFile) {
        return { kind: "refuse", reason: "the service is not registered; run `bob service install` first" };
    }
    if (facts.ownerLockPid !== undefined) {
        const report = facts.startupReport;
        if (report === undefined || report.pid !== facts.ownerLockPid || report.label !== facts.serviceLabel) {
            return {
                kind: "refuse",
                reason: `a daemon the service didn't start (pid ${facts.ownerLockPid}) owns the instance`,
            };
        }
    }
    const order = compareVersions(facts.askedVersion, facts.currentVersion);
    if (order === 0) return { kind: "already" };
    if (order < 0) {
        return { kind: "refuse", reason: "the asked version is older than the current one; use `bob rollback`" };
    }
    return { kind: "proceed" };
}

export type RollbackFacts = {
    previousVersion: Version | undefined;
    currentVersion: Version;
    /** The latest pre-upgrade copy's `from` and `to` versions, when there is one. */
    copy: { from: string; to: string } | undefined;
    isStdinTerminal: boolean;
    yes: boolean;
};

export type RollbackDecision = { kind: "refuse"; reason: string } | { kind: "proceed" };

function formatVersion(version: Version): string {
    const core = `${version.major}.${version.minor}.${version.patch}`;
    return version.preRelease.length === 0 ? core : `${core}-${version.preRelease.join(".")}`;
}

/** S-010 REQ-009's refusals, with nothing changed. */
export function decideRollback(facts: RollbackFacts): RollbackDecision {
    if (facts.previousVersion === undefined) {
        return { kind: "refuse", reason: "there is no previous version to go back to" };
    }
    const { copy } = facts;
    if (
        copy === undefined ||
        copy.from !== formatVersion(facts.previousVersion) ||
        copy.to !== formatVersion(facts.currentVersion)
    ) {
        return { kind: "refuse", reason: "there is no pre-upgrade copy for the previous version" };
    }
    if (confirmation({ yes: facts.yes, isStdinTerminal: facts.isStdinTerminal }) === "declined") {
        return { kind: "refuse", reason: "standard input isn't a terminal; give --yes to confirm" };
    }
    return { kind: "proceed" };
}

/** `--yes` skips the question, a terminal asks it, and neither counts as declined: nothing changes, exit 1. */
export function confirmation(options: { yes: boolean; isStdinTerminal: boolean }): "skip" | "ask" | "declined" {
    if (options.yes) return "skip";
    return options.isStdinTerminal ? "ask" : "declined";
}
