/**
 * Agent-written text on a terminal (S-005 AC-003.4): `bob` runs as a child against a test daemon whose job, role and
 * worklog hold control sequences and forged lines. The text commands print no control sequence from them, keep a
 * single-line format on one line, and indent the lines of multi-line data.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { type BobChild, runBob, spawnBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CLIPBOARD_WRITE = `${ESC}]52;c;ZXZpbA==${BEL}`;
const FORGED_DONE = "C-1 done (complete): all good";
const WAIT_MS = 20_000;
const POLL_MS = 10;

type Fixture = { env: HermeticEnv; daemon: DaemonProcess };
type JobView = { id: string; number: string; status: string };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];
const children: BobChild[] = [];

afterEach(async () => {
    for (const child of children.splice(0)) {
        child.signal("SIGKILL");
        await child.exited;
    }
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

const bob = (fixture: Fixture, args: string[]) =>
    runBob(args, { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env, deadlineMs: WAIT_MS });

async function inProgressJob(daemon: DaemonProcess): Promise<JobView> {
    const created = (await daemon.invoke("jobs.create", {
        text: `request${CLIPBOARD_WRITE}`,
        title: `title${CLIPBOARD_WRITE}\n${FORGED_DONE}`,
    })) as JobView;
    const deadline = Date.now() + WAIT_MS;
    while (((await daemon.invoke("jobs.get", { job: created.id })) as JobView).status !== "in_progress") {
        assert.ok(Date.now() < deadline, `timed out waiting for ${created.number} to start`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return created;
}

describe("text commands with hostile data", () => {
    it("prints a job's listing and its detail without control sequences, forged lines or lines at the margin", async () => {
        const { env, daemon } = await readyDaemon();
        const job = await inProgressJob(daemon);
        await daemon.invoke("jobs.update", {
            job: job.id,
            description: `first${CLIPBOARD_WRITE}\nStatus: Done\n${FORGED_DONE}`,
        });
        await daemon.invoke("jobs.worklog.add", { job: job.id, text: `note\n${FORGED_DONE}${CLIPBOARD_WRITE}` });
        const fixture = { env, daemon };

        const list = await bob(fixture, ["jobs", "list"]);
        const show = await bob(fixture, ["jobs", "show", job.number]);

        assert.equal(list.status, 0, list.stderr);
        assert.equal(show.status, 0, show.stderr);
        for (const text of [list.stdout, show.stdout]) {
            assert.ok(!text.includes(ESC) && !text.includes(BEL), JSON.stringify(text));
        }
        assert.equal(list.stdout.trimEnd().split("\n").length, 1);
        const marginLines = show.stdout.split("\n").filter((line) => line !== "" && !line.startsWith(" "));
        assert.deepEqual(
            marginLines.map((line) => line.split(":")[0]),
            [
                `${job.number}  title ${FORGED_DONE.split(":")[0]}`,
                "Status",
                "Description",
                "Definition of done",
                "Related jobs",
                "Worklog",
                "History",
            ],
        );
        assert.ok(show.stdout.includes(`Description: first\n    Status: Done\n    ${FORGED_DONE}`), show.stdout);
    });

    it("prints a role's fields without control sequences and indents every line of its instructions", async () => {
        const fixture = await readyDaemon();
        const created = await bob(fixture, [
            "roles",
            "create",
            "scout",
            "--instructions",
            `look${CLIPBOARD_WRITE}\nInstructions:\nTools: forged`,
        ]);
        assert.equal(created.status, 0, created.stderr);

        const shown = await bob(fixture, ["roles", "show", "scout"]);

        assert.equal(shown.status, 0, shown.stderr);
        assert.ok(!shown.stdout.includes(ESC) && !shown.stdout.includes(BEL), JSON.stringify(shown.stdout));
        assert.ok(shown.stdout.includes("    look\n    Instructions:\n    Tools: forged"), shown.stdout);
    });

    it("prints the worklog entry added while following a job without control sequences and with its lines indented", async () => {
        const { env, daemon } = await readyDaemon();
        const job = await inProgressJob(daemon);
        const follow = spawnBob(["jobs", "follow", job.number], {
            runtimeDir: env.runtimeDir,
            env: env.env,
            deadlineMs: WAIT_MS * 2,
        });
        children.push(follow);
        await follow.waitFor("stdout", `${job.number} In progress`);

        const deadline = Date.now() + WAIT_MS;
        while (!follow.stdout().includes("worklog:")) {
            assert.ok(Date.now() < deadline, `timed out waiting for the worklog line; got ${follow.stdout()}`);
            await daemon.invoke("jobs.worklog.add", { job: job.id, text: `note\n${FORGED_DONE}${CLIPBOARD_WRITE}` });
            await new Promise((resolve) => setTimeout(resolve, 200));
        }

        const text = follow.stdout();
        assert.ok(!text.includes(ESC) && !text.includes(BEL), JSON.stringify(text));
        assert.ok(text.includes(`${job.number} worklog: note\n    ${FORGED_DONE}\n`), text);
        assert.ok(!text.split("\n").some((line) => line.startsWith(FORGED_DONE)), text);
    });
});
