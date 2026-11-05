import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";

const SRC = join(import.meta.dirname, "..", "..", "src");
const DAEMON_CODE = ["daemon/daemon.ts", "host/", "service/", "listeners/", "jobs/", "agents/"];

/** Imports a module and runs the callback under a resolve hook; returns every module URL that was resolved. */
function resolvedModules(importPath: string, callback: string): string[] {
    const script = `
        import { registerHooks } from "node:module";
        const urls = [];
        registerHooks({ resolve(specifier, context, next) { const result = next(specifier, context); urls.push(result.url); return result; } });
        const module = await import(${JSON.stringify(importPath)});
        ${callback}
        process.stdout.write(JSON.stringify(urls));
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout) as string[];
}

function daemonModulesAmong(urls: string[]): string[] {
    return urls.filter((url) => DAEMON_CODE.some((part) => url.includes(`${SRC}/${part}`)));
}

describe("bob command line", () => {
    it("prints the top-level usage on standard output and exits 0 for --help, listing no reserved group", async () => {
        const result = await runBob(["--help"]);

        assert.equal(result.status, 0);
        assert.ok(result.stdout.startsWith("Usage: bob <command>"), result.stdout);
        assert.ok(result.stdout.includes("serve"), result.stdout);
        assert.ok(!/schedules|triggers|skills|instructions|knowledge|mail/.test(result.stdout), result.stdout);
        assert.equal(result.stderr, "");
    });

    it("prints the top-level usage on standard error and exits 2 for an unknown command", async () => {
        const result = await runBob(["jbos", "list"]);

        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.includes("Usage: bob <command>"), result.stderr);
    });

    it("says on standard error that schedules aren't available yet and exits 2 for a reserved group", async () => {
        const result = await runBob(["schedules", "list"]);

        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.includes("schedules"), result.stderr);
        assert.ok(result.stderr.includes("isn't available yet"), result.stderr);
    });

    it("loads no daemon module when the command table is loaded and help is printed", () => {
        const urls = resolvedModules(
            join(SRC, "cli", "bob.ts"),
            'await module.main(["--help"], { stdout: { write() {} }, stderr: { write() {} } });',
        );

        assert.ok(
            urls.some((url) => url.endsWith("/cli/commands.ts")),
            "the command table was not loaded",
        );
        assert.deepEqual(daemonModulesAmong(urls), []);
    });

    it("loads the daemon modules when serve's body is imported", () => {
        const urls = resolvedModules(join(SRC, "cli", "serve.ts"), "");

        assert.notDeepEqual(daemonModulesAmong(urls), []);
    });
});
