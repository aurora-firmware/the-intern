import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { transformSync } from "amaro";
import { WEB_UI_DIR } from "../../src/listeners/static_files.ts";

const CLIENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src", "client");
const CLIENT_MODULES = [join(CLIENT_DIR, "client.ts"), join(CLIENT_DIR, "browser_transport.ts")];

async function tsFilesUnder(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const nested = await Promise.all(
        entries.map((entry) => {
            const path = join(dir, entry.name);
            if (entry.isDirectory()) return tsFilesUnder(path);
            return Promise.resolve(entry.name.endsWith(".ts") ? [path] : []);
        }),
    );
    return nested.flat();
}

describe("the .ts files the web interface ships", () => {
    it("strips every file without error and keeps every line in its place", async () => {
        const files = [...(await tsFilesUnder(WEB_UI_DIR)), ...CLIENT_MODULES];
        assert.ok(files.length >= 3, "the web interface ships .ts files");

        for (const file of files) {
            const code = await readFile(file, "utf8");
            const { code: stripped } = transformSync(code, { mode: "strip-only" });
            assert.equal(stripped.split("\n").length, code.split("\n").length, file);
        }
    });

    it("imports no Node module from /ui/client/client.ts", async () => {
        const code = await readFile(join(CLIENT_DIR, "client.ts"), "utf8");
        const specifiers = [...code.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["']([^"']+)["']/g)].map(
            (m) => m[1] ?? "",
        );
        const nodeModules = new Set(builtinModules.map((name) => name.replace(/^node:/, "")));

        const imported = specifiers.filter(
            (name) => name.startsWith("node:") || nodeModules.has(name.split("/")[0] ?? ""),
        );

        assert.deepEqual(imported, []);
    });
});
