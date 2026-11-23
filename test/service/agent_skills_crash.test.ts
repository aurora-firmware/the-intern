import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
    type DaemonProcess,
    type FakeScript,
    type StartDaemonOptions,
    startDaemon,
} from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { scaled } from "../support/time_scale.ts";

const POLL_INTERVAL_MS = 50;
const WAIT_BOUND_MS = scaled(30_000);
const TEST_TIMEOUT_MS = scaled(90_000);
const FAKE_PROVIDER = "faux";
const FAKE_MODEL = "faux-1";
const CODE_REVIEW = "code-review";
const SEAT_RECORD_KIND = "intern.seat";
const ENTRIES_LIMIT = 200;

type Listing = { seat: { role: string } | null; status: string; enabledSkills: string[] };
type Entry = { kind: string; data: unknown };
type SeatPoint = NonNullable<StartDaemonOptions["killAtSeatChange"]>;

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

/** A data folder whose internal skills folder also holds `code-review`, and a pi agent folder defaulting to the fake model. */
async function hermetic(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    envs.push(env);
    await writeFile(
        join(env.piAgentDir, "settings.json"),
        JSON.stringify({ defaultProvider: FAKE_PROVIDER, defaultModel: FAKE_MODEL }),
    );
    const skillFolder = join(env.dataDir, "skills", CODE_REVIEW);
    await mkdir(skillFolder, { recursive: true });
    await writeFile(
        join(skillFolder, "SKILL.md"),
        `---\nname: ${CODE_REVIEW}\ndescription: Review code.\n---\n\nBody of ${CODE_REVIEW}.\n`,
    );
    return env;
}

function start(env: HermeticEnv, extra: Partial<StartDaemonOptions> = {}): DaemonProcess {
    const script: FakeScript = "echo";
    const daemon = startDaemon({ hermetic: env, script, turnEndRule: false, ...extra });
    daemons.push(daemon);
    return daemon;
}

async function crash(daemon: DaemonProcess): Promise<void> {
    daemon.kill9();
    await daemon.exited;
}

async function untilTrue(isWanted: () => Promise<boolean>, description: string): Promise<void> {
    const deadline = Date.now() + WAIT_BOUND_MS;
    while (Date.now() < deadline) {
        if (await isWanted()) return;
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    assert.fail(`Timed out waiting for ${description}`);
}

const listingOf = async (daemon: DaemonProcess, conversationId: string): Promise<Listing> =>
    (await daemon.invoke("conversations.get", { conversationId })) as Listing;

/** Creates a job for `role` and returns its idle lead conversation. */
async function idleLead(daemon: DaemonProcess, text: string, role?: string): Promise<string> {
    const job = (await daemon.invoke("jobs.create", { text, ...(role !== undefined && { role }) })) as {
        leadConversation?: string;
    };
    assert.ok(job.leadConversation, "the created job names its lead conversation");
    const leadId = job.leadConversation;
    await untilTrue(async () => (await listingOf(daemon, leadId)).status === "idle", "the lead to be idle");
    return leadId;
}

async function seatRecordCount(daemon: DaemonProcess, conversationId: string): Promise<number> {
    const { entries } = (await daemon.invoke("conversations.entries", {
        conversationId,
        limit: ENTRIES_LIMIT,
    })) as { entries: Entry[] };
    return entries.filter((entry) => entry.kind === SEAT_RECORD_KIND).length;
}

describe("kill -9 after a skill is enabled", () => {
    it("keeps the skill in the enabled set of the restarted daemon", { timeout: TEST_TIMEOUT_MS }, async () => {
        const env = await hermetic();
        const first = start(env);
        await first.ready;
        const leadId = await idleLead(first, "lead work");
        await first.invoke("skills.enable", { name: CODE_REVIEW, conversation: leadId });
        await crash(first);

        const second = start(env);
        await second.ready;

        assert.ok((await listingOf(second, leadId)).enabledSkills.includes(CODE_REVIEW));
    });
});

describe("kill -9 at each point of a handoff from an agent with code-review to gp", () => {
    const points: { point: SeatPoint; role: string; records: number }[] = [
        { point: "before", role: "bob", records: 1 },
        { point: "after", role: "gp", records: 2 },
    ];
    for (const { point, role, records } of points) {
        it(`holds one whole seat when killed ${point} the commit`, { timeout: TEST_TIMEOUT_MS }, async () => {
            const env = await hermetic();
            const first = start(env, { killAtSeatChange: point });
            await first.ready;
            const leadId = await idleLead(first, "lead work");
            await first.invoke("skills.enable", { name: CODE_REVIEW, conversation: leadId });
            const handoff = first
                .invoke("conversations.seat", { conversationId: leadId, role: "gp", reset: { note: "NOTE" } })
                .catch(() => undefined);
            await first.exited;
            await handoff;

            const second = start(env);
            await second.ready;

            const listing = await listingOf(second, leadId);
            const gpDefaults = (await listingOf(second, await idleLead(second, "gp work", "gp"))).enabledSkills;
            assert.equal(listing.seat?.role, role);
            assert.equal(await seatRecordCount(second, leadId), records);
            if (role === "bob")
                assert.ok(listing.enabledSkills.includes(CODE_REVIEW), "the old seat keeps code-review");
            else assert.deepEqual(listing.enabledSkills, gpDefaults, "gp's seat holds gp's defaults");
            assert.equal(gpDefaults.includes(CODE_REVIEW), false, "gp's defaults hold no code-review");
        });
    }
});
