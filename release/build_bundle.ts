import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const PLATFORMS = ["linux-x64", "darwin-arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];
export type Patch = { file: string; find: string; replace: string };
export const MAX_ARCHIVE_BYTES = 150 * 1024 * 1024;

const NODE_DIST_URL = "https://nodejs.org/dist";
const REPO_ROOT = resolve(import.meta.dirname, "..");
const APP_ENTRIES = ["package.json", "package-lock.json", "README.md", "src", "web/ui"];

export function bundleName(version: string, platform: string): string {
    return `the-intern-${version}-${platform}.tar.gz`;
}

export function checksumLine(hex: string, fileName: string): string {
    return `${hex}  ${fileName}\n`;
}

export function applyPatches(files: Record<string, string>, patches: Patch[]): Record<string, string> {
    const result = { ...files };
    for (const patch of patches) {
        const text = result[patch.file];
        if (text === undefined) {
            throw new Error(`The patch names ${patch.file}, which is not in the bundle's app folder.`);
        }
        const count = patch.find === "" ? 0 : text.split(patch.find).length - 1;
        if (count !== 1) {
            throw new Error(
                `The patch text ${JSON.stringify(patch.find)} matches ${count} times in ${patch.file}: it must match exactly once.`,
            );
        }
        result[patch.file] = text.replace(patch.find, () => patch.replace);
    }
    return result;
}

export function assertArchiveSize(fileName: string, bytes: number): void {
    if (bytes > MAX_ARCHIVE_BYTES) {
        throw new Error(
            `The archive ${fileName} is ${bytes} bytes, over the limit of ${MAX_ARCHIVE_BYTES} bytes (150 MB).`,
        );
    }
}

export function launcherScript(): string {
    return `#!/bin/sh
# Finds its own real folder through any links, then runs the node and app next to it.
target=$0
while [ -L "$target" ]; do
    link=$(readlink "$target")
    case $link in
        /*) target=$link ;;
        *) target=$(dirname "$target")/$link ;;
    esac
done
folder=$(cd "$(dirname "$target")" && pwd -P)
exec "$folder/../node/bin/node" "$folder/../app/src/cli/bob.ts" "$@"
`;
}

function run(command: string, args: string[], cwd: string): string {
    const result = spawnSync(command, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (result.status !== 0) {
        throw new Error(
            `${command} ${args.join(" ")} failed (${result.status}): ${result.stderr}${result.error ?? ""}`,
        );
    }
    return result.stdout;
}

async function download(url: string): Promise<Buffer> {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Downloading ${url} failed: HTTP ${response.status}.`);
    return Buffer.from(await response.arrayBuffer());
}

async function fetchNode(platform: Platform, work: string, nodeDir: string): Promise<void> {
    const base = `${NODE_DIST_URL}/${process.version}`;
    const fileName = `node-${process.version}-${platform}.tar.xz`;
    const sums = (await download(`${base}/SHASUMS256.txt`)).toString("utf8");
    const line = sums.split("\n").find((entry) => entry.endsWith(`  ${fileName}`));
    if (line === undefined) throw new Error(`SHASUMS256.txt of Node ${process.version} lists no ${fileName}.`);
    const archive = await download(`${base}/${fileName}`);
    const actual = createHash("sha256").update(archive).digest("hex");
    const expected = line.split(/\s+/)[0];
    if (actual !== expected) {
        throw new Error(`${fileName} has sha256 ${actual}, but SHASUMS256.txt says ${expected}.`);
    }
    const archivePath = join(work, fileName);
    writeFileSync(archivePath, archive);
    run("tar", ["-xJf", archivePath, "-C", work], work);
    const unpacked = join(work, `node-${process.version}-${platform}`);
    mkdirSync(join(nodeDir, "bin"), { recursive: true });
    cpSync(join(unpacked, "bin", "node"), join(nodeDir, "bin", "node"));
    chmodSync(join(nodeDir, "bin", "node"), 0o755);
    cpSync(join(unpacked, "LICENSE"), join(nodeDir, "LICENSE"));
}

function stageApp(appDir: string, version: string | undefined, patches: Patch[]): void {
    mkdirSync(appDir, { recursive: true });
    for (const entry of APP_ENTRIES) {
        const target = join(appDir, entry);
        mkdirSync(join(target, ".."), { recursive: true });
        cpSync(join(REPO_ROOT, entry), target, { recursive: true });
    }
    run("npm", ["ci", "--omit=dev", "--ignore-scripts"], appDir);
    if (version !== undefined) {
        const packagePath = join(appDir, "package.json");
        const parsed = JSON.parse(readFileSync(packagePath, "utf8")) as Record<string, unknown>;
        parsed.version = version;
        writeFileSync(packagePath, `${JSON.stringify(parsed, null, 4)}\n`);
    }
    if (patches.length > 0) applyPatchesToFolder(appDir, patches);
}

function applyPatchesToFolder(appDir: string, patches: Patch[]): void {
    const names = [...new Set(patches.map((patch) => patch.file))];
    const files: Record<string, string> = {};
    for (const name of names) {
        const path = join(appDir, name);
        if (existsSync(path)) files[name] = readFileSync(path, "utf8");
    }
    const patched = applyPatches(files, patches);
    for (const [name, text] of Object.entries(patched)) writeFileSync(join(appDir, name), text);
}

function commitTime(): string {
    return run("git", ["log", "-1", "--format=%ct"], REPO_ROOT).trim();
}

function writeArchive(stageParent: string, folderName: string, outDir: string, name: string): string {
    const archivePath = join(outDir, name);
    run(
        "tar",
        [
            "--sort=name",
            "--owner=0",
            "--group=0",
            "--numeric-owner",
            `--mtime=@${commitTime()}`,
            "-cf",
            archivePath.replace(/\.gz$/, ""),
            "-C",
            stageParent,
            folderName,
        ],
        stageParent,
    );
    run("gzip", ["-nf", archivePath.replace(/\.gz$/, "")], outDir);
    return archivePath;
}

type Options = { platform: Platform; version: string | undefined; patchFile: string | undefined; out: string };

function parseArguments(argv: string[]): Options {
    const [platform, ...rest] = argv;
    if (!PLATFORMS.includes(platform as Platform)) {
        throw new Error(
            `Usage: node release/build_bundle.ts <${PLATFORMS.join("|")}> [--version X.Y.Z] [--patch <file>] [--out <dir>]`,
        );
    }
    const options: Options = {
        platform: platform as Platform,
        version: undefined,
        patchFile: undefined,
        out: resolve(REPO_ROOT, ".tmp/release"),
    };
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index];
        const value = rest[index + 1];
        if (value === undefined) throw new Error(`The option ${flag} needs a value.`);
        if (flag === "--version") options.version = value;
        else if (flag === "--patch") options.patchFile = resolve(value);
        else if (flag === "--out") options.out = resolve(value);
        else throw new Error(`Unknown option ${flag}.`);
    }
    return options;
}

async function main(): Promise<void> {
    const options = parseArguments(process.argv.slice(2));
    const packageVersion = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string })
        .version;
    const version = options.version ?? packageVersion;
    const patches: Patch[] = options.patchFile === undefined ? [] : JSON.parse(readFileSync(options.patchFile, "utf8"));
    const work = mkdtempSync(join(tmpdir(), "bundle-build-"));
    try {
        const folderName = `the-intern-${version}-${options.platform}`;
        const root = join(work, folderName);
        mkdirSync(join(root, "bin"), { recursive: true });
        writeFileSync(join(root, "bin", "bob"), launcherScript());
        chmodSync(join(root, "bin", "bob"), 0o755);
        await fetchNode(options.platform, work, join(root, "node"));
        stageApp(join(root, "app"), options.version, patches);
        mkdirSync(options.out, { recursive: true });
        const name = bundleName(version, options.platform);
        const archivePath = writeArchive(work, folderName, options.out, name);
        assertArchiveSize(name, statSync(archivePath).size);
        const hex = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
        writeFileSync(`${archivePath}.sha256`, checksumLine(hex, name));
        process.stdout.write(`${archivePath}\n`);
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    main().catch((error: unknown) => {
        process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
        process.exit(1);
    });
}
