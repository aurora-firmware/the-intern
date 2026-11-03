import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, type FakeScript, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

const WAIT_MS = 20_000;
const POLL_MS = 10;
const STEER_TEXT = "check the logs first";
const ENTRY_LIMIT = 500;
// Compacting keeps only the newest tokens, so even a short conversation has something to compact.
const COMPACTING_SETTINGS = {
    defaultProvider: "faux",
    defaultModel: "faux-1",
    compaction: { keepRecentTokens: 1 },
};

type JobView = { id: string; number: string; status: string; leadConversation?: string };
type Listing = { id: string; jobId: string | null; isFrontDesk: boolean; status: string };
type Fixture = { env: HermeticEnv; daemon: DaemonProcess };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(script: FakeScript = "echo"): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(join(env.piAgentDir, "settings.json"), JSON.stringify(COMPACTING_SETTINGS));
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

const bob = (fixture: Fixture, args: string[]) =>
    runBob(args, { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env });

async function until(isWanted: () => Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await isWanted())) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function listings(daemon: DaemonProcess): Promise<Listing[]> {
    return (await daemon.invoke("conversations.list", {})) as Listing[];
}

async function transcriptOf(daemon: DaemonProcess, conversationId: string): Promise<string> {
    return JSON.stringify(await daemon.invoke("conversations.entries", { conversationId, limit: ENTRY_LIMIT }));
}

async function startedJob(daemon: DaemonProcess): Promise<JobView> {
    const created = (await daemon.invoke("jobs.create", { text: "Pick the database" })) as JobView;
    let job = created;
    await until(async () => {
        job = (await daemon.invoke("jobs.get", { job: created.id })) as JobView;
        return job.status === "in_progress" && job.leadConversation !== undefined;
    }, `${created.number} to start`);
    return job;
}

// The lead's first answer comes back at once, so the job's lead is idle and holds one finished run.
async function idleLead(fixture: Fixture): Promise<{ job: JobView; id: string }> {
    const job = await startedJob(fixture.daemon);
    const id = job.leadConversation as string;
    await until(async () => (await transcriptOf(fixture.daemon, id)).includes("pi.assistant"), "the first answer");
    return { job, id };
}

async function closedConversation(fixture: Fixture): Promise<string> {
    const { job, id } = await idleLead(fixture);
    await fixture.daemon.invoke("jobs.cancel", { job: job.id, justification: "Not needed" });
    await until(async () => (await listings(fixture.daemon)).find((l) => l.id === id)?.status === "closed", "closing");
    return id;
}

describe("bob conversations", () => {
    it("lists a job's conversations, holds a steer with the command line way in, shows it and stops the run", async () => {
        const fixture = await readyDaemon("gated");
        const job = await startedJob(fixture.daemon);
        const id = job.leadConversation as string;

        const listed = await bob(fixture, ["conversations", "list", "--job", job.number]);
        const sent = await bob(fixture, ["conversations", "send", id, STEER_TEXT]);
        fixture.daemon.releaseRuns();
        await until(async () => (await transcriptOf(fixture.daemon, id)).includes(STEER_TEXT), "the steer");
        const shown = await bob(fixture, ["conversations", "show", id]);
        const stopped = await bob(fixture, ["conversations", "stop", id]);

        assert.equal(listed.status, 0, listed.stderr);
        assert.equal(listed.stdout.trim().split("\n").length, 1);
        assert.ok(listed.stdout.startsWith(`${id}  `), listed.stdout);
        assert.equal(sent.status, 0, sent.stderr);
        assert.equal(sent.stdout, `steered to ${id}\n`);
        assert.equal(shown.status, 0, shown.stderr);
        assert.match(shown.stdout, new RegExp(`steer from team member via command line: ${STEER_TEXT}`));
        assert.equal(stopped.status, 0, stopped.stderr);
    });

    it("prints the conversation, its transcript and its invoked conversations as one object keyed by operation with --json", async () => {
        const fixture = await readyDaemon();
        const { id } = await idleLead(fixture);

        const result = await bob(fixture, ["conversations", "show", id, "--json"]);

        assert.equal(result.status, 0, result.stderr);
        const printed = JSON.parse(result.stdout) as Record<string, unknown>;
        assert.deepEqual(Object.keys(printed), [
            "conversations.get",
            "conversations.entries",
            "conversations.invocations",
        ]);
        assert.deepEqual(
            printed["conversations.get"],
            await fixture.daemon.invoke("conversations.get", { conversationId: id }),
        );
    });

    it("holds a follow-up and refuses nothing of its own when --follow-up is given", async () => {
        const fixture = await readyDaemon();
        const { id } = await idleLead(fixture);

        const result = await bob(fixture, ["conversations", "send", id, STEER_TEXT, "--follow-up"]);

        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout, `submitted to ${id}\n`);
    });

    it("exits 2 when --follow-up and --reject are both given", async () => {
        const fixture = await readyDaemon();
        const { id } = await idleLead(fixture);

        const result = await bob(fixture, ["conversations", "send", id, STEER_TEXT, "--follow-up", "--reject"]);

        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
    });

    it("seats a conversation in another role, resets it and compacts it, each with a record in the transcript", async () => {
        const fixture = await readyDaemon();
        const { id } = await idleLead(fixture);

        const seated = await bob(fixture, ["conversations", "seat", id, "--role", "gp"]);
        const compacted = await bob(fixture, ["conversations", "compact", id, "--instructions", "keep the plan"]);
        const reset = await bob(fixture, ["conversations", "reset", id]);

        for (const result of [seated, compacted, reset]) assert.equal(result.status, 0, result.stderr);
        const records = JSON.parse(await transcriptOf(fixture.daemon, id)).entries as {
            kind: string;
            data: { next?: { role: string }; actor?: { wayIn: string } };
        }[];
        const seatRecord = records.find((entry) => entry.kind === "intern.seat" && entry.data.next?.role === "gp");
        assert.equal(seatRecord?.data.actor?.wayIn, "command line");
        assert.ok(records.some((entry) => entry.kind === "pi.compaction"));
        assert.ok(records.some((entry) => entry.kind === "pi.reset"));
        assert.match(seated.stdout, new RegExp(`^${id} seated as gp `));
    });

    it("writes a seat record that resets the conversation with --reset and --note", async () => {
        const fixture = await readyDaemon();
        const { id } = await idleLead(fixture);

        const result = await bob(fixture, [
            "conversations",
            "seat",
            id,
            "--role",
            "gp",
            "--reset",
            "--note",
            "start over",
        ]);

        assert.equal(result.status, 0, result.stderr);
        const transcript = await transcriptOf(fixture.daemon, id);
        assert.ok(transcript.includes("start over"), transcript);
    });

    it("exits 1 with the service's refusal and leaves the seat unchanged for an unknown role", async () => {
        const fixture = await readyDaemon();
        const { id } = await idleLead(fixture);
        const before = await fixture.daemon.invoke("conversations.get", { conversationId: id });

        const result = await bob(fixture, ["conversations", "seat", id, "--role", "nobody"]);

        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, /^(not_found|invalid_input): .+\n$/);
        assert.deepEqual(await fixture.daemon.invoke("conversations.get", { conversationId: id }), before);
    });

    it("marks the front desk's line as the front desk, with no job", async () => {
        const fixture = await readyDaemon();
        const desk = (await listings(fixture.daemon)).find((listing) => listing.isFrontDesk) as Listing;

        const result = await bob(fixture, ["conversations", "list"]);

        assert.equal(result.status, 0, result.stderr);
        const line = result.stdout.split("\n").find((candidate) => candidate.startsWith(`${desk.id}  `));
        assert.match(line ?? "", /^\S+  front desk  /);
    });

    it("lists a conversation of a Done job as closed and refuses send, stop, reset, seat and compact with conflict", async () => {
        const fixture = await readyDaemon();
        const id = await closedConversation(fixture);

        const listed = await bob(fixture, ["conversations", "list"]);
        const refusals = await Promise.all([
            bob(fixture, ["conversations", "send", id, STEER_TEXT]),
            bob(fixture, ["conversations", "stop", id]),
            bob(fixture, ["conversations", "reset", id]),
            bob(fixture, ["conversations", "seat", id, "--role", "gp"]),
            bob(fixture, ["conversations", "compact", id]),
        ]);

        const line = listed.stdout.split("\n").find((candidate) => candidate.startsWith(`${id}  `));
        assert.match(line ?? "", /  closed  /);
        for (const result of refusals) {
            assert.equal(result.status, 1, result.stderr);
            assert.equal(result.stdout, "");
            assert.match(result.stderr, /^conflict: .+\n$/);
        }
    });
});
