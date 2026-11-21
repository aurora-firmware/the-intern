import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Page } from "playwright-core";
import { launchBrowser, pageUrl } from "../support/browser.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { TEST_CA_FILE } from "../support/fake_mail_server.ts";
import { type MailRig, startMailRig } from "../support/mail_rig.ts";
import { scaled } from "../support/time_scale.ts";

const WAIT_MS = scaled(30_000);
const POLL_MS = 100;
const STOP_TIMEOUT_MS = scaled(20_000);
const TEST_TIMEOUT_MS = scaled(120_000);
const CLOCK_START = "2026-03-02T09:00:00.000Z";
const LOOPBACK = "127.0.0.1";
const GOOD = { name: "work", address: "work@example.test", password: "work-secret" };
const BROKEN = { name: "broken", address: "broken@example.test", password: "x", isKnownToServer: false };
const NOTICE_TO = "team@example.test";
const ADDED = "added";

const card = (name: string) => `main .mail-account[data-account="${name}"]`;
const NOTICE = "main .mail-notice";

type Listed = { accounts: { name: string; status: string; lastError?: { message: string } }[] };

const rigs: MailRig[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const rig of rigs.splice(0)) await rig.stop();
});

/** The rig's daemon has no network listener, so another with one takes its directories, as `listeners_mail` does. */
async function startServer(): Promise<{ rig: MailRig; daemon: DaemonProcess; port: number }> {
    const rig = await startMailRig({ accounts: [GOOD, BROKEN], clockStart: new Date(CLOCK_START) });
    rigs.push(rig);
    const first = rig.process();
    first.signal("SIGTERM");
    await Promise.race([first.exited, sleep(STOP_TIMEOUT_MS, undefined, { ref: false })]);
    const daemon = startDaemon({
        hermetic: { ...rig.env, env: { ...rig.env.env, NODE_EXTRA_CA_CERTS: TEST_CA_FILE } },
        mailClock: CLOCK_START,
        oauthEndpoints: rig.oauth.endpoints,
        networkListener: true,
    });
    daemons.push(daemon);
    await daemon.ready;
    return { rig, daemon, port: await daemon.networkPort() };
}

const listAccounts = async (daemon: DaemonProcess) =>
    ((await daemon.invoke("mail.accounts.list", {})) as Listed).accounts;

async function waitForReady(daemon: DaemonProcess): Promise<void> {
    await until("the account to be ready", async () => {
        const account = (await listAccounts(daemon)).find((candidate) => candidate.name === GOOD.name);
        return account?.status === "ready";
    });
}

async function until(describeWait: string, check: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + WAIT_MS;
    while (!(await check())) {
        if (Date.now() > deadline) throw new Error(`timed out waiting for ${describeWait}`);
        await sleep(POLL_MS);
    }
}

const waitForText = (page: Page, selector: string, expected: string) =>
    page.waitForFunction(
        ([target, wanted]) => document.querySelector(target)?.textContent?.trim() === wanted,
        [selector, expected] as [string, string],
        { timeout: WAIT_MS, polling: POLL_MS },
    );

const textOf = async (page: Page, selector: string) => ((await page.locator(selector).textContent()) ?? "").trim();

/** Marks the document, so a later check can tell that the page was not reloaded. */
const markDocument = (page: Page) => page.evaluate(() => Object.assign(globalThis, { notReloaded: true }));
const isMarked = (page: Page) => page.evaluate(() => (globalThis as { notReloaded?: boolean }).notReloaded === true);

describe("the Mail page in chrome", () => {
    it("lists each account with its settings and shows the notice settings at its address", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { rig, daemon, port } = await startServer();
        await daemon.invoke("mail.notices.set", { to: NOTICE_TO, from: GOOD.name });
        await waitForReady(daemon);
        await until("the broken account to fail", async () => {
            const broken = (await listAccounts(daemon)).find((account) => account.name === BROKEN.name);
            return broken?.lastError !== undefined;
        });
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();

        await page.goto(pageUrl(port, "/ui/#/mail"));
        await page.waitForSelector(card(GOOD.name), { timeout: WAIT_MS });
        await page.reload();
        await page.waitForSelector(card(GOOD.name), { timeout: WAIT_MS });

        t.assert.equal(new URL(page.url()).hash, "#/mail");
        t.assert.equal(await textOf(page, "main h2.page-heading"), "Mail");
        t.assert.equal(await textOf(page, `${card(GOOD.name)} .mail-address`), GOOD.address);
        t.assert.equal(await textOf(page, `${card(GOOD.name)} .mail-kind`), "owned");
        await waitForText(page, `${card(GOOD.name)} .mail-status`, "ready");
        t.assert.notEqual(await textOf(page, `${card(GOOD.name)} .mail-checked`), "");
        const broken = (await listAccounts(daemon)).find((account) => account.name === BROKEN.name);
        t.assert.equal(await textOf(page, `${card(BROKEN.name)} .mail-status`), broken?.status);
        t.assert.equal(await textOf(page, `${card(BROKEN.name)} .mail-error`), broken?.lastError?.message);
        t.assert.equal(await textOf(page, `${NOTICE} .mail-notice-to`), NOTICE_TO);
        t.assert.equal(await textOf(page, `${NOTICE} .mail-notice-from`), GOOD.name);
    });

    it("shows a new status of an account when it changes, without a reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer();
        await waitForReady(daemon);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/mail"));
        await waitForText(page, `${card(GOOD.name)} .mail-status`, "ready");
        await markDocument(page);

        await daemon.invoke("mail.accounts.change", { name: GOOD.name, password: "not-the-password" });
        let now = "ready";
        await until("the account to leave ready", async () => {
            now = (await listAccounts(daemon)).find((account) => account.name === GOOD.name)?.status ?? now;
            return now !== "ready";
        });

        await waitForText(page, `${card(GOOD.name)} .mail-status`, now);
        assert.equal(await isMarked(page), true);
    });

    it("shows an account added through mail.accounts.create, without a reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { rig, daemon, port } = await startServer();
        await waitForReady(daemon);
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/#/mail"));
        await page.waitForSelector(card(GOOD.name), { timeout: WAIT_MS });
        await markDocument(page);
        t.assert.equal(await page.locator(card(ADDED)).count(), 0);

        await daemon.invoke("mail.accounts.create", {
            name: ADDED,
            kind: "owned",
            address: "added@example.test",
            imap_host: LOOPBACK,
            imap_port: rig.server.imapPort,
            imap_security: "none",
            smtp_host: LOOPBACK,
            smtp_port: rig.server.smtpPort,
            smtp_security: "none",
            auth: "password",
            password: "added-secret",
        });

        await page.waitForSelector(card(ADDED), { timeout: WAIT_MS });
        t.assert.equal(await textOf(page, `${card(ADDED)} .mail-address`), "added@example.test");
        t.assert.equal(await isMarked(page), true);
    });

    it("links the Mail page in the sidebar", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { port } = await startServer();
        const browser = await launchBrowser(t, "chrome");
        if (browser === undefined) return;
        const page = await browser.newPage();
        await page.goto(pageUrl(port, "/ui/"));
        await page.locator(".sidebar a", { hasText: "Mail" }).click();

        await page.waitForSelector("main .mail", { timeout: WAIT_MS });
        t.assert.equal(new URL(page.url()).hash, "#/mail");
        t.assert.deepEqual(await page.locator(".sidebar a[aria-current='page']").allInnerTexts(), ["Mail"]);
    });
});
