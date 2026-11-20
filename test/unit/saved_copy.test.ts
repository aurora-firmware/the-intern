import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { composeMessage, parseMessage } from "../../src/mail/mime.ts";
import { hasSavedCopy, savedCopyPaths, writeSavedCopy } from "../../src/mail/saved_copy.ts";

let mailDir = "";

beforeEach(async () => {
    mailDir = await mkdtemp(join(tmpdir(), "bob-saved-copy-"));
});

afterEach(async () => {
    await rm(mailDir, { recursive: true, force: true });
});

const modeOf = async (path: string): Promise<number> => (await stat(path)).mode & 0o777;

const composeWith = async (attachments: { filename: string; content: Buffer }[]): Promise<Buffer> =>
    (
        await composeMessage({
            from: "bob@intern.example",
            to: ["ann@example.com"],
            subject: "Figures",
            text: "Hello Ann,\nthe figures are attached.\n",
            attachments: attachments.map((attachment) => ({ ...attachment, contentType: "application/octet-stream" })),
        })
    ).raw;

describe("writeSavedCopy", () => {
    it("writes_the_message_its_text_and_each_attachment_byte_for_byte", async () => {
        const pdf = randomBytes(4096);
        const note = Buffer.from("plain note\r\nwith lines\n", "utf8");
        const raw = await composeWith([
            { filename: "report.pdf", content: pdf },
            { filename: "note.txt", content: note },
        ]);
        await writeSavedCopy(mailDir, "m1", raw);
        const paths = savedCopyPaths(mailDir, "m1", ["report.pdf", "note.txt"]);
        assert.ok((await readFile(paths.message)).equals(raw));
        assert.equal(await readFile(paths.text, "utf8"), (await parseMessage(raw)).text);
        assert.ok((await readFile(paths.attachments[0] ?? "")).equals(pdf));
        assert.ok((await readFile(paths.attachments[1] ?? "")).equals(note));
    });

    it("writes_the_text_of_the_html_part_when_the_email_has_no_text_part", async () => {
        const raw = Buffer.from(
            "From: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\nContent-Type: text/html\r\n\r\n<p>Hello <b>Bob</b></p>\r\n",
        );
        await writeSavedCopy(mailDir, "m1", raw);
        const text = await readFile(savedCopyPaths(mailDir, "m1", []).text, "utf8");
        assert.match(text, /Hello\s+Bob/);
        assert.doesNotMatch(text, /</);
    });

    it("keeps_two_attachments_of_one_name_apart", async () => {
        const raw = await composeWith([
            { filename: "a.txt", content: Buffer.from("first") },
            { filename: "a.txt", content: Buffer.from("second") },
        ]);
        await writeSavedCopy(mailDir, "m1", raw);
        const paths = savedCopyPaths(mailDir, "m1", ["a.txt", "a.txt"]);
        assert.notEqual(paths.attachments[0], paths.attachments[1]);
        assert.equal(await readFile(paths.attachments[0] ?? "", "utf8"), "first");
        assert.equal(await readFile(paths.attachments[1] ?? "", "utf8"), "second");
    });

    it("removes_path_separators_and_control_characters_from_attachment_names", async () => {
        const raw = await composeWith([
            { filename: "../../evil\u0001name.txt", content: Buffer.from("x") },
            { filename: "dir\\sub/file\n.txt", content: Buffer.from("y") },
        ]);
        await writeSavedCopy(mailDir, "m1", raw);
        const written = await readdir(join(mailDir, "m1", "attachments"));
        assert.equal(written.length, 2);
        for (const name of written) {
            assert.doesNotMatch(name, /[/\\\u0000-\u001f]/);
        }
        const paths = savedCopyPaths(mailDir, "m1", ["../../evil\u0001name.txt", "dir\\sub/file\n.txt"]);
        assert.equal(await readFile(paths.attachments[0] ?? "", "utf8"), "x");
        assert.equal(await readFile(paths.attachments[1] ?? "", "utf8"), "y");
        assert.deepEqual(await readdir(mailDir), ["m1"]);
    });

    it("creates_folders_with_mode_0700_and_files_with_mode_0600", async () => {
        const raw = await composeWith([{ filename: "a.txt", content: Buffer.from("x") }]);
        await writeSavedCopy(mailDir, "m1", raw);
        const paths = savedCopyPaths(mailDir, "m1", ["a.txt"]);
        assert.equal(await modeOf(join(mailDir, "m1")), 0o700);
        assert.equal(await modeOf(join(mailDir, "m1", "attachments")), 0o700);
        assert.equal(await modeOf(paths.message), 0o600);
        assert.equal(await modeOf(paths.text), 0o600);
        assert.equal(await modeOf(paths.attachments[0] ?? ""), 0o600);
    });

    it("leaves_the_same_files_when_written_again_over_an_existing_copy", async () => {
        const raw = await composeWith([{ filename: "a.txt", content: Buffer.from("x") }]);
        await writeSavedCopy(mailDir, "m1", raw);
        const listing = async (): Promise<string[]> =>
            (await readdir(join(mailDir, "m1"), { recursive: true })).sort();
        const before = await listing();
        await writeSavedCopy(mailDir, "m1", raw);
        assert.deepEqual(await listing(), before);
        assert.deepEqual(await readdir(mailDir), ["m1"]);
        const paths = savedCopyPaths(mailDir, "m1", ["a.txt"]);
        assert.ok((await readFile(paths.message)).equals(raw));
        assert.equal(await readFile(paths.attachments[0] ?? "", "utf8"), "x");
    });

    it("replaces_a_stale_copy_with_the_new_files_only", async () => {
        const first = await composeWith([{ filename: "old.txt", content: Buffer.from("old") }]);
        const second = await composeWith([{ filename: "new.txt", content: Buffer.from("new") }]);
        await writeSavedCopy(mailDir, "m1", first);
        await writeSavedCopy(mailDir, "m1", second);
        assert.deepEqual(await readdir(join(mailDir, "m1", "attachments")), ["1-new.txt"]);
    });
});

describe("savedCopyPaths", () => {
    it("gives_the_paths_writeSavedCopy_writes_without_reading_the_disk", () => {
        const paths = savedCopyPaths(join(mailDir, "missing"), "m7", ["a.pdf", "a.pdf"]);
        assert.equal(paths.message, join(mailDir, "missing", "m7", "message.eml"));
        assert.equal(paths.text, join(mailDir, "missing", "m7", "message.txt"));
        assert.deepEqual(paths.attachments, [
            join(mailDir, "missing", "m7", "attachments", "1-a.pdf"),
            join(mailDir, "missing", "m7", "attachments", "2-a.pdf"),
        ]);
    });

    it("names_an_attachment_without_a_file_name_attachment", async () => {
        const raw = await composeWith([{ filename: "a.txt", content: Buffer.from("x") }]);
        await writeSavedCopy(mailDir, "m1", raw);
        const paths = savedCopyPaths(mailDir, "m1", [null]);
        assert.match(paths.attachments[0] ?? "", /1-attachment$/);
    });
});

describe("hasSavedCopy", () => {
    it("answers_whether_the_folder_exists", async () => {
        assert.equal(await hasSavedCopy(mailDir, "m1"), false);
        await writeSavedCopy(mailDir, "m1", await composeWith([]));
        assert.equal(await hasSavedCopy(mailDir, "m1"), true);
    });
});
