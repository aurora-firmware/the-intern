import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { scaled } from "../support/time_scale.ts";

type StartupReport = {
    furthestStep: number;
    failedStep: number | null;
    failedStepName: string | null;
    unreadableDatabase: boolean;
    ready: boolean;
};

type Instance = { root: string; configDir: string; stateDir: string; dataDir: string; runtimeDir: string; agentDir: string };

const BUNDLES = process.env.INSTALL_BUNDLES ?? "";
const PLATFORM = "linux-x64";
const LOCATIONS = [
    "base",
    "fails-before-database",
    "older-job-schema",
    "newer-job-schema",
    "tampered",
    "no-checksum",
];
const OWNER_ONLY_MODE = 0o700;
const FILE_MODE = 0o600;
const POLL_INTERVAL_MS = 100;
const EXIT_BOUND_MS = scaled(60_000);
const STEP_AFTER_DATABASE = 5;

const MODELS_JSON = {
    providers: {
        loopback: {
            baseUrl: "http://127.0.0.1:9/v1",
            api: "openai-completions",
            apiKey: "not-a-real-key",
            models: [{ id: "plain-model", reasoning: false }],
        },
    },
};
const SETTINGS_JSON = { defaultProvider: "loopback", defaultModel: "plain-model" };

let work = "";
let instance: Instance;

function bundleOf(version: string): string {
    return `the-intern-${version}-${PLATFORM}.tar.gz`;
}

function locationDir(name: string): string {
    return join(BUNDLES, name);
}

function shell(command: string, cwd: string): { status: number | null; output: string } {
    const result = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

function checksumStatus(location: string): number | null {
    const versions = readdirSync(locationDir(location)).filter((entry) => /^v\d/.test(entry));
    assert.ok(versions.length > 0, `${location} holds no version folder`);
    let status: number | null = 0;
    for (const version of versions) {
        const folder = join(locationDir(location), version);
        for (const file of readdirSync(folder).filter((entry) => entry.endsWith(".sha256"))) {
            const result = shell(`sha256sum -c ${file}`, folder);
            if (result.status !== 0) status = result.status;
        }
    }
    return status;
}

async function extract(archive: string, into: string): Promise<string> {
    await mkdir(into, { recursive: true });
    const result = shell(`tar -xzf ${archive} -C ${into}`, into);
    assert.equal(result.status, 0, result.output);
    return join(into, `the-intern-${archive.match(/the-intern-(.*)-linux/)?.[1]}-${PLATFORM}`);
}

async function createInstance(name: string): Promise<Instance> {
    const root = join(work, name);
    const made = {
        root,
        configDir: join(root, "config"),
        stateDir: join(root, "state"),
        dataDir: join(root, "data"),
        runtimeDir: join(root, "runtime"),
        agentDir: join(root, "pi-agent"),
    };
    for (const dir of [made.root, made.configDir, made.stateDir, made.dataDir, made.runtimeDir, made.agentDir]) {
        await mkdir(dir, { recursive: true, mode: OWNER_ONLY_MODE });
        await chmod(dir, OWNER_ONLY_MODE);
    }
    const fixtures = { "models.json": MODELS_JSON, "settings.json": SETTINGS_JSON, "auth.json": {} };
    for (const [file, content] of Object.entries(fixtures)) {
        await writeFile(join(made.agentDir, file), JSON.stringify(content), { mode: FILE_MODE });
    }
    return made;
}

function readReport(stateDir: string): StartupReport | undefined {
    const path = join(stateDir, "startup.json");
    if (!existsSync(path)) return undefined;
    try {
        return JSON.parse(readFileSync(path, "utf8")) as StartupReport;
    } catch {
        return undefined;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Starts `bin/bob serve` of an extracted bundle on the instance's directories. */
function startDaemon(bundleRoot: string, target: Instance): { exited: Promise<number | null>; stop: () => void } {
    const child = spawn(
        join(bundleRoot, "bin", "bob"),
        [
            "serve",
            "--config-dir",
            target.configDir,
            "--state-dir",
            target.stateDir,
            "--data-dir",
            target.dataDir,
            "--runtime-dir",
            target.runtimeDir,
        ],
        {
            env: { PATH: "/usr/bin:/bin", HOME: target.root, PI_CODING_AGENT_DIR: target.agentDir },
            stdio: ["ignore", "ignore", "pipe"],
        },
    );
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
    });
    const exited = new Promise<number | null>((resolve) => {
        child.once("exit", (code) => {
            if (code !== 0) process.stderr.write(`daemon of ${bundleRoot} exited ${code}:\n${stderr}\n`);
            resolve(code);
        });
    });
    return { exited, stop: () => child.kill("SIGTERM") };
}

async function withinBound<T>(promise: Promise<T>, what: string): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    const bound = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not happen within ${EXIT_BOUND_MS} ms`)), EXIT_BOUND_MS);
    });
    try {
        return await Promise.race([promise, bound]);
    } finally {
        clearTimeout(timer);
    }
}

async function runToEnd(bundleRoot: string, target: Instance): Promise<StartupReport> {
    const daemon = startDaemon(bundleRoot, target);
    await withinBound(daemon.exited, `the daemon of ${bundleRoot} exiting`);
    const report = readReport(target.stateDir);
    assert.ok(report, `no startup report in ${target.stateDir}`);
    return report;
}

/** Runs the daemon until it has passed step 4, which creates the database, then stops it. */
async function createDatabaseWith(bundleRoot: string, target: Instance): Promise<void> {
    const daemon = startDaemon(bundleRoot, target);
    const reachedStepAfterDatabase = (async () => {
        for (;;) {
            const report = readReport(target.stateDir);
            if (report !== undefined && (report.furthestStep >= STEP_AFTER_DATABASE || report.failedStep !== null)) {
                return;
            }
            await sleep(POLL_INTERVAL_MS);
        }
    })();
    await withinBound(Promise.race([reachedStepAfterDatabase, daemon.exited]), "the daemon passing step 4");
    daemon.stop();
    await withinBound(daemon.exited, "the daemon stopping");
}

before(async () => {
    assert.ok(BUNDLES !== "", "INSTALL_BUNDLES names no folder: run these tests with test/install/run_cycle.sh");
    work = await mkdtemp(join(tmpdir(), "bundle-test-"));
});

after(async () => {
    await rm(work, { recursive: true, force: true });
});

describe("the test bundles", () => {
    test("0.1.0 and 0.2.0 hold app/package.json of their own version", async () => {
        for (const version of ["0.1.0", "0.2.0"]) {
            const packaged = shell(`tar -xzOf ${bundleOf(version)} the-intern-${version}-${PLATFORM}/app/package.json`, BUNDLES);
            assert.equal(packaged.status, 0, packaged.output);
            assert.equal((JSON.parse(packaged.output) as { version: string }).version, version);
        }
    });

    test("every location holds a latest file and an install.sh stamped with its version", () => {
        for (const location of LOCATIONS) {
            const latest = readFileSync(join(locationDir(location), "latest"), "utf8").trim();
            assert.match(latest, /^v\d+\.\d+\.\d+$/, `${location}/latest`);
            const script = readFileSync(join(locationDir(location), "install.sh"), "utf8");
            assert.match(script, /^VERSION="\d+\.\d+\.\d+"$/m, `${location}/install.sh`);
        }
    });

    test("the checksums of base verify", () => {
        assert.equal(checksumStatus("base"), 0);
    });

    test("the checksums of tampered fail", () => {
        assert.notEqual(checksumStatus("tampered"), 0);
    });

    test("no-checksum holds a bundle with no checksum file", () => {
        const folder = join(locationDir("no-checksum"), "v0.2.0");
        assert.ok(existsSync(join(folder, bundleOf("0.2.0"))));
        assert.equal(existsSync(join(folder, `${bundleOf("0.2.0")}.sha256`)), false);
    });
});

describe("the failing variants on a 0.1.0 state directory", () => {
    let plainRoot = "";
    let variantRoot = (_variant: string): string => "";
    let target: Instance;

    before(async () => {
        plainRoot = await extract(join(BUNDLES, bundleOf("0.1.0")), join(work, "plain"));
        variantRoot = (variant: string) => join(work, variant, `the-intern-0.2.0-${PLATFORM}`);
        for (const [variant, location] of [
            ["fails_before_database", "fails-before-database"],
            ["older_job_schema", "older-job-schema"],
        ] as const) {
            await extract(join(locationDir(location), "v0.2.0", bundleOf("0.2.0")), join(work, variant));
        }
        target = await createInstance("state-0-1-0");
        await createDatabaseWith(plainRoot, target);
    });

    test("a daemon of the plain 0.1.0 creates a database", () => {
        assert.ok(existsSync(join(target.stateDir, "the-intern.sqlite")));
    });

    test("fails_before_database reports step 1 or 2 and a readable database", async () => {
        const report = await runToEnd(variantRoot("fails_before_database"), target);
        assert.ok(report.failedStep === 1 || report.failedStep === 2, `failed step ${report.failedStep}`);
        assert.equal(report.unreadableDatabase, false);
    });

    test("older_job_schema reports step 4 and an unreadable database", async () => {
        const report = await runToEnd(variantRoot("older_job_schema"), target);
        assert.equal(report.failedStep, 4);
        assert.equal(report.unreadableDatabase, true);
    });
});
