/**
 * The download location of the installation commands (ADR-013, S-010 REQ-006 and REQ-013): finding the latest release,
 * downloading a bundle with its `.sha256` file, checking it, unpacking it with the system's `tar` and renaming it into
 * `versions/`. Any failure removes the staging folder and leaves `versions/` as it was. It imports only Node modules
 * and the program layout; the bundle's name follows the rule of `release/build_bundle.ts`, which a bundle doesn't hold.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseVersion } from "./install_model.ts";
import type { ProgramLayout } from "./program_layout.ts";

const GITHUB_RELEASES = "https://github.com/aurora-firmware/the-intern/releases";
const OWNER_ONLY_DIR_MODE = 0o700;
const STAGING_PREFIX = ".staging-";
const TAG_IN_LOCATION = /\/tag\/v([^/?#]+)$/;

export type ReleaseSource = {
    /** Where an asset of the release lives: a URL, an absolute path or a `file:` URL. */
    assetUrl: (version: string, asset: string) => string;
    /** Where the latest version is found. */
    latestUrl: string;
    /** True when `latestUrl` redirects to the latest tag; false when it is a text file holding the tag. */
    latestIsRedirect: boolean;
};

/** The release is not available, or its bundle is refused. The message says what failed and why. */
export class ReleaseSourceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ReleaseSourceError";
    }
}

class NotFoundError extends Error {}

export function releaseSource(env: Record<string, string | undefined>): ReleaseSource {
    const override = env.BOB_RELEASE_URL;
    if (override === undefined || override === "") {
        return {
            assetUrl: (version, asset) => `${GITHUB_RELEASES}/download/v${version}/${asset}`,
            latestUrl: `${GITHUB_RELEASES}/latest`,
            latestIsRedirect: true,
        };
    }
    if (!isReadable(override)) {
        throw new ReleaseSourceError(
            `BOB_RELEASE_URL ${override} is not usable: give an absolute folder path, a file: URL or an http: or https: URL.`,
        );
    }
    const base = override.replace(/\/+$/, "");
    return {
        assetUrl: (version, asset) => `${base}/v${version}/${asset}`,
        latestUrl: `${base}/latest`,
        latestIsRedirect: false,
    };
}

function isReadable(location: string): boolean {
    return /^(\/|file:|https?:)/.test(location);
}

function bundleName(version: string, platform: string): string {
    return `the-intern-${version}-${platform}.tar.gz`;
}

async function readLocation(location: string): Promise<Buffer> {
    if (location.startsWith("http:") || location.startsWith("https:")) {
        const response = await fetch(location);
        if (response.status === 404) throw new NotFoundError(`${location} answers 404`);
        if (!response.ok) throw new Error(`${location} answers HTTP ${response.status}`);
        return Buffer.from(await response.arrayBuffer());
    }
    const path = location.startsWith("file:") ? fileURLToPath(location) : location;
    try {
        return await readFile(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new NotFoundError(`${path} does not exist`);
        throw error;
    }
}

function reasonOf(error: unknown): string {
    if (!(error instanceof Error)) return String(error);
    const cause = error.cause instanceof Error ? `: ${error.cause.message}` : "";
    return `${error.message}${cause}`;
}

async function latestFromRedirect(url: string): Promise<string> {
    const response = await fetch(url, { redirect: "manual" });
    const location = response.headers.get("location");
    if (response.status < 300 || response.status >= 400 || location === null) {
        throw new Error(`${url} answered HTTP ${response.status}, not a redirect to the latest tag`);
    }
    const match = TAG_IN_LOCATION.exec(location);
    if (match === null) throw new Error(`${url} redirects to ${location}, which names no release tag`);
    return match[1] as string;
}

/** The version of the latest release, without the leading `v`. */
export async function latestVersion(source: ReleaseSource): Promise<string> {
    let text: string;
    try {
        text = source.latestIsRedirect
            ? await latestFromRedirect(source.latestUrl)
            : (await readLocation(source.latestUrl)).toString("utf8");
    } catch (error) {
        throw new ReleaseSourceError(`Finding the latest release at ${source.latestUrl} failed: ${reasonOf(error)}.`);
    }
    const version = text.trim().replace(/^v/, "");
    if (parseVersion(version) === undefined) {
        throw new ReleaseSourceError(
            `The latest release at ${source.latestUrl} names "${text.trim()}", which is not a version of the form X.Y.Z.`,
        );
    }
    return version;
}

function checksumOf(text: string, name: string): string | undefined {
    const [hex, file] = text.trim().split(/\s+/);
    if (hex === undefined || !/^[0-9a-f]{64}$/i.test(hex)) return undefined;
    if (file !== undefined && file.replace(/^\*/, "") !== name) return undefined;
    return hex.toLowerCase();
}

async function download(source: ReleaseSource, version: string, name: string, what: string): Promise<Buffer> {
    const url = source.assetUrl(version, name);
    try {
        return await readLocation(url);
    } catch (error) {
        if (error instanceof NotFoundError) {
            throw new ReleaseSourceError(`Version ${version} does not exist: ${what} ${url} was not found.`);
        }
        throw new ReleaseSourceError(`Downloading ${url} failed: ${reasonOf(error)}.`);
    }
}

async function downloadChecksum(source: ReleaseSource, version: string, name: string): Promise<string> {
    const url = source.assetUrl(version, `${name}.sha256`);
    let text: string;
    try {
        text = (await readLocation(url)).toString("utf8");
    } catch (error) {
        if (error instanceof NotFoundError) {
            throw new ReleaseSourceError(
                `Missing checksum: ${url} was not found, so the bundle of version ${version} is refused.`,
            );
        }
        throw new ReleaseSourceError(`Downloading ${url} failed: ${reasonOf(error)}.`);
    }
    const expected = checksumOf(text, name);
    if (expected === undefined) {
        throw new ReleaseSourceError(`Checksum file ${url} does not hold a sha256 checksum for ${name}.`);
    }
    return expected;
}

function untar(archive: string, into: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn("tar", ["-xzf", archive, "-C", into], { stdio: ["ignore", "ignore", "pipe"] });
        let errorText = "";
        child.stderr.on("data", (chunk: Buffer) => {
            errorText += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => {
            if (code === 0) resolve();
            else reject(new Error(`tar exited with ${code}: ${errorText.trim()}`));
        });
    });
}

async function checkUnpacked(folder: string, version: string): Promise<void> {
    for (const required of [join("bin", "bob"), join("app", "package.json")]) {
        const found = await stat(join(folder, required)).catch(() => undefined);
        if (found === undefined || !found.isFile()) {
            throw new ReleaseSourceError(`The bundle of version ${version} holds no ${required}.`);
        }
    }
    const packageText = await readFile(join(folder, "app", "package.json"), "utf8");
    let actual: unknown;
    try {
        actual = (JSON.parse(packageText) as { version?: unknown }).version;
    } catch {
        throw new ReleaseSourceError(`The bundle of version ${version} holds an unreadable app/package.json.`);
    }
    if (actual !== version) {
        throw new ReleaseSourceError(
            `The bundle holds version ${String(actual)} in app/package.json, but ${version} was asked for.`,
        );
    }
}

async function unpackAndPlace(
    staging: string,
    bytes: Buffer,
    layout: ProgramLayout,
    version: string,
    platform: string,
) {
    const archive = join(staging, bundleName(version, platform));
    await writeFile(archive, bytes, { mode: 0o600 });
    const unpackDir = join(staging, "unpacked");
    await mkdir(unpackDir);
    try {
        await untar(archive, unpackDir);
    } catch (error) {
        throw new ReleaseSourceError(`Unpacking the bundle of version ${version} failed: ${reasonOf(error)}.`);
    }
    const entries = await readdir(unpackDir);
    const top = `the-intern-${version}-${platform}`;
    if (entries.length !== 1 || entries[0] !== top) {
        throw new ReleaseSourceError(
            `The bundle of version ${version} holds ${entries.join(", ")}, not the folder ${top}.`,
        );
    }
    await checkUnpacked(join(unpackDir, top), version);
    const target = layout.versionDir(version);
    if (
        await stat(target).then(
            () => true,
            () => false,
        )
    ) {
        throw new ReleaseSourceError(`Version ${version} is already installed at ${target}.`);
    }
    await mkdir(layout.versionsDir, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await rename(join(unpackDir, top), target);
}

/**
 * Downloads the bundle of `version` and its `.sha256` file, checks them, unpacks the bundle and renames it into
 * `versions/X.Y.Z`. Returns that folder. A failure removes the staging folder and refuses with the reason.
 */
export async function fetchBundle(
    source: ReleaseSource,
    layout: ProgramLayout,
    version: string,
    platform: string,
): Promise<string> {
    if (parseVersion(version) === undefined) {
        throw new ReleaseSourceError(`"${version}" is not a version of the form X.Y.Z.`);
    }
    const name = bundleName(version, platform);
    const bytes = await download(source, version, name, "the bundle");
    const expected = await downloadChecksum(source, version, name);
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== expected) {
        throw new ReleaseSourceError(
            `Checksum mismatch for ${name}: the download has sha256 ${actual}, but the .sha256 file says ${expected}.`,
        );
    }
    await mkdir(layout.root, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await chmod(layout.root, OWNER_ONLY_DIR_MODE);
    const staging = await mkdtemp(join(layout.root, STAGING_PREFIX));
    try {
        await unpackAndPlace(staging, bytes, layout, version, platform);
    } finally {
        await rm(staging, { recursive: true, force: true });
    }
    return layout.versionDir(version);
}
