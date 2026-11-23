import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export type ReleaseCheckInput = { tag: string; packageVersion: string; isOnMain: boolean };
export type ReleaseCheckResult = { ok: true; version: string; isPrerelease: boolean } | { ok: false; reason: string };

const PRERELEASE_PART = /^\d+\.\d+\.\d+-/;

export function checkReleaseTag(input: ReleaseCheckInput): ReleaseCheckResult {
    const expected = `v${input.packageVersion}`;
    if (input.tag !== expected) {
        return {
            ok: false,
            reason: `The tag ${input.tag} is not v plus the package version: package.json has version ${input.packageVersion}, so the tag must be ${expected}.`,
        };
    }
    if (!input.isOnMain) {
        return {
            ok: false,
            reason: `The commit tagged ${input.tag} is not on main: only a commit on main can be released.`,
        };
    }
    return { ok: true, version: input.packageVersion, isPrerelease: PRERELEASE_PART.test(input.packageVersion) };
}

function readPackageVersion(): string {
    const text = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    return (JSON.parse(text) as { version: string }).version;
}

function isHeadOnMain(): boolean {
    const result = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], { encoding: "utf8" });
    return result.status === 0;
}

function main(): void {
    const tag = process.argv[2];
    if (tag === undefined) {
        process.stderr.write("Usage: node release/check_release.ts <tag>\n");
        process.exit(1);
    }
    const result = checkReleaseTag({ tag, packageVersion: readPackageVersion(), isOnMain: isHeadOnMain() });
    if (!result.ok) {
        process.stderr.write(`${result.reason}\n`);
        process.exit(1);
    }
}

if (import.meta.main) main();
