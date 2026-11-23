import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, beforeEach, describe, test } from "node:test";
import { scaled } from "../support/time_scale.ts";
import {
    cleanUpInstall,
    installedBob,
    locationDir,
    type RunResult,
    runAs,
    runInstallScript,
    startFakeModelServer,
    waitUntil,
    writePiAgentDir,
} from "./cycle_support.ts";
import { defaultScript, type FakeModelServer } from "./fake_model_server.ts";

const FIRST_VERSION = "0.1.0";
const SECOND_VERSION = "0.2.0";
const MISSING_VERSION = "9.9.9";
const OWNER_ONLY_DIR_MODE = 0o700;
const EXIT_BOUND_MS = scaled(60_000);
const BUNDLE_PLATFORM = "linux-x64";
const REFUSED = 1;

const programDir = join(homedir(), ".local", "lib", "the-intern");
const root = join(homedir(), "install-script-test");
const piAgentDir = join(root, "pi-agent");

const outputOf = (result: RunResult): string => `${result.stdout}${result.stderr}`;
const bundleName = (version: string): string => `the-intern-${version}-${BUNDLE_PLATFORM}.tar.gz`;

/** The pi version the installed release's `README.md` lists as the target, such as `1.4.0`. */
function readmePiVersion(): string {
    const readme = readFileSync(join(programDir, "current", "app", "README.md"), "utf8");
    const found = readme.match(/- Target:[^\n]*?`pi-coding-agent`\s+(\d+\.\d+\.\d+)/);
    assert.ok(found?.[1], "README.md lists no pi version in its compatibility section");
    return found[1];
}

/** Every path under `dir` with its kind, size and (for a link) target; `null` when `dir` does not exist. */
function snapshot(dir: string): string[] | null {
    if (!existsSync(dir) && !isLink(dir)) return null;
    const lines: string[] = [];
    const visit = (path: string): void => {
        const info = lstatSync(path);
        if (info.isSymbolicLink()) lines.push(`${path} -> ${readlinkSync(path)}`);
        else if (info.isDirectory()) {
            lines.push(`${path}/`);
            for (const entry of readdirSync(path).sort()) visit(join(path, entry));
        } else lines.push(`${path} ${info.size}`);
    };
    visit(dir);
    return lines;
}

function isLink(path: string): boolean {
    try {
        return lstatSync(path).isSymbolicLink();
    } catch {
        return false;
    }
}

function assertNothingInstalled(): void {
    assert.equal(snapshot(programDir), null, `${programDir} must not exist`);
    assert.equal(isLink(installedBob()) || existsSync(installedBob()), false, `${installedBob()} must not exist`);
}

describe("a fresh install of the base location", () => {
    let result: RunResult;

    before(async () => {
        await cleanUpInstall([root]);
        result = await runInstallScript("base", ["--version", FIRST_VERSION]);
    });

    after(async () => {
        await cleanUpInstall([root]);
    });

    test("the script exits 0", () => {
        assert.equal(result.status, 0, outputOf(result));
    });

    test("bob runs the release's version from the program folder", () => {
        const program = realpathSync(installedBob());
        assert.equal(program, join(programDir, "versions", FIRST_VERSION, "bin", "bob"));
        const manifest = JSON.parse(readFileSync(join(programDir, "current", "app", "package.json"), "utf8")) as {
            version: string;
        };
        assert.equal(manifest.version, FIRST_VERSION);
    });

    test("the output names bob service install", () => {
        assert.match(result.stdout, /bob service install/);
    });

    test("with ~/.local/bin off the PATH the output holds the line to add it", () => {
        assert.match(result.stdout, /Add bob to your PATH: export PATH="\$HOME\/\.local\/bin:\$PATH"/);
    });
});

/** Starts `bob serve` of the installed bundle with directory flags, on `PATH` that finds no Node. */
async function startDaemon(runtimeDir: string): Promise<{ stop: () => Promise<void> }> {
    const dirs = Object.fromEntries(["config", "state", "data"].map((name) => [name, join(root, name)]));
    for (const dir of [...Object.values(dirs), runtimeDir])
        await mkdir(dir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    const child: ChildProcess = spawn(
        installedBob(),
        [
            "serve",
            "--config-dir",
            dirs.config,
            "--state-dir",
            dirs.state,
            "--data-dir",
            dirs.data,
            "--runtime-dir",
            runtimeDir,
        ],
        {
            env: { PATH: "/usr/bin:/bin", HOME: homedir(), PI_CODING_AGENT_DIR: piAgentDir },
            stdio: ["ignore", "ignore", "pipe"],
        },
    );
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    const stop = async (): Promise<void> => {
        child.kill("SIGTERM");
        let timer: NodeJS.Timeout | undefined;
        const bound = new Promise<never>((_, reject) => {
            timer = setTimeout(
                () => reject(new Error(`the daemon did not exit within ${EXIT_BOUND_MS} ms: ${stderr}`)),
                EXIT_BOUND_MS,
            );
        });
        try {
            await Promise.race([exited, bound]);
        } finally {
            clearTimeout(timer);
        }
    };
    return { stop };
}

async function statusOf(runtimeDir: string): Promise<{ phase: string; versions: { intern: string; pi: string } }> {
    const result = await runAs(installedBob(), ["status", "--json", "--runtime-dir", runtimeDir]);
    assert.equal(result.status, 0, outputOf(result));
    return JSON.parse(result.stdout);
}

describe("bob serve with no Node on the PATH", () => {
    const runtimeDir = join(root, "runtime");
    let server: FakeModelServer;
    let daemon: { stop: () => Promise<void> };

    before(async () => {
        await cleanUpInstall([root]);
        const installed = await runInstallScript("base", ["--version", FIRST_VERSION]);
        assert.equal(installed.status, 0, outputOf(installed));
        server = await startFakeModelServer(defaultScript);
        await writePiAgentDir(piAgentDir, server.baseUrl);
        daemon = await startDaemon(runtimeDir);
    });

    after(async () => {
        await daemon?.stop();
        await server?.close();
        await cleanUpInstall([root]);
    });

    test("the runner's PATH finds no node", async () => {
        const result = await runAs("sh", ["-c", "command -v node"]);
        assert.equal(result.stdout.trim(), "");
        assert.notEqual(result.status, 0);
    });

    test("the daemon reaches ready", async () => {
        await waitUntil(
            "the daemon answering ready",
            async () => {
                const result = await runAs(installedBob(), ["status", "--json", "--runtime-dir", runtimeDir]);
                return result.status === 0 ? (JSON.parse(result.stdout) as { phase: string }).phase : "not answering";
            },
            (phase) => phase === "ready",
        );
    });

    test("bob status reports the release's version and the README's pi version", async () => {
        const status = await statusOf(runtimeDir);
        assert.equal(status.versions.intern, FIRST_VERSION);
        assert.equal(status.versions.pi, readmePiVersion());
    });
});

describe("an install script refused", () => {
    beforeEach(async () => {
        await cleanUpInstall([root]);
    });

    afterEach(async () => {
        await cleanUpInstall([root]);
    });

    describe("when The Intern is already installed", () => {
        let programBefore: string[] | null;
        let link: string;

        beforeEach(async () => {
            const installed = await runInstallScript("base", ["--version", FIRST_VERSION]);
            assert.equal(installed.status, 0, outputOf(installed));
            programBefore = snapshot(programDir);
            link = readlinkSync(installedBob());
        });

        function assertUnchanged(): void {
            assert.deepEqual(snapshot(programDir), programBefore);
            assert.equal(readlinkSync(installedBob()), link);
        }

        test("a second run exits 1 naming the version and bob upgrade", async () => {
            const result = await runInstallScript("base", ["--version", FIRST_VERSION]);
            assert.equal(result.status, REFUSED, outputOf(result));
            assert.match(
                result.stderr,
                new RegExp(`The Intern ${FIRST_VERSION.replaceAll(".", "\\.")} is already installed`),
            );
            assert.match(result.stderr, /bob upgrade/);
            assertUnchanged();
        });

        test("a run naming a missing version exits 1, with the program folder and link as they were", async () => {
            const result = await runInstallScript("base", ["--version", MISSING_VERSION]);
            assert.equal(result.status, REFUSED, outputOf(result));
            assert.match(result.stderr, /already installed/);
            assertUnchanged();
        });
    });

    test("a missing version exits 1 naming the download, and leaves nothing", async () => {
        const result = await runInstallScript("base", ["--version", MISSING_VERSION]);
        assert.equal(result.status, REFUSED, outputOf(result));
        assert.match(result.stderr, new RegExp(`download of .*${MISSING_VERSION.replaceAll(".", "\\.")}.* failed`));
        assertNothingInstalled();
    });

    test("the tampered location exits 1 naming the checksum, and leaves nothing", async () => {
        const result = await runInstallScript("tampered", ["--version", SECOND_VERSION]);
        assert.equal(result.status, REFUSED, outputOf(result));
        assert.match(result.stderr, /checksum of .* does not match/);
        assertNothingInstalled();
    });

    test("the no-checksum location exits 1 naming the missing checksum, and leaves nothing", async () => {
        const result = await runInstallScript("no-checksum", ["--version", SECOND_VERSION]);
        assert.equal(result.status, REFUSED, outputOf(result));
        assert.match(result.stderr, /no checksum file at .*\.sha256/);
        assertNothingInstalled();
    });

    describe("when the download is cut halfway", () => {
        let cutServer: Server;
        let baseUrl: string;

        before(async () => {
            const bundle = readFileSync(join(locationDir("base"), `v${FIRST_VERSION}`, bundleName(FIRST_VERSION)));
            cutServer = createServer((request, response) => {
                if (!request.url?.endsWith(bundleName(FIRST_VERSION))) {
                    response.writeHead(404).end();
                    return;
                }
                response.writeHead(200, { "content-length": bundle.length });
                response.write(bundle.subarray(0, Math.floor(bundle.length / 2)), () => request.socket.destroy());
            });
            await new Promise<void>((resolve) => cutServer.listen(0, "127.0.0.1", resolve));
            const address = cutServer.address();
            assert.ok(address !== null && typeof address === "object");
            baseUrl = `http://127.0.0.1:${address.port}`;
        });

        after(async () => {
            cutServer.closeAllConnections();
            await new Promise<void>((resolve) => cutServer.close(() => resolve()));
        });

        test("the script exits 1 naming the failed download, and leaves nothing", async () => {
            const result = await runInstallScript("base", ["--version", FIRST_VERSION], {
                env: { BOB_RELEASE_URL: baseUrl },
            });
            assert.equal(result.status, REFUSED, outputOf(result));
            assert.match(result.stderr, /download of .* failed/);
            assertNothingInstalled();
        });
    });
});
