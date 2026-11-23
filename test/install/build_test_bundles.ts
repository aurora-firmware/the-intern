/**
 * Builds the bundles the installation cycle upgrades between (S-010 REQ-017) and lays them out as download locations
 * for `BOB_RELEASE_URL`. Usage: `node test/install/build_test_bundles.ts <out dir>` (or `--out <out dir>`).
 *
 * The product carries no failure switch: each failing or migrating build is `0.2.0` with a patch of exact text
 * replacements, which `release/build_bundle.ts` refuses unless each matches once.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bundleName, checksumLine, type Patch } from "../../release/build_bundle.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..", "..");
const PLATFORM = "linux-x64";
const FIRST_VERSION = "0.1.0";
const SECOND_VERSION = "0.2.0";
const VARIANT_BUILDS_FOLDER = ".variant-builds";
const PATCHES_FOLDER = "patches";

const JOB_STORE = "src/jobs/job_store.ts";
const DAEMON = "src/daemon/daemon.ts";
const SCHEMA_VERSION_LINE = "export const JOB_SCHEMA_VERSION = 6;";
const MIGRATIONS_END = "];\n\nif (JOB_MIGRATIONS.length !== JOB_SCHEMA_VERSION)";

export type Variant = { name: string; location: string; patches: Patch[] };

/** The variants of 0.2.0. Their names are the patch files' names; the locations are the names the cycle uses. */
export const VARIANTS: readonly Variant[] = [
    {
        // Step 2 fails for a reason other than the database, so the startup report names step 2 and a readable database.
        name: "fails_before_database",
        location: "fails-before-database",
        patches: [
            {
                file: DAEMON,
                find: "await step(2, STEP_NAMES.ensureDirectories, () => ensureInstanceDirs(dirs));",
                replace:
                    'await step(2, STEP_NAMES.ensureDirectories, async () => { throw new Error("this test build fails at step 2"); });',
            },
        ],
    },
    {
        // One schema version below the 0.1.0 database's, so step 4 refuses that database as newer than this build
        // supports. The last two migrations are folded into one, not dropped: the two counts stay in step at module
        // load, and a fresh database still carries the full 0.2.0 schema (S-010 AC-008.2 starts 0.2.0 on one).
        name: "older_job_schema",
        location: "older-job-schema",
        patches: [
            { file: JOB_STORE, find: SCHEMA_VERSION_LINE, replace: "export const JOB_SCHEMA_VERSION = 5;" },
            {
                file: JOB_STORE,
                find: MIGRATIONS_END,
                replace: `].flatMap((sql, i, list) => (i === list.length - 1 ? [] : i === list.length - 2 ? [sql + list[i + 1]] : [sql]));${MIGRATIONS_END.slice(2)}`,
            },
        ],
    },
    {
        // One schema version above the 0.1.0 database's, with a harmless new table, so step 4 migrates it.
        name: "newer_job_schema",
        location: "newer-job-schema",
        patches: [
            { file: JOB_STORE, find: SCHEMA_VERSION_LINE, replace: "export const JOB_SCHEMA_VERSION = 7;" },
            {
                file: JOB_STORE,
                find: MIGRATIONS_END,
                replace: `    \`CREATE TABLE intern_test_bundle_marker (id INTEGER PRIMARY KEY);\`,\n${MIGRATIONS_END}`,
            },
        ],
    },
];

function run(command: string, args: string[]): string {
    const result = spawnSync(command, args, { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr}${result.error ?? ""}`,
        );
    }
    return result.stdout;
}

function buildBundle(version: string, outDir: string, patchFile?: string): string {
    mkdirSync(outDir, { recursive: true });
    const patchArguments = patchFile === undefined ? [] : ["--patch", patchFile];
    run(process.execPath, [
        join(REPO_ROOT, "release", "build_bundle.ts"),
        PLATFORM,
        "--version",
        version,
        ...patchArguments,
        "--out",
        outDir,
    ]);
    return join(outDir, bundleName(version, PLATFORM));
}

/** Stamps the release's version into the script, as the release workflow does; the line must match once. */
export function stampInstallScript(text: string, version: string): string {
    const line = 'VERSION=""';
    const count = text.split(`\n${line}\n`).length - 1;
    if (count !== 1) throw new Error(`install.sh holds the line ${line} ${count} times: it must hold it once.`);
    return text.replace(`\n${line}\n`, `\nVERSION="${version}"\n`);
}

function placeBundle(location: string, version: string, bundlePath: string, withChecksum: boolean): void {
    const folder = join(location, `v${version}`);
    mkdirSync(folder, { recursive: true });
    const name = bundleName(version, PLATFORM);
    copyFileSync(bundlePath, join(folder, name));
    if (withChecksum) copyFileSync(`${bundlePath}.sha256`, join(folder, `${name}.sha256`));
}

function finishLocation(location: string, latest: string): void {
    writeFileSync(join(location, "latest"), `v${latest}\n`);
    const script = readFileSync(join(REPO_ROOT, "release", "install.sh"), "utf8");
    writeFileSync(join(location, "install.sh"), stampInstallScript(script, FIRST_VERSION), { mode: 0o755 });
}

/** A copy of the bundle with a byte added, so it no longer matches the checksum written for the original. */
function tamperedCopy(bundlePath: string, into: string, version: string): void {
    const name = bundleName(version, PLATFORM);
    const original = readFileSync(bundlePath);
    const tampered = Buffer.concat([original, Buffer.from([0])]);
    const hex = createHash("sha256").update(original).digest("hex");
    const folder = join(into, `v${version}`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, name), tampered);
    writeFileSync(join(folder, `${name}.sha256`), checksumLine(hex, name));
}

function buildAll(outDir: string): void {
    const first = buildBundle(FIRST_VERSION, outDir);
    const second = buildBundle(SECOND_VERSION, outDir);

    const base = join(outDir, "base");
    for (const [version, path] of [
        [FIRST_VERSION, first],
        [SECOND_VERSION, second],
    ] as const) {
        placeBundle(base, version, path, true);
    }
    finishLocation(base, SECOND_VERSION);

    const patchesDir = join(outDir, PATCHES_FOLDER);
    mkdirSync(patchesDir, { recursive: true });
    for (const variant of VARIANTS) {
        const patchFile = join(patchesDir, `${variant.name}.json`);
        writeFileSync(patchFile, `${JSON.stringify(variant.patches, null, 4)}\n`);
        let built: string;
        try {
            built = buildBundle(SECOND_VERSION, join(outDir, VARIANT_BUILDS_FOLDER, variant.name), patchFile);
        } catch (error) {
            throw new Error(`The variant ${variant.name} did not build: ${(error as Error).message}`, { cause: error });
        }
        const location = join(outDir, variant.location);
        placeBundle(location, FIRST_VERSION, first, true);
        placeBundle(location, SECOND_VERSION, built, true);
        finishLocation(location, SECOND_VERSION);
    }
    rmSync(join(outDir, VARIANT_BUILDS_FOLDER), { recursive: true, force: true });

    const tampered = join(outDir, "tampered");
    placeBundle(tampered, FIRST_VERSION, first, true);
    tamperedCopy(second, tampered, SECOND_VERSION);
    finishLocation(tampered, SECOND_VERSION);

    const noChecksum = join(outDir, "no-checksum");
    placeBundle(noChecksum, FIRST_VERSION, first, true);
    placeBundle(noChecksum, SECOND_VERSION, second, false);
    finishLocation(noChecksum, SECOND_VERSION);
}

function outDirFrom(argv: string[]): string {
    const [first, second] = argv;
    const value = first === "--out" ? second : first;
    if (value === undefined || argv.length > 2 || (first !== "--out" && argv.length > 1)) {
        throw new Error("Usage: node test/install/build_test_bundles.ts <out dir>");
    }
    return resolve(value);
}

if (import.meta.main) {
    try {
        buildAll(outDirFrom(process.argv.slice(2)));
    } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    }
}
