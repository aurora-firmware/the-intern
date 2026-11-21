import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
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
const CLOCK_STEP_MS = 2 * 60 * 60 * 1000;
const LOOPBACK = "127.0.0.1";
const GOOD = { name: "work", address: "work@example.test", password: "work-secret" };
const OWNED = { name: "added", address: "added@example.test", password: "added-secret" };
const NOTICE_TO = "team@example.test";
const ALLOWED = "boss@example.test";

const card = (name: string) => `main .mail-account[data-account="${name}"]`;
const create = (field: string) => `main .mail-create [name="${field}"]`;
const edit = (name: string, field: string) => `${card(name)} [name="${field}"]`;
const NOTICE = "main .mail-notice";
const RESULT = "main .mail-result";

type Listed = { accounts: { name: string; status: string; allow: string[] }[] };

const rigs: MailRig[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const rig of rigs.splice(0)) await rig.stop();
});

/** The rig's daemon has no network listener, so another with one takes its directories, as `mail_page` does. */
async function startServer(
    accounts: (typeof GOOD)[] = [],
): Promise<{ rig: MailRig; daemon: DaemonProcess; port: number }> {
    const rig = await startMailRig({ accounts, clockStart: new Date(CLOCK_START) });
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

async function refusalOf(call: Promise<unknown>): Promise<string> {
    try {
        await call;
    } catch (error) {
        return (error as Error).message;
    }
    return assert.fail("the call was not refused");
}

async function openMail(t: Parameters<typeof launchBrowser>[0], port: number): Promise<Page | undefined> {
    const browser = await launchBrowser(t, "chrome");
    if (browser === undefined) return undefined;
    const page = await browser.newPage();
    await page.goto(pageUrl(port, "/ui/#/mail"));
    await page.waitForSelector("main .mail-create", { timeout: WAIT_MS });
    return page;
}

async function fillCreateForm(page: Page, rig: MailRig): Promise<void> {
    await page.fill(create("name"), OWNED.name);
    await page.fill(create("address"), OWNED.address);
    await page.fill(create("imapHost"), LOOPBACK);
    await page.fill(create("imapPort"), String(rig.server.imapPort));
    await page.selectOption(create("imapSecurity"), "none");
    await page.fill(create("smtpHost"), LOOPBACK);
    await page.fill(create("smtpPort"), String(rig.server.smtpPort));
    await page.selectOption(create("smtpSecurity"), "none");
    await page.fill(create("password"), OWNED.password);
}

describe("the Mail page actions in chrome", () => {
    it("creates an owned account that turns ready and tests it, without a reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { rig, daemon, port } = await startServer();
        rig.server.addAccount({ address: OWNED.address, login: OWNED.address, password: OWNED.password });
        const page = await openMail(t, port);
        if (page === undefined) return;
        await markDocument(page);

        await fillCreateForm(page, rig);
        await page.click("main .mail-create-submit");

        await page.waitForSelector(card(OWNED.name), { timeout: WAIT_MS });
        t.assert.equal(await textOf(page, `${card(OWNED.name)} .mail-address`), OWNED.address);
        t.assert.equal(
            (await listAccounts(daemon)).some((account) => account.name === OWNED.name),
            true,
        );
        await page.click(`${card(OWNED.name)} .mail-test`);
        await waitForText(page, `${card(OWNED.name)} .mail-test-imap`, "IMAP: ok");
        t.assert.equal(await textOf(page, `${card(OWNED.name)} .mail-test-smtp`), "SMTP: ok");
        t.assert.equal(await isMarked(page), true);
    });

    it("shows the code and address of a microsoft sign-in and the account turning ready, without a reload", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { rig, daemon, port } = await startServer();
        rig.server.addAccount({ address: OWNED.address, login: OWNED.address, password: OWNED.password });
        await daemon.invoke("mail.accounts.create", {
            name: OWNED.name,
            kind: "owned",
            address: OWNED.address,
            imap_host: LOOPBACK,
            imap_port: rig.server.imapPort,
            imap_security: "none",
            smtp_host: LOOPBACK,
            smtp_port: rig.server.smtpPort,
            smtp_security: "none",
            auth: "microsoft",
            client_id: "client-1",
            tenant: "contoso",
        });
        const page = await openMail(t, port);
        if (page === undefined) return;
        await markDocument(page);

        await page.click(`${card(OWNED.name)} .mail-signin`);

        await page.waitForSelector(`${card(OWNED.name)} .mail-signin-code`, { timeout: WAIT_MS });
        const code = await textOf(page, `${card(OWNED.name)} .mail-signin-code`);
        t.assert.notEqual(code, "");
        t.assert.equal(
            await textOf(page, `${card(OWNED.name)} .mail-signin-address`),
            `${rig.oauth.endpoints.microsoftBase}/devicelogin`,
        );
        rig.oauth.enterCode(code);
        let clock = Date.parse(CLOCK_START);
        await until("the account to be ready on the page", async () => {
            const token = await storedAccessToken(rig, OWNED.name);
            if (token !== undefined) rig.server.acceptToken(OWNED.address, token);
            const status = await textOf(page, `${card(OWNED.name)} .mail-status`);
            if (status === "ready") return true;
            clock += CLOCK_STEP_MS;
            await daemon.invoke("test.mail.clock.set", { time: new Date(clock).toISOString() });
            return false;
        });
        t.assert.equal(await isMarked(page), true);
    });

    it("shows the result of changing the allowlist, setting the notice and removing an account", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { daemon, port } = await startServer([GOOD]);
        const page = await openMail(t, port);
        if (page === undefined) return;

        await page.fill(edit(GOOD.name, "allow"), ALLOWED);
        await page.click(`${card(GOOD.name)} .mail-save`);
        await waitForText(page, RESULT, `${GOOD.name} saved`);
        t.assert.deepEqual((await listAccounts(daemon)).find((account) => account.name === GOOD.name)?.allow, [
            ALLOWED,
        ]);

        await page.fill(`${NOTICE} [name="to"]`, NOTICE_TO);
        await page.selectOption(`${NOTICE} [name="from"]`, GOOD.name);
        await page.click(`${NOTICE} .mail-notice-save`);
        await waitForText(page, `${NOTICE} .mail-notice-to`, NOTICE_TO);
        await waitForText(page, RESULT, `Notice set: to ${NOTICE_TO}, from ${GOOD.name}`);
        await page.click(`${NOTICE} .mail-notice-clear`);
        await waitForText(page, RESULT, "Notice cleared");
        await waitForText(page, `${NOTICE} .mail-notice-to`, "Not set");

        await page.click(`${card(GOOD.name)} .mail-remove`);
        await waitForText(page, RESULT, `${GOOD.name} removed`);
        await page.waitForSelector(card(GOOD.name), { state: "detached", timeout: WAIT_MS });
        t.assert.deepEqual(await listAccounts(daemon), []);
    });

    it("leaves a secret field empty from the start and empties it after each call", {
        timeout: TEST_TIMEOUT_MS,
    }, async (t) => {
        const { rig, port } = await startServer();
        rig.server.addAccount({ address: OWNED.address, login: OWNED.address, password: OWNED.password });
        const page = await openMail(t, port);
        if (page === undefined) return;

        await fillCreateForm(page, rig);
        t.assert.equal(await page.inputValue(create("password")), OWNED.password);
        await page.click("main .mail-create-submit");
        await page.waitForSelector(card(OWNED.name), { timeout: WAIT_MS });
        t.assert.equal(await page.inputValue(create("password")), "");
        t.assert.equal(await page.inputValue(edit(OWNED.name, "password")), "");

        await page.fill(edit(OWNED.name, "password"), "another-secret");
        await page.click(`${card(OWNED.name)} .mail-save`);
        await waitForText(page, RESULT, `${OWNED.name} saved`);
        t.assert.equal(await page.inputValue(edit(OWNED.name, "password")), "");
    });

    it("shows the service's refusal next to the account it concerns", { timeout: TEST_TIMEOUT_MS }, async (t) => {
        const { daemon, port } = await startServer([GOOD]);
        const refusal = await refusalOf(daemon.invoke("mail.accounts.signin", { name: GOOD.name }));
        const page = await openMail(t, port);
        if (page === undefined) return;

        await page.click(`${card(GOOD.name)} .mail-signin`);

        await waitForText(page, `${card(GOOD.name)} .refusal`, refusal);
        t.assert.equal(await page.locator(`${card(GOOD.name)} .refusal`).getAttribute("role"), "alert");
    });
});

async function storedAccessToken(rig: MailRig, name: string): Promise<string | undefined> {
    try {
        const file = join(rig.env.stateDir, "secrets", "mail", `${name}.json`);
        return (JSON.parse(await readFile(file, "utf8")) as { accessToken?: string }).accessToken;
    } catch {
        return undefined;
    }
}
