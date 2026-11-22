import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { type ProgramLayout, programLayout } from "../../src/install/program_layout.ts";
import { fetchBundle, latestVersion, type ReleaseSource, releaseSource } from "../../src/install/release_source.ts";

const PLATFORM = "linux-x64";

function assetName(version: string): string {
    return `the-intern-${version}-${PLATFORM}.tar.gz`;
}

/** Packs a bundle folder the way the release builder does: one top folder holding bin/bob and app/package.json. */
function packBundle(workDir: string, version: string, packageVersion = version): Buffer {
    const top = `the-intern-${version}-${PLATFORM}`;
    const root = join(workDir, "pack", top);
    mkdirSync(join(root, "bin"), { recursive: true });
    mkdirSync(join(root, "app"), { recursive: true });
    writeFileSync(join(root, "bin", "bob"), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(root, "app", "package.json"), JSON.stringify({ version: packageVersion }));
    const archive = join(workDir, `pack-${version}.tar.gz`);
    const result = spawnSync("tar", ["-czf", archive, "-C", join(workDir, "pack"), top], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    rmSync(join(workDir, "pack"), { recursive: true, force: true });
    return Buffer.from(spawnSync("cat", [archive], { maxBuffer: 1 << 26 }).stdout);
}

function sha(bytes: Buffer): string {
    return createHash("sha256").update(bytes).digest("hex");
}

function publish(releases: string, version: string, bundle: Buffer, checksum: string | null): void {
    const dir = join(releases, `v${version}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, assetName(version)), bundle);
    if (checksum !== null)
        writeFileSync(join(dir, `${assetName(version)}.sha256`), `${checksum}  ${assetName(version)}\n`);
}

describe("release source", () => {
    let dir: string;
    let releases: string;
    let layout: ProgramLayout;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), "release-source-"));
        releases = join(dir, "releases");
        mkdirSync(releases);
        layout = programLayout(join(dir, "home"));
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    function programEntries(): string[] {
        try {
            return readdirSync(layout.root).sort();
        } catch {
            return [];
        }
    }

    function versionEntries(): string[] {
        try {
            return readdirSync(layout.versionsDir).sort();
        } catch {
            return [];
        }
    }

    describe("locations", () => {
        it("uses the GitHub release locations without BOB_RELEASE_URL", () => {
            const source = releaseSource({});
            assert.equal(
                source.assetUrl("1.2.3", "a.tar.gz"),
                "https://github.com/aurora-firmware/the-intern/releases/download/v1.2.3/a.tar.gz",
            );
            assert.equal(source.latestUrl, "https://github.com/aurora-firmware/the-intern/releases/latest");
        });

        it("uses the override folder and its latest file with BOB_RELEASE_URL", () => {
            const source = releaseSource({ BOB_RELEASE_URL: "http://127.0.0.1:9/rel/" });
            assert.equal(source.assetUrl("1.2.3", "a.tar.gz"), "http://127.0.0.1:9/rel/v1.2.3/a.tar.gz");
            assert.equal(source.latestUrl, "http://127.0.0.1:9/rel/latest");
        });

        it("refuses a BOB_RELEASE_URL that is neither a path, a file URL nor an http URL", () => {
            assert.throws(
                () => releaseSource({ BOB_RELEASE_URL: "ftp://host/x" }),
                /BOB_RELEASE_URL.*ftp:\/\/host\/x/s,
            );
        });
    });

    describe("from a folder", () => {
        it("returns the version in the latest file and places versions/X.Y.Z with bin/bob", async () => {
            const bundle = packBundle(dir, "1.4.0");
            publish(releases, "1.4.0", bundle, sha(bundle));
            writeFileSync(join(releases, "latest"), "v1.4.0\n");
            const source = releaseSource({ BOB_RELEASE_URL: releases });

            const version = await latestVersion(source);
            await fetchBundle(source, layout, version, PLATFORM);

            assert.equal(version, "1.4.0");
            assert.deepEqual(readdirSync(join(layout.versionDir("1.4.0"), "bin")), ["bob"]);
            assert.deepEqual(versionEntries(), ["1.4.0"]);
            assert.deepEqual(programEntries(), ["versions"]);
        });

        it("reads a file: URL the same way", async () => {
            const bundle = packBundle(dir, "1.4.0");
            publish(releases, "1.4.0", bundle, sha(bundle));
            writeFileSync(join(releases, "latest"), "v1.4.0\n");
            const source = releaseSource({ BOB_RELEASE_URL: pathToFileURL(releases).href });

            await fetchBundle(source, layout, await latestVersion(source), PLATFORM);

            assert.deepEqual(versionEntries(), ["1.4.0"]);
        });

        it("refuses a latest file that holds no version", async () => {
            writeFileSync(join(releases, "latest"), "not a version\n");
            await assert.rejects(latestVersion(releaseSource({ BOB_RELEASE_URL: releases })), /not a version/);
        });

        it("refuses naming the checksum mismatch and leaves no staging folder and no version folder", async () => {
            const bundle = packBundle(dir, "1.4.0");
            publish(releases, "1.4.0", bundle, sha(Buffer.from("other bytes")));
            const source = releaseSource({ BOB_RELEASE_URL: releases });

            await assert.rejects(fetchBundle(source, layout, "1.4.0", PLATFORM), /checksum mismatch/i);

            assert.deepEqual(programEntries(), []);
        });

        it("refuses naming the missing checksum and changes nothing", async () => {
            const bundle = packBundle(dir, "1.4.0");
            publish(releases, "1.4.0", bundle, null);
            const source = releaseSource({ BOB_RELEASE_URL: releases });

            await assert.rejects(fetchBundle(source, layout, "1.4.0", PLATFORM), /missing checksum.*\.sha256/is);

            assert.deepEqual(programEntries(), []);
        });

        it("refuses naming a version that does not exist and changes nothing", async () => {
            const source = releaseSource({ BOB_RELEASE_URL: releases });

            await assert.rejects(
                fetchBundle(source, layout, "9.9.9", PLATFORM),
                /9\.9\.9.*(does not exist|not found)/is,
            );

            assert.deepEqual(programEntries(), []);
        });

        it("refuses a bundle whose package.json holds another version and leaves versions as it was", async () => {
            const bundle = packBundle(dir, "1.4.0", "1.3.0");
            publish(releases, "1.4.0", bundle, sha(bundle));
            const source = releaseSource({ BOB_RELEASE_URL: releases });

            await assert.rejects(fetchBundle(source, layout, "1.4.0", PLATFORM), /1\.3\.0.*1\.4\.0/s);

            assert.deepEqual(programEntries(), []);
        });

        it("refuses a bundle that is not an archive and removes the staging folder", async () => {
            const bytes = Buffer.from("not a tar file");
            publish(releases, "1.4.0", bytes, sha(bytes));
            const source = releaseSource({ BOB_RELEASE_URL: releases });

            await assert.rejects(fetchBundle(source, layout, "1.4.0", PLATFORM), /unpack/i);

            assert.deepEqual(programEntries(), []);
        });

        it("refuses a version that is already installed and keeps that folder untouched", async () => {
            const bundle = packBundle(dir, "1.4.0");
            publish(releases, "1.4.0", bundle, sha(bundle));
            mkdirSync(layout.versionDir("1.4.0"), { recursive: true });
            writeFileSync(join(layout.versionDir("1.4.0"), "marker"), "kept");
            const source = releaseSource({ BOB_RELEASE_URL: releases });

            await assert.rejects(fetchBundle(source, layout, "1.4.0", PLATFORM), /already installed/);

            assert.deepEqual(readdirSync(layout.versionDir("1.4.0")), ["marker"]);
            assert.deepEqual(programEntries(), ["versions"]);
        });

        it("leaves the existing version folders alone when it refuses", async () => {
            mkdirSync(layout.versionDir("1.0.0"), { recursive: true });
            const source = releaseSource({ BOB_RELEASE_URL: releases });

            await assert.rejects(fetchBundle(source, layout, "9.9.9", PLATFORM), /9\.9\.9/);

            assert.deepEqual(programEntries(), ["versions"]);
            assert.deepEqual(versionEntries(), ["1.0.0"]);
        });
    });

    describe("over HTTP", () => {
        let server: Server;
        let base: string;
        let routes: Map<string, (response: import("node:http").ServerResponse) => void>;

        beforeEach(async () => {
            routes = new Map();
            server = createServer((request, response) => {
                const route = routes.get(request.url ?? "");
                if (route === undefined) {
                    response.writeHead(404).end();
                    return;
                }
                route(response);
            });
            await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
            base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        });

        afterEach(async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        });

        function serve(path: string, body: Buffer | string): void {
            routes.set(path, (response) => {
                response.writeHead(200).end(body);
            });
        }

        it("downloads the same assets over HTTP", async () => {
            const bundle = packBundle(dir, "2.0.0");
            serve("/rel/latest", "v2.0.0\n");
            serve(`/rel/v2.0.0/${assetName("2.0.0")}`, bundle);
            serve(`/rel/v2.0.0/${assetName("2.0.0")}.sha256`, `${sha(bundle)}  ${assetName("2.0.0")}\n`);
            const source = releaseSource({ BOB_RELEASE_URL: `${base}/rel` });

            const version = await latestVersion(source);
            await fetchBundle(source, layout, version, PLATFORM);

            assert.equal(version, "2.0.0");
            assert.deepEqual(versionEntries(), ["2.0.0"]);
            assert.deepEqual(programEntries(), ["versions"]);
        });

        it("refuses naming the reason when the download stops halfway and changes nothing", async () => {
            const bundle = packBundle(dir, "2.0.0");
            serve(`/rel/v2.0.0/${assetName("2.0.0")}.sha256`, `${sha(bundle)}  ${assetName("2.0.0")}\n`);
            routes.set(`/rel/v2.0.0/${assetName("2.0.0")}`, (response) => {
                response.writeHead(200, { "content-length": String(bundle.length) });
                response.write(bundle.subarray(0, Math.floor(bundle.length / 2)), () => response.destroy());
            });
            const source = releaseSource({ BOB_RELEASE_URL: `${base}/rel` });

            await assert.rejects(fetchBundle(source, layout, "2.0.0", PLATFORM), /download|interrupted|terminated/i);

            assert.deepEqual(programEntries(), []);
        });

        it("refuses naming a version that does not exist when the server answers 404", async () => {
            const source = releaseSource({ BOB_RELEASE_URL: `${base}/rel` });

            await assert.rejects(
                fetchBundle(source, layout, "9.9.9", PLATFORM),
                /9\.9\.9.*(does not exist|not found)/is,
            );

            assert.deepEqual(programEntries(), []);
        });

        it("reads the latest version from the tag a redirect names", async () => {
            routes.set("/releases/latest", (response) => {
                response.writeHead(302, { location: `${base}/releases/tag/v3.1.4` }).end();
            });
            const source: ReleaseSource = {
                assetUrl: () => "",
                latestUrl: `${base}/releases/latest`,
                latestIsRedirect: true,
            };

            assert.equal(await latestVersion(source), "3.1.4");
        });

        it("refuses a latest answer that is not a redirect when the source expects one", async () => {
            serve("/releases/latest", "page");
            const source: ReleaseSource = {
                assetUrl: () => "",
                latestUrl: `${base}/releases/latest`,
                latestIsRedirect: true,
            };

            await assert.rejects(latestVersion(source), /redirect/i);
        });
    });
});
