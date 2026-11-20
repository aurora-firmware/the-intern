import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import {
    type ImapConnection,
    ImapFailure,
    type MessageRef,
    openImap,
    pickSpecialFolder,
} from "../../src/mail/imap_client.ts";
import { type FakeMailServer, startFakeMailServer } from "../support/fake_mail_server.ts";

const ADDRESS = "ada@example.test";
const ACCOUNT = { address: ADDRESS, login: "ada", password: "ada-password-s3cret" };
const DAY_MS = 86_400_000;

function message(from: string, subject: string, body = "Body text."): string {
    return `From: ${from}\r\nTo: Ada <${ADDRESS}>\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replaceAll(" ", "-")}@example.test>\r\n\r\n${body}\r\n`;
}

describe("imap folders, search, move, flags and append", () => {
    const cleanups: (() => Promise<void> | void)[] = [];

    afterEach(async () => {
        for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    });

    async function connect(
        options: { move?: boolean } = {},
    ): Promise<{ server: FakeMailServer; mail: ImapConnection }> {
        const server = await startFakeMailServer(options);
        server.addAccount(ACCOUNT);
        cleanups.push(() => server.stop());
        const mail = await openImap({
            host: "127.0.0.1",
            port: server.imapPort,
            security: "none",
            credential: { user: ACCOUNT.login, password: ACCOUNT.password },
            idleSeconds: 60,
        });
        cleanups.push(() => mail.logout());
        return { server, mail };
    }

    async function refusal(attempt: Promise<unknown>): Promise<ImapFailure> {
        try {
            await attempt;
        } catch (error) {
            assert.ok(error instanceof ImapFailure, `not an ImapFailure: ${String(error)}`);
            return error;
        }
        throw new Error("expected the call to be refused");
    }

    async function inboxRefs(mail: ImapConnection): Promise<MessageRef[]> {
        return mail.search("INBOX", {}, 50);
    }

    describe("special folders", () => {
        it("finds Drafts, Sent and Trash by their SPECIAL-USE attribute", async () => {
            const { mail } = await connect();

            assert.deepEqual(
                [
                    await mail.specialFolder("drafts"),
                    await mail.specialFolder("sent"),
                    await mail.specialFolder("trash"),
                ],
                ["Drafts", "Sent", "Trash"],
            );
            const paths = (await mail.listFolders()).map((folder) => folder.path);
            assert.ok(paths.includes("INBOX") && paths.includes("Trash"), paths.join(","));
        });

        it("falls back to the usual names when no folder carries the attribute", () => {
            const folders = [
                { path: "INBOX" },
                { path: "Entwürfe" },
                { path: "Sent Items" },
                { path: "Deleted Items" },
            ];

            assert.equal(pickSpecialFolder(folders, "drafts"), undefined);
            assert.equal(pickSpecialFolder(folders, "sent"), "Sent Items");
            assert.equal(pickSpecialFolder(folders, "trash"), "Deleted Items");
        });

        it("prefers the attribute over a folder with a usual name", () => {
            const folders = [{ path: "Trash" }, { path: "Bin", specialUse: "\\Trash" }];

            assert.equal(pickSpecialFolder(folders, "trash"), "Bin");
        });
    });

    describe("search", () => {
        it("returns the messages matching sender, subject, text, dates and flags, newest first", async () => {
            const { server, mail } = await connect();
            server.deliver(ADDRESS, message("Grace <grace@example.test>", "Old report", "quarterly numbers"));
            server.deliver(ADDRESS, message("Grace <grace@example.test>", "New report", "quarterly numbers"));
            server.deliver(ADDRESS, message("Linus <linus@example.test>", "Kernel report", "quarterly numbers"));
            server.deliver(ADDRESS, message("Grace <grace@example.test>", "Lunch", "sandwiches"));
            await mail.setFlags(await inboxRefs(mail), { seen: true });
            await mail.setFlags(await mail.search("INBOX", { subject: "New report" }, 1), { seen: false });

            const found = await mail.search(
                "INBOX",
                {
                    from: "grace@example.test",
                    subject: "report",
                    text: "quarterly",
                    since: new Date(Date.now() - DAY_MS),
                    before: new Date(Date.now() + DAY_MS),
                    seen: true,
                },
                10,
            );

            const subjects = await Promise.all(found.map(async (ref) => subjectOf(await mail.fetchMessage(ref))));
            assert.deepEqual(subjects, ["Subject: Old report"]);
        });

        it("orders newest first and stops at the limit", async () => {
            const { server, mail } = await connect();
            for (const subject of ["One", "Two", "Three"]) server.deliver(ADDRESS, message("g@example.test", subject));

            const found = await mail.search("INBOX", { from: "g@example.test" }, 2);

            const subjects = await Promise.all(found.map(async (ref) => subjectOf(await mail.fetchMessage(ref))));
            assert.deepEqual(subjects, ["Subject: Three", "Subject: Two"]);
        });

        it("matches nothing outside the date range", async () => {
            const { server, mail } = await connect();
            server.deliver(ADDRESS, message("g@example.test", "Today"));

            const found = await mail.search("INBOX", { before: new Date(Date.now() - DAY_MS) }, 10);

            assert.deepEqual(found, []);
        });

        it("opens the folder read-only, so a search leaves unseen messages unseen", async () => {
            const { server, mail } = await connect();
            server.deliver(ADDRESS, message("g@example.test", "Unread"));

            const [ref] = await inboxRefs(mail);
            assert.ok(ref !== undefined);
            await mail.fetchMessage(ref);

            assert.deepEqual(server.mailbox(ADDRESS, "INBOX")[0]?.flags, []);
        });

        it("names each message by folder, UIDVALIDITY and UID", async () => {
            const { server, mail } = await connect();
            server.deliver(ADDRESS, message("g@example.test", "Named"));
            const state = await mail.inboxState();

            const [ref] = await inboxRefs(mail);

            assert.deepEqual(ref, { folder: "INBOX", uidValidity: state.uidValidity, uid: state.uidNext - 1 });
        });
    });

    describe("fetchMessage", () => {
        it("returns the raw bytes of the message", async () => {
            const { server, mail } = await connect();
            const raw = message("g@example.test", "Raw");
            server.deliver(ADDRESS, raw);
            const [ref] = await inboxRefs(mail);
            assert.ok(ref !== undefined);

            assert.equal(Buffer.from(await mail.fetchMessage(ref)).toString("utf8"), raw);
        });

        it("refuses a ref whose UIDVALIDITY no longer matches", async () => {
            const { server, mail } = await connect();
            server.deliver(ADDRESS, message("g@example.test", "Stale"));
            const [ref] = await inboxRefs(mail);
            assert.ok(ref !== undefined);
            const stale = { ...ref, uidValidity: ref.uidValidity + 1 };

            const failure = await refusal(mail.fetchMessage(stale));

            assert.match(failure.message, /UIDVALIDITY/);
        });
    });

    describe("move", () => {
        it("moves messages to Trash and leaves them there, not expunged", async () => {
            const { server, mail } = await connect();
            server.deliver(ADDRESS, message("g@example.test", "Bin me"));
            const refs = await inboxRefs(mail);

            await mail.move(refs, (await mail.specialFolder("trash")) ?? "Trash");

            assert.equal(server.mailbox(ADDRESS, "INBOX").length, 0);
            const trash = server.mailbox(ADDRESS, "Trash");
            assert.equal(trash.length, 1);
            assert.ok(!trash[0]?.flags.includes("\\Deleted"));
        });

        it("refuses a folder that does not exist and leaves the messages in place", async () => {
            const { server, mail } = await connect();
            server.deliver(ADDRESS, message("g@example.test", "Stay"));
            const refs = await inboxRefs(mail);

            const failure = await refusal(mail.move(refs, "Nowhere"));

            assert.match(failure.message, /Nowhere/);
            assert.equal(server.mailbox(ADDRESS, "INBOX").length, 1);
        });

        it("refuses on a server without MOVE and leaves the messages in place", async () => {
            const { server, mail } = await connect({ move: false });
            server.deliver(ADDRESS, message("g@example.test", "Stay"));
            const refs = await inboxRefs(mail);

            const failure = await refusal(mail.move(refs, "Trash"));

            assert.match(failure.message, /MOVE/);
            assert.equal(server.mailbox(ADDRESS, "INBOX").length, 1);
            assert.equal(server.mailbox(ADDRESS, "Trash").length, 0);
        });

        it("refuses a ref whose UIDVALIDITY no longer matches and moves nothing", async () => {
            const { server, mail } = await connect();
            server.deliver(ADDRESS, message("g@example.test", "Stale"));
            const refs = await inboxRefs(mail);
            const stale = refs.map((ref) => ({ ...ref, uidValidity: ref.uidValidity + 1 }));

            const failure = await refusal(mail.move(stale, "Trash"));

            assert.match(failure.message, /UIDVALIDITY/);
            assert.equal(server.mailbox(ADDRESS, "INBOX").length, 1);
        });
    });

    describe("setFlags", () => {
        it("sets and clears Seen, Flagged and Answered and touches no other flag", async () => {
            const { server, mail } = await connect();
            server.deliver(ADDRESS, message("g@example.test", "Flags"));
            const refs = await inboxRefs(mail);

            await mail.setFlags(refs, { seen: true, flagged: true, answered: true });
            assert.deepEqual(server.mailbox(ADDRESS, "INBOX")[0]?.flags.toSorted(), [
                "\\Answered",
                "\\Flagged",
                "\\Seen",
            ]);

            await mail.setFlags(refs, { flagged: false });
            assert.deepEqual(server.mailbox(ADDRESS, "INBOX")[0]?.flags.toSorted(), ["\\Answered", "\\Seen"]);
        });

        it("refuses a ref whose UIDVALIDITY no longer matches", async () => {
            const { server, mail } = await connect();
            server.deliver(ADDRESS, message("g@example.test", "Stale"));
            const refs = await inboxRefs(mail);
            const stale = refs.map((ref) => ({ ...ref, uidValidity: ref.uidValidity + 1 }));

            const failure = await refusal(mail.setFlags(stale, { seen: true }));

            assert.match(failure.message, /UIDVALIDITY/);
            assert.deepEqual(server.mailbox(ADDRESS, "INBOX")[0]?.flags, []);
        });
    });

    describe("append and hasMessageId", () => {
        it("appends a message with its flags and finds it by Message-ID", async () => {
            const { server, mail } = await connect();
            const raw = message("ada@example.test", "Draft one");

            await mail.append("Drafts", Buffer.from(raw), ["\\Draft", "\\Seen"]);

            const [stored] = server.mailbox(ADDRESS, "Drafts");
            assert.equal(stored?.raw.toString("utf8"), raw);
            assert.deepEqual(stored?.flags.toSorted(), ["\\Draft", "\\Seen"]);
            assert.equal(await mail.hasMessageId("Drafts", "<Draft-one@example.test>"), true);
            assert.equal(await mail.hasMessageId("Drafts", "<other@example.test>"), false);
            assert.equal(await mail.hasMessageId("Sent", "<Draft-one@example.test>"), false);
        });
    });
});

function subjectOf(raw: Uint8Array): string {
    return (
        Buffer.from(raw)
            .toString("utf8")
            .split("\r\n")
            .find((line) => line.startsWith("Subject:")) ?? ""
    );
}
