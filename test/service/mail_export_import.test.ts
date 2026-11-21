/**
 * Saved mail in the export and the import (S-009 REQ-024: AC-024.1; S-004 REQ-016, REQ-017; ADR-011 decision 4): the
 * export of an instance with a triage job and its saved PDF is one database file; imported into an empty instance, it
 * lets the job's lead read the same PDF after the first start, and it carries no mail account and no secret.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, it } from "node:test";
import { composeMessage } from "../../src/mail/mime.ts";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const TEST_TIMEOUT_MS = scaled(90_000);
const WAIT_MS = scaled(20_000);
const POLL_MS = 10;
const ADDRESS = "bob@example.test";
const SENDER = "ann@example.test";
const PASSWORD = "s3cret";
const PLANTED_SECRET = "planted-client-secret";
const OWNER_ONLY_DIR_MODE = 0o700;
const PDF = Buffer.from(Array.from({ length: 10_240 }, (_, index) => (index * 31 + 7) % 256));

type Attachment = { name: string; size: number; path: string };
type JobDetail = {
    id: string;
    leadConversation?: string;
    email?: { message: { path: string; attachments: Attachment[] } | null };
};

const cleanups: (() => Promise<unknown>)[] = [];

afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until<T>(what: string, attempt: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const deadline = Date.now() + WAIT_MS;
    for (;;) {
        const found = await attempt();
        if (found !== undefined) return found;
        assert.ok(Date.now() < deadline, `timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
}

async function newEnv(): Promise<HermeticEnv> {
    const env = await createHermeticEnv();
    cleanups.push(() => env.dispose());
    return env;
}

async function stopDaemon(daemon: DaemonProcess): Promise<void> {
    daemon.kill9();
    await daemon.exited;
}

/** A rig whose account is signed in and watched by intake, with a secret in its secrets store. */
async function startSource(): Promise<MailRig> {
    const rig = await startMailRig({ accounts: [{ name: "work", address: ADDRESS, password: PASSWORD }] });
    cleanups.push(() => rig.stop());
    await rig.waitForStatus("work", "ready");
    await until("intake to watch the inbox", () =>
        rig.process().stderr().includes("mail intake watching") ? true : undefined,
    );
    const secrets = join(rig.env.stateDir, "secrets", "mail");
    await mkdir(secrets, { recursive: true, mode: OWNER_ONLY_DIR_MODE });
    await writeFile(join(secrets, "work.json"), JSON.stringify({ clientSecret: PLANTED_SECRET }));
    return rig;
}

/** The instance's triage job for the delivered email with its PDF, once the job exists. */
async function triageJobWithPdf(rig: MailRig): Promise<JobDetail> {
    const sent = await composeMessage({
        from: SENDER,
        to: [ADDRESS],
        subject: "the report",
        text: "see the report",
        attachments: [{ filename: "report.pdf", contentType: "application/pdf", content: PDF }],
    });
    rig.deliver(ADDRESS, sent.raw);
    const job = await rig.waitForJob(() => true);
    return (await rig.process().invoke("jobs.get", { job: job.id })) as JobDetail;
}

async function exportAndStop(rig: MailRig, file: string, cwd: string): Promise<void> {
    const result = await runBob(["export", file], { runtimeDir: rig.env.runtimeDir, env: rig.env.env, cwd });
    assert.equal(result.status, 0, result.stderr);
    await stopDaemon(rig.process());
}

function importInto(target: HermeticEnv, file: string) {
    const { configDir, stateDir, dataDir, runtimeDir } = target;
    const flags = ["--config-dir", configDir, "--state-dir", stateDir, "--data-dir", dataDir];
    return runBob(["import", file, ...flags, "--runtime-dir", runtimeDir], { env: target.env, cwd: target.root });
}

const pdfOf = (job: JobDetail): Attachment | undefined => job.email?.message?.attachments[0];

describe("saved mail in the export and the import", () => {
    it("writes one file that opens as a database and holds the saved message", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const source = await startSource();
        const job = await triageJobWithPdf(source);
        const holder = await newEnv();

        await exportAndStop(source, "backup.db", holder.root);

        const database = new DatabaseSync(join(holder.root, "backup.db"), { readOnly: true });
        try {
            const rows = database.prepare("SELECT job, raw FROM intern_mail_messages").all() as {
                job: string;
                raw: Uint8Array;
            }[];
            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.job, job.id);
            assert.ok(Buffer.from(rows[0]?.raw ?? []).includes(Buffer.from("report.pdf")));
        } finally {
            database.close();
        }
    });

    it("lets the job's lead read the identical PDF in an empty instance after the first start", {
        timeout: TEST_TIMEOUT_MS,
    }, async () => {
        const source = await startSource();
        const job = await triageJobWithPdf(source);
        const holder = await newEnv();
        await exportAndStop(source, "backup.db", holder.root);
        const target = await newEnv();

        const imported = await importInto(target, join(holder.root, "backup.db"));

        assert.equal(imported.status, 0, imported.stderr);
        assert.equal(existsSync(join(target.stateDir, "mail")), false, "the import writes no copy");
        const daemon = startDaemon({ hermetic: target, turnEndRule: false });
        cleanups.push(() => stopDaemon(daemon));
        await daemon.ready;
        const restored = (await daemon.invoke("jobs.get", { job: job.id })) as JobDetail;
        assert.ok(restored.leadConversation, "the job has its lead");
        const attachment = pdfOf(restored);
        assert.ok(attachment, "the job lists the PDF");
        assert.equal(attachment.name, "report.pdf");
        assert.ok(attachment.path.startsWith(join(target.stateDir, "mail")), attachment.path);
        assert.deepEqual(await readFile(attachment.path), PDF);
    });

    it("leaves the imported instance with no mail account and no secret", { timeout: TEST_TIMEOUT_MS }, async () => {
        const source = await startSource();
        await triageJobWithPdf(source);
        const holder = await newEnv();
        await exportAndStop(source, "backup.db", holder.root);
        const target = await newEnv();
        const imported = await importInto(target, join(holder.root, "backup.db"));
        assert.equal(imported.status, 0, imported.stderr);

        const daemon = startDaemon({ hermetic: target, turnEndRule: false });
        cleanups.push(() => stopDaemon(daemon));
        await daemon.ready;

        assert.equal(existsSync(join(target.configDir, "config.toml")), false);
        assert.deepEqual(await readdir(join(target.stateDir, "secrets"), { recursive: true }), []);
        const status = (await daemon.invoke("daemon.status", {})) as { mailAccounts: unknown[] };
        assert.deepEqual(status.mailAccounts, []);
        const { accounts } = (await daemon.invoke("mail.accounts.list", {})) as { accounts: unknown[] };
        assert.deepEqual(accounts, []);
    });
});
