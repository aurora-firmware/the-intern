import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { scaled } from "../support/time_scale.ts";

const SCRIPT = join(import.meta.dirname, "..", "..", "release", "install.sh");

const hasDash = spawnSync("dash", ["-c", "exit 0"]).error === undefined;
if (!hasDash) {
    console.warn("install_script.test: dash is not installed, so the dash cases are skipped");
}

const SHELLS: { name: string; skip: boolean }[] = [
    { name: "sh", skip: false },
    { name: "dash", skip: !hasDash },
];

interface Run {
    status: number | null;
    stdout: string;
    stderr: string;
}

function callCheck(shell: string, fn: string, ...args: string[]): Run {
    const result = spawnSync(shell, ["-c", '. "$1"; shift; "$@"', "sh", SCRIPT, fn, ...args], {
        encoding: "utf8",
        env: { ...process.env, BOB_INSTALL_LIB: "1" },
        timeout: scaled(10000),
    });
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

for (const shell of SHELLS) {
    describe(`install script platform checks under ${shell.name}`, { skip: shell.skip }, () => {
        const accepted: [string, string[]][] = [
            ["Linux x86_64 with glibc and systemd", ["Linux", "x86_64", "glibc 2.36", "yes"]],
            ["Darwin arm64", ["Darwin", "arm64", "", "no"]],
        ];
        for (const [label, facts] of accepted) {
            it(`accepts ${label}`, () => {
                const run = callCheck(shell.name, "check_platform", ...facts);
                assert.equal(run.status, 0, run.stderr);
            });
        }

        const refused: [string, string[], RegExp][] = [
            ["an Intel Mac", ["Darwin", "x86_64", "", "no"], /Intel Mac/],
            ["Linux on ARM", ["Linux", "aarch64", "glibc 2.36", "yes"], /ARM/],
            ["a musl C library", ["Linux", "x86_64", "", "yes"], /musl|glibc/],
            ["Linux without systemd", ["Linux", "x86_64", "glibc 2.36", "no"], /systemd/],
            ["any other system", ["FreeBSD", "amd64", "", "no"], /FreeBSD/],
        ];
        for (const [label, facts, reason] of refused) {
            it(`refuses ${label} naming the reason`, () => {
                const run = callCheck(shell.name, "check_platform", ...facts);
                assert.equal(run.status, 1);
                assert.match(run.stderr, reason);
            });
        }

        it("accepts a non-root user id", () => {
            assert.equal(callCheck(shell.name, "check_user", "1000").status, 0);
        });

        it("refuses user id 0 naming root", () => {
            const run = callCheck(shell.name, "check_user", "0");
            assert.equal(run.status, 1);
            assert.match(run.stderr, /root/);
        });

        it("refuses a home with a node_modules segment", () => {
            const run = callCheck(shell.name, "check_home", "/srv/node_modules/ann");
            assert.equal(run.status, 1);
            assert.match(run.stderr, /node_modules/);
        });

        it("accepts a home that only contains node_modules in a name", () => {
            assert.equal(callCheck(shell.name, "check_home", "/home/my_node_modules_fan").status, 0);
        });
    });
}

describe("install script on disk", () => {
    it("contains no sudo call", () => {
        assert.doesNotMatch(readFileSync(SCRIPT, "utf8"), /sudo/);
    });

    for (const shell of SHELLS) {
        it(`passes ${shell.name} -n`, { skip: shell.skip }, () => {
            const run = spawnSync(shell.name, ["-n", SCRIPT], { encoding: "utf8", timeout: scaled(10000) });
            assert.equal(run.status, 0, run.stderr);
        });
    }
});

describe("install script refusals in a temporary home", () => {
    let root = "";
    let home = "";
    let fakeBin = "";

    beforeEach(() => {
        root = mkdtempSync(join(tmpdir(), "install-script-"));
        home = join(root, "home");
        fakeBin = join(root, "fake-bin");
        mkdirSync(home);
        mkdirSync(fakeBin);
    });

    afterEach(() => {
        rmSync(root, { recursive: true, force: true });
    });

    function fakeId(uid: string): void {
        writeFileSync(join(fakeBin, "id"), `#!/bin/sh\necho ${uid}\n`);
        chmodSync(join(fakeBin, "id"), 0o755);
    }

    function runScript(shell: string, ...args: string[]): Run {
        const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, PATH: `${fakeBin}:${process.env.PATH}` };
        delete env.BOB_INSTALL_LIB;
        const result = spawnSync(shell, [SCRIPT, ...args], { encoding: "utf8", env, timeout: scaled(20000) });
        return { status: result.status, stdout: result.stdout, stderr: result.stderr };
    }

    function listing(): string[] {
        return readdirSync(home, { recursive: true }).map(String).sort();
    }

    for (const shell of SHELLS) {
        describe(`under ${shell.name}`, { skip: shell.skip }, () => {
            it("exits 1 naming root and changes nothing when run as user id 0", () => {
                fakeId("0");
                const run = runScript(shell.name, "--version", "1.0.0");
                assert.equal(run.status, 1);
                assert.match(run.stderr, /root/);
                assert.deepEqual(listing(), []);
            });

            it("exits 1 naming the installed version and bob upgrade when current exists", () => {
                fakeId("1000");
                const program = join(home, ".local", "lib", "the-intern");
                mkdirSync(join(program, "versions", "0.9.0"), { recursive: true });
                symlinkSync("versions/0.9.0", join(program, "current"));
                const before = listing();
                const run = runScript(shell.name, "--version", "1.0.0");
                assert.equal(run.status, 1);
                assert.match(run.stderr, /0\.9\.0/);
                assert.match(run.stderr, /bob upgrade/);
                assert.deepEqual(listing(), before);
            });

            it("exits 1 pointing to bob upgrade when a foreign bob is in ~/.local/bin", () => {
                fakeId("1000");
                mkdirSync(join(home, ".local", "bin"), { recursive: true });
                writeFileSync(join(home, ".local", "bin", "bob"), "someone else's");
                const before = listing();
                const run = runScript(shell.name, "--version", "1.0.0");
                assert.equal(run.status, 1);
                assert.match(run.stderr, /bob upgrade/);
                assert.match(run.stderr, /\.local\/bin\/bob/);
                assert.deepEqual(listing(), before);
                assert.equal(existsSync(join(home, ".local", "lib")), false);
            });
        });
    }
});
