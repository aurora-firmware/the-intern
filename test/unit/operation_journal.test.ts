import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
    finishCutOffOperation,
    type OperationJournal,
    readJournal,
    removeJournal,
    stepDone,
    writeJournal,
} from "../../src/install/operation_journal.ts";
import { type ProgramLayout, programLayout } from "../../src/install/program_layout.ts";
import { scaled } from "../support/time_scale.ts";

const JOURNAL_MODULE = fileURLToPath(new URL("../../src/install/operation_journal.ts", import.meta.url));
const HOOK_VARIABLE = "BOB_INSTALL_TEST_STOP_AFTER";
const PADDING_BYTES = 2_000_000;

function journal(overrides: Partial<OperationJournal> = {}): OperationJournal {
    return {
        format: 1,
        operation: "upgrade",
        from: "1.0.0",
        to: "1.1.0",
        copyName: null,
        setAsideName: null,
        currentBefore: "1.0.0",
        previousBefore: null,
        lastStep: null,
        ...overrides,
    };
}

describe("operation journal", () => {
    let home: string;
    let layout: ProgramLayout;

    beforeEach(async () => {
        home = await mkdtemp(join(tmpdir(), "operation-journal-"));
        layout = programLayout(home);
    });

    afterEach(async () => {
        await rm(home, { recursive: true, force: true });
    });

    it("reads back what it wrote, owner-only", async () => {
        await writeJournal(layout, journal({ lastStep: "held" }));
        assert.deepEqual(await readJournal(layout), journal({ lastStep: "held" }));
        assert.equal((await stat(layout.journal)).mode & 0o777, 0o600);
    });

    it("reads null when there is no journal and removes it without complaint", async () => {
        assert.equal(await readJournal(layout), null);
        await writeJournal(layout, journal());
        await removeJournal(layout);
        assert.equal(await readJournal(layout), null);
        await removeJournal(layout);
    });

    it("never lets a concurrent reader see a partial journal while it is replaced", async () => {
        const old = journal({ copyName: "o".repeat(PADDING_BYTES) });
        const next = journal({ copyName: "n".repeat(PADDING_BYTES), lastStep: "copied" });
        await writeJournal(layout, old);
        let writing = true;
        const writer = (async () => {
            for (let round = 0; round < 15; round++) await writeJournal(layout, round % 2 === 0 ? next : old);
            writing = false;
        })();
        let reads = 0;
        while (writing) {
            const seen = JSON.parse(await readFile(layout.journal, "utf8")) as OperationJournal;
            assert.ok(seen.copyName === old.copyName || seen.copyName === next.copyName);
            reads++;
        }
        await writer;
        assert.ok(reads > 0);
    });

    it("refuses a journal of a newer format, naming the file", async () => {
        await mkdir(layout.root, { recursive: true });
        await writeFile(layout.journal, JSON.stringify({ ...journal(), format: 2 }), { mode: 0o600 });
        await assert.rejects(readJournal(layout), (error: Error) => {
            assert.ok(error.message.includes(layout.journal), error.message);
            return true;
        });
    });

    it("records the step in the journal when a step is done", async () => {
        const original = journal();
        await stepDone(layout, original, "held", { env: {}, writeError: () => {}, waitForResume: async () => {} });
        assert.equal((await readJournal(layout))?.lastStep, "held");
        assert.equal(original.lastStep, "held");
    });

    it("stops only at the step the hook variable names", async () => {
        const messages: string[] = [];
        let waited = 0;
        const io = {
            env: { [HOOK_VARIABLE]: "copied" },
            writeError: (text: string) => messages.push(text),
            waitForResume: async () => {
                waited++;
            },
        };
        await stepDone(layout, journal(), "held", io);
        assert.deepEqual(messages, []);
        await stepDone(layout, journal(), "copied", io);
        assert.deepEqual(messages, ["stopped after copied\n"]);
        assert.equal(waited, 1);
        assert.equal((await readJournal(layout))?.lastStep, "copied");
    });

    it("writes the stop notice and returns only after the process receives SIGUSR2", async () => {
        const script = [
            `import { stepDone } from ${JSON.stringify(JOURNAL_MODULE)};`,
            `import { programLayout } from ${JSON.stringify(join(JOURNAL_MODULE, "..", "program_layout.ts"))};`,
            `const journal = ${JSON.stringify(journal())};`,
            `await stepDone(programLayout(${JSON.stringify(home)}), journal, "copied");`,
            `process.stdout.write("returned\\n");`,
        ].join("\n");
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
            env: { ...process.env, [HOOK_VARIABLE]: "copied" },
            stdio: ["ignore", "pipe", "pipe"],
        });
        let out = "";
        let err = "";
        child.stdout.on("data", (chunk) => {
            out += chunk;
        });
        const stopped = new Promise<void>((resolve) => {
            child.stderr.on("data", (chunk) => {
                err += chunk;
                if (err.includes("stopped after copied")) resolve();
            });
        });
        const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
        const timer = setTimeout(() => child.kill("SIGKILL"), scaled(20_000));
        try {
            await stopped;
            await new Promise((resolve) => setTimeout(resolve, scaled(300)));
            assert.equal(out, "", "the child went on before SIGUSR2");
            assert.equal((await readJournal(layout))?.lastStep, "copied");
            child.kill("SIGUSR2");
            assert.equal(await exited, 0, err);
            assert.equal(out, "returned\n");
        } finally {
            clearTimeout(timer);
            child.kill("SIGKILL");
        }
    });

    describe("finishCutOffOperation", () => {
        function resumers() {
            const calls: Array<[string, OperationJournal]> = [];
            const make = (name: string) => async (found: OperationJournal) => {
                calls.push([name, found]);
            };
            return {
                calls,
                table: {
                    upgrade: make("upgrade"),
                    "switch-back": make("switch-back"),
                    "fresh-start": make("fresh-start"),
                    rollback: make("rollback"),
                },
            };
        }

        it("calls the resumer of the journal's operation with the journal", async () => {
            const found = journal({ operation: "rollback", lastStep: "switched" });
            await writeJournal(layout, found);
            const { calls, table } = resumers();
            await finishCutOffOperation(layout, table);
            assert.deepEqual(calls, [["rollback", found]]);
        });

        it("does nothing when there is no journal", async () => {
            const { calls, table } = resumers();
            await finishCutOffOperation(layout, table);
            assert.deepEqual(calls, []);
        });
    });
});
