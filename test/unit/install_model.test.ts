import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    checkPlatform,
    compareVersions,
    confirmation,
    decideRollback,
    decideUpgrade,
    parseVersion,
    type RollbackFacts,
    type UpgradeFacts,
    type Version,
} from "../../src/install/install_model.ts";

function version(text: string): Version {
    const parsed = parseVersion(text);
    assert.ok(parsed, `${text} parses`);
    return parsed;
}

describe("version order", () => {
    it("orders 0.1.0, 0.2.0-rc.1, 0.2.0 and 0.10.0 by meaning, not by text", () => {
        const ordered = ["0.1.0", "0.2.0-rc.1", "0.2.0", "0.10.0"];
        for (let index = 0; index < ordered.length - 1; index++) {
            assert.ok(compareVersions(version(ordered[index]), version(ordered[index + 1])) < 0, ordered[index]);
            assert.ok(compareVersions(version(ordered[index + 1]), version(ordered[index])) > 0, ordered[index]);
        }
    });

    it("compares equal versions as zero", () => {
        assert.equal(compareVersions(version("1.2.3"), version("1.2.3")), 0);
        assert.equal(compareVersions(version("1.2.3-rc.1"), version("1.2.3-rc.1")), 0);
    });

    it("orders pre-release parts by identifier, numbers numerically", () => {
        assert.ok(compareVersions(version("1.0.0-rc.2"), version("1.0.0-rc.10")) < 0);
        assert.ok(compareVersions(version("1.0.0-alpha"), version("1.0.0-beta")) < 0);
        assert.ok(compareVersions(version("1.0.0-rc"), version("1.0.0-rc.1")) < 0);
        assert.ok(compareVersions(version("1.0.0-1"), version("1.0.0-alpha")) < 0);
    });

    it("parses nothing that isn't X.Y.Z with an optional pre-release part", () => {
        for (const text of ["", "1", "1.2", "1.2.3.4", "v1.2.3", "1.2.x", "01.2.3", "1.2.3-", "1.2.3-a..b", "1.2.3 "]) {
            assert.equal(parseVersion(text), undefined, JSON.stringify(text));
        }
    });
});

describe("the platform check", () => {
    const linux = { platform: "linux", arch: "x64", hasGlibc: true, hasSystemd: true, uid: 1000 };
    const mac = { platform: "darwin", arch: "arm64", hasGlibc: false, hasSystemd: false, uid: 501 };

    it("accepts Linux x64 with glibc and systemd, and macOS arm64", () => {
        assert.deepEqual(checkPlatform(linux), { ok: true, platform: "linux-x64" });
        assert.deepEqual(checkPlatform(mac), { ok: true, platform: "darwin-arm64" });
    });

    it("refuses every other platform, naming the case", () => {
        const refused = [
            { facts: { ...linux, arch: "arm64" }, reason: /arm64/ },
            { facts: { ...linux, hasGlibc: false }, reason: /glibc/ },
            { facts: { ...linux, hasSystemd: false }, reason: /systemd/ },
            { facts: { ...mac, arch: "x64" }, reason: /x64/ },
            { facts: { ...linux, platform: "win32" }, reason: /win32/ },
        ];
        for (const { facts, reason } of refused) {
            const result = checkPlatform(facts);
            assert.equal(result.ok, false);
            assert.match(result.ok ? "" : result.reason, reason);
        }
    });

    it("refuses root on either platform", () => {
        for (const facts of [linux, mac]) {
            const result = checkPlatform({ ...facts, uid: 0 });
            assert.equal(result.ok, false);
            assert.match(result.ok ? "" : result.reason, /root/);
        }
    });
});

describe("the upgrade decision", () => {
    const facts: UpgradeFacts = {
        hasServiceFile: true,
        serviceLabel: "bob.intern",
        ownerLockPid: undefined,
        startupReport: undefined,
        currentVersion: version("0.2.0"),
        askedVersion: version("0.3.0"),
    };

    it("proceeds to a newer version with no daemon running", () => {
        assert.deepEqual(decideUpgrade(facts), { kind: "proceed" });
    });

    it("proceeds when the owner lock's pid is named by a report with the service's label", () => {
        const owned = { ...facts, ownerLockPid: 42, startupReport: { pid: 42, label: "bob.intern" } };
        assert.deepEqual(decideUpgrade(owned), { kind: "proceed" });
    });

    it("says already for the current version", () => {
        assert.deepEqual(decideUpgrade({ ...facts, askedVersion: version("0.2.0") }), { kind: "already" });
    });

    it("refuses an older version and points to bob rollback", () => {
        const decision = decideUpgrade({ ...facts, askedVersion: version("0.1.0") });
        assert.equal(decision.kind, "refuse");
        assert.match(decision.kind === "refuse" ? decision.reason : "", /older.*bob rollback/);
    });

    it("refuses when the service isn't registered", () => {
        const decision = decideUpgrade({ ...facts, hasServiceFile: false });
        assert.equal(decision.kind, "refuse");
        assert.match(decision.kind === "refuse" ? decision.reason : "", /not registered/);
    });

    it("refuses a daemon the service didn't start: no report, another pid, or another label", () => {
        const foreign: UpgradeFacts[] = [
            { ...facts, ownerLockPid: 42 },
            { ...facts, ownerLockPid: 42, startupReport: { pid: 41, label: "bob.intern" } },
            { ...facts, ownerLockPid: 42, startupReport: { pid: 42, label: undefined } },
            { ...facts, ownerLockPid: 42, startupReport: { pid: 42, label: "other" } },
        ];
        for (const each of foreign) {
            const decision = decideUpgrade(each);
            assert.equal(decision.kind, "refuse");
            assert.match(decision.kind === "refuse" ? decision.reason : "", /service didn't start/);
        }
    });

    it("refuses a missing service even when the version is the current one", () => {
        const decision = decideUpgrade({ ...facts, hasServiceFile: false, askedVersion: version("0.2.0") });
        assert.equal(decision.kind, "refuse");
    });
});

describe("the rollback decision", () => {
    const facts: RollbackFacts = {
        previousVersion: version("0.1.0"),
        currentVersion: version("0.2.0"),
        copy: { from: "0.1.0", to: "0.2.0" },
        isStdinTerminal: true,
        yes: false,
    };

    it("proceeds with a previous version, its copy and a terminal", () => {
        assert.deepEqual(decideRollback(facts), { kind: "proceed" });
    });

    it("proceeds without a terminal when --yes is given", () => {
        assert.deepEqual(decideRollback({ ...facts, isStdinTerminal: false, yes: true }), { kind: "proceed" });
    });

    it("refuses without a previous version", () => {
        const decision = decideRollback({ ...facts, previousVersion: undefined });
        assert.equal(decision.kind, "refuse");
        assert.match(decision.kind === "refuse" ? decision.reason : "", /no previous version/);
    });

    it("refuses without a copy, and with a copy for other versions", () => {
        const copies = [undefined, { from: "0.0.9", to: "0.2.0" }, { from: "0.1.0", to: "0.3.0" }];
        for (const copy of copies) {
            const decision = decideRollback({ ...facts, copy });
            assert.equal(decision.kind, "refuse");
            assert.match(decision.kind === "refuse" ? decision.reason : "", /pre-upgrade copy/);
        }
    });

    it("refuses with no terminal and no --yes", () => {
        const decision = decideRollback({ ...facts, isStdinTerminal: false });
        assert.equal(decision.kind, "refuse");
        assert.match(decision.kind === "refuse" ? decision.reason : "", /--yes/);
    });
});

describe("the confirmation", () => {
    it("skips with --yes, with or without a terminal", () => {
        assert.equal(confirmation({ yes: true, isStdinTerminal: true }), "skip");
        assert.equal(confirmation({ yes: true, isStdinTerminal: false }), "skip");
    });

    it("asks on a terminal", () => {
        assert.equal(confirmation({ yes: false, isStdinTerminal: true }), "ask");
    });

    it("counts no terminal and no --yes as declined", () => {
        assert.equal(confirmation({ yes: false, isStdinTerminal: false }), "declined");
    });
});
