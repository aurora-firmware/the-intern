import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { type ProgramLayout, programLayout } from "../../src/install/program_layout.ts";
import {
    hold,
    nodeCommandRunner,
    readServiceRecord,
    removeServiceRecord,
    type ServiceRecord,
    unhold,
    writeServiceRecord,
} from "../../src/install/service_manager.ts";

let scratch: string;
let counter = 0;

before(async () => {
    scratch = await mkdtemp(join(tmpdir(), "service-manager-"));
});

after(async () => {
    await rm(scratch, { recursive: true, force: true });
});

async function freshLayout() {
    counter += 1;
    const home = join(scratch, `home-${counter}`);
    await mkdir(home);
    return programLayout(home);
}

async function writeRecordFile(layout: ProgramLayout, text: string): Promise<void> {
    await mkdir(layout.root, { recursive: true });
    await writeFile(layout.serviceRecord, text);
}

const RECORD: ServiceRecord = {
    format: 1,
    platform: "linux-x64",
    label: "the-intern",
    configDir: "/h/config",
    stateDir: "/h/state",
    dataDir: "/h/data",
    runtimeDir: "/h/runtime",
    piAgentDir: "/h/pi",
    path: "/usr/bin:/bin",
    lingerTurnedOn: true,
};

async function exists(path: string): Promise<boolean> {
    try {
        await stat(path);
        return true;
    } catch {
        return false;
    }
}

describe("the registration record", () => {
    it("reads back the record it wrote, in an owner-only file", async () => {
        const layout = await freshLayout();
        await writeServiceRecord(layout, RECORD);
        assert.deepEqual(await readServiceRecord(layout), RECORD);
        assert.equal((await stat(layout.serviceRecord)).mode & 0o777, 0o600);
    });

    it("keeps the owner-only mode when it replaces an earlier record", async () => {
        const layout = await freshLayout();
        await writeServiceRecord(layout, RECORD);
        await writeServiceRecord(layout, { ...RECORD, lingerTurnedOn: false });
        assert.equal((await readServiceRecord(layout))?.lingerTurnedOn, false);
        assert.equal((await stat(layout.serviceRecord)).mode & 0o777, 0o600);
    });

    it("reads null when there is no record", async () => {
        assert.equal(await readServiceRecord(await freshLayout()), null);
    });

    it("refuses a newer format, naming the file", async () => {
        const layout = await freshLayout();
        await writeRecordFile(layout, JSON.stringify({ ...RECORD, format: 2 }));
        await assert.rejects(readServiceRecord(layout), (error: Error) => {
            assert.ok(error.message.includes(layout.serviceRecord), error.message);
            assert.match(error.message, /format is 2/);
            return true;
        });
    });

    it("refuses a file that is not valid JSON, naming the file", async () => {
        const layout = await freshLayout();
        await writeRecordFile(layout, "{nope");
        await assert.rejects(readServiceRecord(layout), (error: Error) => error.message.includes(layout.serviceRecord));
    });

    it("refuses a file with no format number, naming the file", async () => {
        const layout = await freshLayout();
        await writeRecordFile(layout, "{}");
        await assert.rejects(readServiceRecord(layout), (error: Error) => error.message.includes(layout.serviceRecord));
    });

    it("removes the record, and removing none is not an error", async () => {
        const layout = await freshLayout();
        await writeServiceRecord(layout, RECORD);
        await removeServiceRecord(layout);
        assert.equal(await exists(layout.serviceRecord), false);
        await removeServiceRecord(layout);
    });
});

describe("the hold file", () => {
    it("exists after hold and is gone after unhold", async () => {
        const layout = await freshLayout();
        await hold(layout);
        assert.equal(await exists(layout.holdFile), true);
        await unhold(layout);
        assert.equal(await exists(layout.holdFile), false);
    });

    it("holds twice and unholds with none without error", async () => {
        const layout = await freshLayout();
        await unhold(layout);
        await hold(layout);
        await hold(layout);
        assert.equal(await exists(layout.holdFile), true);
    });
});

describe("the node command runner", () => {
    it("returns the code, stdout and stderr of a command", async () => {
        const result = await nodeCommandRunner(process.execPath, [
            "-e",
            "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
        ]);
        assert.deepEqual(result, { code: 3, stdout: "out", stderr: "err" });
    });

    it("returns a non-zero code for a command that does not exist", async () => {
        const result = await nodeCommandRunner(join(scratch, "no-such-command"), []);
        assert.notEqual(result.code, 0);
        assert.match(result.stderr, /no-such-command/);
    });
});
