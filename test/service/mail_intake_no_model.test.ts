/**
 * Intake when the triage role's seat has no model (S-009 REQ-007 as amended by CR-002, AC-007.2): the email is saved
 * and its triage job is created as usual; the lead holds the first input and one notice and waits, then runs once the
 * pi agent folder names a default model. The daemon runs on the fake model and the fake mail server.
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { NOTICE_KIND } from "../../src/host/model_wait.ts";
import type { DaemonStatus } from "../../src/service/status_operation.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(90_000);
const WAIT_MS = scaled(30_000);
const POLL_MS = 10;
const ADDRESS = "bob@example.test";
const SENDER = "ann@example.test";
const PASSWORD = "s3cret";
const SUBJECT = "needs triage";
const FAKE_DEFAULT = JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" });
const INPUT_KIND = "pi.user";

type Entry = { kind: string; data: unknown };
type Job = { id: string; leadConversation: string; status: string; request: { text: string } };
type ModelRequest = { firstUserText: string };

const rigs: MailRig[] = [];

afterEach(async () => {
    for (const rig of rigs.splice(0)) await rig.stop();
});

async function until(what: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

const rawMail = (): string =>
    `From: ${SENDER}\r\nTo: ${ADDRESS}\r\nSubject: ${SUBJECT}\r\nMessage-ID: <${SUBJECT.replaceAll(" ", "-")}@example.test>\r\n\r\nplease look\r\n`;

/** A rig whose pi agent folder names no default model, with the account's inbox watched. */
async function startWithNoDefault(): Promise<MailRig> {
    const rig = await startMailRig({ accounts: [{ name: "work", address: ADDRESS, password: PASSWORD }] });
    rigs.push(rig);
    await writeFile(join(rig.env.piAgentDir, "settings.json"), "{}");
    await rig.restart();
    await rig.waitForStatus("work", "ready");
    await until("intake to watch the inbox", async () => rig.process().stderr().includes("mail intake watching"));
    return rig;
}

describe("intake when the triage role has no model", () => {
    it("saves the email, makes the triage job, and runs its lead once a model is named (AC-007.2)", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const rig = await startWithNoDefault();
        const daemon = rig.process();
        const status = (await daemon.invoke("daemon.status", {})) as DaemonStatus;
        assert.notEqual(status.noDefaultModel, null);

        rig.deliver(ADDRESS, rawMail());
        const found = await rig.waitForJob(() => true);
        const job = (await daemon.invoke("jobs.get", { job: found.id })) as Job;
        assert.match(job.request.text, new RegExp(`Subject: ${SUBJECT}`));
        const savedPath = /^Saved message: (\/.+)$/m.exec(job.request.text)?.[1];
        assert.ok(savedPath, "the request names the saved message");

        const entriesOf = async (): Promise<Entry[]> =>
            (
                (await daemon.invoke("conversations.entries", {
                    conversationId: job.leadConversation,
                    limit: 100,
                })) as { entries: Entry[] }
            ).entries;
        await until("the lead's notice", async () => (await entriesOf()).some((entry) => entry.kind === NOTICE_KIND));
        // Other conversations, such as the front desk's resumption, make requests of their own: count the lead's.
        const modelRequests = async () =>
            ((await daemon.invoke("test.modelRequests", {})) as ModelRequest[]).filter((request) =>
                request.firstUserText.includes(`Subject: ${SUBJECT}`),
            );
        const waiting = (await entriesOf()).filter((entry) => [INPUT_KIND, NOTICE_KIND].includes(entry.kind));
        assert.deepEqual(
            waiting.map((entry) => entry.kind),
            [INPUT_KIND, NOTICE_KIND],
        );
        assert.ok(JSON.stringify(waiting[0]?.data).includes(`Subject: ${SUBJECT}`));
        assert.equal(((await daemon.invoke("jobs.get", { job: job.id })) as Job).status, "to_do");
        assert.deepEqual(await modelRequests(), []);

        await writeFile(join(rig.env.piAgentDir, "settings.json"), FAKE_DEFAULT);
        await until(
            "the daemon to see the default model",
            async () => ((await daemon.invoke("daemon.status", {})) as DaemonStatus).noDefaultModel === null,
        );
        await until("the lead's answer", async () =>
            (await entriesOf()).some((entry) => entry.kind === "pi.assistant"),
        );
        const requests = await modelRequests();
        assert.ok(requests.length >= 1, "the lead made a model request on its first input");
        const inputs = (await entriesOf()).filter((entry) => entry.kind === INPUT_KIND);
        assert.equal(inputs.length, 1, "the first input is not submitted again");
    });
});
