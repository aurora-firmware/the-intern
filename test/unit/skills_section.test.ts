import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { ConfigValueError } from "../../src/config/config_file.ts";
import { checkSearchPath, SearchPathError, skillsSection } from "../../src/skills/skills_section.ts";

const failure = (run: () => unknown): ConfigValueError => {
    try {
        run();
    } catch (error) {
        assert.ok(error instanceof ConfigValueError, `expected ConfigValueError, got ${String(error)}`);
        return error;
    }
    throw new Error("expected ConfigValueError");
};

const checkFailure = async (run: () => Promise<void>): Promise<ConfigValueError> => {
    try {
        await run();
    } catch (error) {
        assert.ok(error instanceof ConfigValueError, `expected ConfigValueError, got ${String(error)}`);
        return error;
    }
    throw new Error("expected ConfigValueError");
};

let root: string;

beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "skills-section-"));
    await chmod(root, 0o700);
});

afterEach(async () => {
    await rm(root, { recursive: true, force: true });
});

describe("skillsSection parse", () => {
    it("defaults to no paths", () => {
        assert.deepEqual(skillsSection.defaults(), { paths: [] });
        assert.equal(skillsSection.name, "skills");
    });

    it("reads the absolute paths in order", () => {
        assert.deepEqual(skillsSection.parse({ paths: ["/b", "/a"] }), { paths: ["/b", "/a"] });
    });

    it("reads an empty table as no paths", () => {
        assert.deepEqual(skillsSection.parse({}), { paths: [] });
    });

    it("rejects a relative path, naming it", () => {
        const error = failure(() => skillsSection.parse({ paths: ["/a", "rel/x"] }));
        assert.equal(error.key, "paths");
        assert.match(error.reason, /rel\/x/);
    });

    it("rejects a path listed twice, naming it", () => {
        const error = failure(() => skillsSection.parse({ paths: ["/a", "/a"] }));
        assert.equal(error.key, "paths");
        assert.match(error.reason, /\/a/);
    });

    it("rejects another key, naming it", () => {
        assert.equal(failure(() => skillsSection.parse({ paths: [], extra: 1 })).key, "extra");
    });

    it("rejects paths that is not a list of strings", () => {
        assert.equal(failure(() => skillsSection.parse({ paths: "/a" })).key, "paths");
        assert.equal(failure(() => skillsSection.parse({ paths: [1] })).key, "paths");
    });

    it("rejects a value that is not a table", () => {
        assert.equal(failure(() => skillsSection.parse([])).key, "skills");
    });

    it("serializes the paths in order and parses back to the same value", () => {
        const value = skillsSection.parse({ paths: ["/b", "/a"] });
        assert.deepEqual(skillsSection.serialize(value), { paths: ["/b", "/a"] });
        assert.deepEqual(skillsSection.parse(skillsSection.serialize(value)), value);
    });
});

describe("checkSearchPath", () => {
    it("resolves for an owner-only folder", async () => {
        await checkSearchPath(root);
    });

    it("says the folder must be accessible only to the service account when others can reach it", async () => {
        await chmod(root, 0o750);
        const error = await checkSearchPath(root).then(
            () => undefined,
            (caught: unknown) => caught,
        );
        assert.ok(error instanceof SearchPathError);
        assert.equal(error.path, root);
        assert.match(error.reason, /accessible only to the service account/);
    });

    it("throws a SearchPathError for a missing path", async () => {
        await assert.rejects(checkSearchPath(join(root, "none")), SearchPathError);
    });
});

describe("skillsSection check", () => {
    it("passes for owner-only folders", async () => {
        await skillsSection.check?.({ paths: [root] });
    });

    it("passes for no paths", async () => {
        await skillsSection.check?.({ paths: [] });
    });

    it("throws a ConfigValueError with key paths naming a missing path and the reason", async () => {
        const missing = join(root, "none");
        const error = await checkFailure(() => skillsSection.check?.({ paths: [root, missing] }) ?? Promise.resolve());
        assert.equal(error.key, "paths");
        assert.match(error.reason, new RegExp(missing));
        assert.match(error.reason, /does not exist/);
    });

    it("throws for a path that is not a folder", async () => {
        const file = join(root, "file");
        await writeFile(file, "x");
        const error = await checkFailure(() => skillsSection.check?.({ paths: [file] }) ?? Promise.resolve());
        assert.match(error.reason, /not a directory/);
    });

    it("says the folder must be accessible only to the service account when others can reach it", async () => {
        await chmod(root, 0o755);
        const error = await checkFailure(() => skillsSection.check?.({ paths: [root] }) ?? Promise.resolve());
        assert.equal(error.key, "paths");
        assert.match(error.reason, new RegExp(root));
        assert.match(error.reason, /accessible only to the service account/);
    });
});
