import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, readdir, readlink, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import {
    checkLayout,
    ProgramLayoutError,
    programLayout,
    readLink,
    removeVersion,
    switchLink,
} from "../../src/install/program_layout.ts";

let scratch: string;
let counter = 0;

before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "program-layout-"));
});

after(async () => {
    await rm(scratch, { recursive: true, force: true });
});

async function freshHome(): Promise<string> {
    counter += 1;
    const home = join(scratch, `home-${counter}`);
    await mkdir(home);
    return home;
}

async function markComplete(dir: string, version: string): Promise<void> {
    await writeFile(join(dir, "complete"), version);
}

async function makeVersion(home: string, version: string): Promise<void> {
    await mkdir(programLayout(home).versionDir(version), { recursive: true });
}

describe("programLayout", () => {
    it("names the paths ADR-013 decision 1 fixes", () => {
        const layout = programLayout("/home/x");
        const root = "/home/x/.local/lib/the-intern";
        assert.equal(layout.root, root);
        assert.equal(layout.versionsDir, `${root}/versions`);
        assert.equal(layout.versionDir("0.3.0"), `${root}/versions/0.3.0`);
        assert.equal(layout.current, `${root}/current`);
        assert.equal(layout.previous, `${root}/previous`);
        assert.equal(layout.serviceRecord, `${root}/service.json`);
        assert.equal(layout.holdFile, `${root}/service.hold`);
        assert.equal(layout.installLock, `${root}/install.lock`);
        assert.equal(layout.journal, `${root}/operation.json`);
        assert.equal(layout.bobLink, "/home/x/.local/bin/bob");
    });
});

describe("checkLayout", () => {
    it("accepts a home path apart from the instance directories", () => {
        const layout = programLayout("/home/x");
        assert.doesNotThrow(() =>
            checkLayout(layout, ["/home/x/.config/the-intern", "/home/x/.local/state/the-intern"]),
        );
    });

    it("refuses a home path with a node_modules segment, naming it", () => {
        const layout = programLayout("/srv/node_modules/x");
        assert.throws(
            () => checkLayout(layout, []),
            (error: unknown) => error instanceof ProgramLayoutError && error.message.includes("/srv/node_modules/x"),
        );
    });

    it("accepts a segment that only contains the text node_modules", () => {
        assert.doesNotThrow(() => checkLayout(programLayout("/srv/my_node_modules_x"), []));
    });

    it("refuses a program folder inside an instance directory, naming both paths", () => {
        const layout = programLayout("/home/x");
        assert.throws(
            () => checkLayout(layout, ["/home/x/.local"]),
            (error: unknown) =>
                error instanceof ProgramLayoutError &&
                error.message.includes(layout.root) &&
                error.message.includes("/home/x/.local"),
        );
    });

    it("refuses a program folder that holds an instance directory", () => {
        const layout = programLayout("/home/x");
        assert.throws(
            () => checkLayout(layout, [`${layout.root}/versions/data`]),
            (error: unknown) =>
                error instanceof ProgramLayoutError && error.message.includes(`${layout.root}/versions/data`),
        );
    });

    it("refuses a program folder that holds an instance directory whose name starts with two dots", () => {
        const layout = programLayout("/home/x");
        assert.throws(() => checkLayout(layout, [`${layout.root}/..data`]), ProgramLayoutError);
    });

    it("refuses an instance directory that is the program folder", () => {
        const layout = programLayout("/home/x");
        assert.throws(() => checkLayout(layout, [layout.root]), ProgramLayoutError);
    });
});

describe("readLink and switchLink", () => {
    it("reads null when the link does not exist", async () => {
        const layout = programLayout(await freshHome());
        assert.equal(await readLink(layout, "current"), null);
    });

    it("points the link at the version through a relative target and reads it back", async () => {
        const home = await freshHome();
        const layout = programLayout(home);
        await makeVersion(home, "0.1.0");
        await switchLink(layout, "current", "0.1.0");
        assert.equal(await readlink(layout.current), join("versions", "0.1.0"));
        assert.equal(await readLink(layout, "current"), "0.1.0");
        assert.equal(await readLink(layout, "previous"), null);
    });

    it("removes the link when given null, and does nothing when it is already gone", async () => {
        const home = await freshHome();
        const layout = programLayout(home);
        await makeVersion(home, "0.1.0");
        await switchLink(layout, "previous", "0.1.0");
        await switchLink(layout, "previous", null);
        assert.equal(await readLink(layout, "previous"), null);
        await switchLink(layout, "previous", null);
    });

    it("leaves no temporary link behind", async () => {
        const home = await freshHome();
        const layout = programLayout(home);
        await makeVersion(home, "0.1.0");
        await makeVersion(home, "0.2.0");
        await switchLink(layout, "current", "0.1.0");
        await switchLink(layout, "current", "0.2.0");
        assert.deepEqual((await readdir(layout.root)).sort(), ["current", "versions"]);
    });

    it("refuses a version text that is not a version, creating no link", async () => {
        const layout = programLayout(await freshHome());
        await assert.rejects(switchLink(layout, "current", "../escape"), ProgramLayoutError);
        assert.equal(await readLink(layout, "current"), null);
    });

    it("resolves current to a complete version at every moment of a switch", async () => {
        const home = await freshHome();
        const layout = programLayout(home);
        for (const version of ["0.1.0", "0.2.0"]) {
            await makeVersion(home, version);
            await markComplete(layout.versionDir(version), version);
        }
        await switchLink(layout, "current", "0.1.0");
        let switching = true;
        const seen = new Set<string>();
        const reader = (async () => {
            while (switching) {
                const marker = await stat(join(layout.current, "complete")).then(
                    () => join(layout.current, "complete"),
                    (error: unknown) => assert.fail(`current did not resolve: ${String(error)}`),
                );
                seen.add(marker);
                await new Promise((resolve) => setImmediate(resolve));
            }
        })();
        for (let round = 0; round < 200; round += 1) {
            await switchLink(layout, "current", round % 2 === 0 ? "0.2.0" : "0.1.0");
        }
        switching = false;
        await reader;
        assert.ok(seen.size > 0, "the reader saw current resolve");
    });
});

describe("removeVersion", () => {
    it("removes a version no link names", async () => {
        const home = await freshHome();
        const layout = programLayout(home);
        await makeVersion(home, "0.1.0");
        await makeVersion(home, "0.2.0");
        await switchLink(layout, "current", "0.2.0");
        await removeVersion(layout, "0.1.0");
        await assert.rejects(lstat(layout.versionDir("0.1.0")), { code: "ENOENT" });
    });

    for (const which of ["current", "previous"] as const) {
        it(`refuses while ${which} names the version and leaves the folder`, async () => {
            const home = await freshHome();
            const layout = programLayout(home);
            await makeVersion(home, "0.1.0");
            await switchLink(layout, which, "0.1.0");
            await assert.rejects(
                removeVersion(layout, "0.1.0"),
                (error: unknown) => error instanceof ProgramLayoutError && error.message.includes(which),
            );
            assert.ok((await stat(layout.versionDir("0.1.0"))).isDirectory());
        });
    }
});

describe("modes", () => {
    it("creates the program folder with mode 0700", async () => {
        const home = await freshHome();
        const layout = programLayout(home);
        await makeVersion(home, "0.1.0");
        await switchLink(layout, "current", "0.1.0");
        assert.equal((await stat(layout.root)).mode & 0o777, 0o700);
    });

    it("creates the program folder with mode 0700 under a permissive umask", async () => {
        const home = await freshHome();
        const layout = programLayout(home);
        const previousMask = process.umask(0o000);
        try {
            await switchLink(layout, "current", null);
            await switchLink(layout, "previous", "0.1.0");
        } finally {
            process.umask(previousMask);
        }
        assert.equal((await stat(layout.root)).mode & 0o777, 0o700);
    });
});
