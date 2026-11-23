import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createModels } from "@earendil-works/pi-ai/models";
import { createLogger } from "../../src/daemon/logger.ts";
import { type HarnessHost, internalHarness, openHarnessHost } from "../../src/host/harness_host.ts";
import { recordOpenedVersions, runningVersions } from "../../src/host/versions.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const envs: HermeticEnv[] = [];
const hosts: HarnessHost[] = [];

afterEach(async () => {
    for (const host of hosts.splice(0)) await host.close();
    for (const env of envs.splice(0)) await env.dispose();
});

async function openHost(): Promise<HarnessHost> {
    const env = await createHermeticEnv();
    envs.push(env);
    const host = await openHarnessHost({
        databaseFile: join(env.root, "state.sqlite"),
        models: createModels(),
        harnessSettings: {},
        extensions: [],
        defaultCwd: process.cwd(),
        logger: createLogger({ stream: { write: () => true } }),
    });
    hosts.push(host);
    return host;
}

// Counts the commits made through the harness, to show that an unchanged version writes nothing.
function countCommits(host: HarnessHost): () => number {
    const harness = internalHarness(host);
    const commit = harness.commit.bind(harness) as (...args: unknown[]) => Promise<unknown>;
    let count = 0;
    (harness as { commit: unknown }).commit = (...args: unknown[]) => {
        count++;
        return commit(...args);
    };
    return () => count;
}

describe("runningVersions", () => {
    it("returns the versions pinned in package.json", async () => {
        const manifest = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));

        assert.deepEqual(runningVersions(), {
            intern: manifest.version,
            pi: manifest.dependencies["@earendil-works/pi-durable"],
        });
        assert.match(runningVersions().pi, /^\d+\.\d+\.\d+$/);
    });
});

describe("recordOpenedVersions", () => {
    it("records the running versions and reports no change on the first open", async () => {
        const host = await openHost();
        const running = { intern: "1.0.0", pi: "2.0.0" };

        const first = await recordOpenedVersions(host, running);
        const reopened = await recordOpenedVersions(host, running);

        assert.deepEqual(first, { changed: false });
        assert.deepEqual(reopened, { changed: false });
    });

    it("returns the previous versions and records the running ones when they differ", async () => {
        const host = await openHost();
        const older = { intern: "1.0.0", pi: "2.0.0" };
        const newer = { intern: "1.1.0", pi: "2.1.0" };
        await recordOpenedVersions(host, older);

        const changed = await recordOpenedVersions(host, newer);
        const afterwards = await recordOpenedVersions(host, newer);

        assert.deepEqual(changed, { changed: true, previous: older });
        assert.deepEqual(afterwards, { changed: false });
    });

    it("detects a change in the pi version alone", async () => {
        const host = await openHost();
        await recordOpenedVersions(host, { intern: "1.0.0", pi: "2.0.0" });

        const result = await recordOpenedVersions(host, { intern: "1.0.0", pi: "2.0.1" });

        assert.deepEqual(result, { changed: true, previous: { intern: "1.0.0", pi: "2.0.0" } });
    });

    it("commits nothing when the same versions open the database again", async () => {
        const host = await openHost();
        const running = { intern: "1.0.0", pi: "2.0.0" };
        await recordOpenedVersions(host, running);
        const commits = countCommits(host);

        await recordOpenedVersions(host, running);

        assert.equal(commits(), 0);
    });

    it("writes the changed versions in one commit", async () => {
        const host = await openHost();
        await recordOpenedVersions(host, { intern: "1.0.0", pi: "2.0.0" });
        const commits = countCommits(host);

        await recordOpenedVersions(host, { intern: "1.1.0", pi: "2.1.0" });

        assert.equal(commits(), 1);
    });
});
