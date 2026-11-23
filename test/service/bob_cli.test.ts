import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { runBob } from "../support/bob_process.ts";
import { type DaemonProcess, startDaemon } from "../support/daemon_process.ts";
import { createHermeticEnv, type HermeticEnv } from "../support/hermetic_env.ts";

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

function installModulesAmong(urls: string[]): string[] {
    return urls.filter((url) => url.includes(`${SRC}/install/`));
}

/** The distinct modules under `src/daemon/` among the URLs, as file names, sorted (each importer resolves one again). */
function daemonFilesAmong(urls: string[]): string[] {
    const names = urls
        .filter((url) => url.includes(`${SRC}/daemon/`))
        .map((url) => url.slice(url.lastIndexOf("/") + 1));
    return [...new Set(names)].sort();
}

const INSTALL_COMMAND_LINES = [
    { args: ["service", "install"], usage: "Usage: bob service install" },
    { args: ["service", "remove"], usage: "Usage: bob service remove" },
    { args: ["service", "status"], usage: "Usage: bob service status" },
    { args: ["upgrade"], usage: "Usage: bob upgrade [version] [options]" },
    { args: ["rollback"], usage: "Usage: bob rollback" },
    { args: ["uninstall"], usage: "Usage: bob uninstall" },
];

describe("bob command line", () => {
    it("prints the top-level usage on standard output and exits 0 for --help, listing the schedules, skills and mail groups and no reserved group", async () => {
        const result = await runBob(["--help"]);

        assert.equal(result.status, 0);
        assert.ok(result.stdout.startsWith("Usage: bob <command>"), result.stdout);
        assert.ok(result.stdout.includes("serve"), result.stdout);
        assert.ok(result.stdout.includes("schedules"), result.stdout);
        assert.ok(result.stdout.includes("skills"), result.stdout);
        assert.ok(result.stdout.includes("mail"), result.stdout);
        assert.ok(!result.stdout.includes("knowledge"), result.stdout);
        assert.equal(result.stderr, "");
    });

    it("lists upgrade, rollback, uninstall and the service group in bob --help", async () => {
        const result = await runBob(["--help"]);

        assert.equal(result.status, 0);
        for (const name of ["upgrade", "rollback", "uninstall", "service <command>"]) {
            assert.ok(result.stdout.includes(name), `${name} missing from ${result.stdout}`);
        }
    });

    it("lists install, remove and status in bob service --help", async () => {
        const result = await runBob(["service", "--help"]);

        assert.equal(result.status, 0);
        assert.ok(result.stdout.startsWith("Usage: bob service <command>"), result.stdout);
        for (const verb of ["install", "remove", "status"]) {
            assert.ok(result.stdout.includes(`  ${verb} `), `${verb} missing from ${result.stdout}`);
        }
        assert.equal(result.stderr, "");
    });

    for (const { args, usage } of INSTALL_COMMAND_LINES) {
        it(`prints the options of bob ${args.join(" ")} --help and exits 0`, async () => {
            const result = await runBob([...args, "--help"]);

            assert.equal(result.status, 0);
            assert.ok(result.stdout.startsWith(usage), result.stdout);
            assert.ok(result.stdout.includes("--help"), result.stdout);
            assert.equal(result.stderr, "");
        });

        it(`prints the usage of bob ${args.join(" ")} on standard error and exits 2 for an unknown option`, async () => {
            const result = await runBob([...args, "--no-such-option"]);

            assert.equal(result.status, 2);
            assert.equal(result.stdout, "");
            assert.ok(result.stderr.includes("--no-such-option"), result.stderr);
            assert.ok(result.stderr.includes("Usage: bob"), result.stderr);
        });
    }

    it("prints the top-level usage on standard error and exits 2 for an unknown command", async () => {
        const result = await runBob(["jbos", "list"]);

        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.includes("Usage: bob <command>"), result.stderr);
    });

    it("says on standard error that knowledge isn't available yet and exits 2 for a reserved group", async () => {
        const result = await runBob(["knowledge", "list"]);

        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.includes("knowledge"), result.stderr);
        assert.ok(result.stderr.includes("isn't available yet"), result.stderr);
    });

    it("fails triggers as an unknown group, printing the usage on standard error and exiting 2", async () => {
        const result = await runBob(["triggers", "list"]);

        assert.equal(result.status, 2);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.includes("Usage: bob <command>"), result.stderr);
        assert.ok(!result.stderr.includes("isn't available yet"), result.stderr);
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

    it("loads nothing from src/install when the command table is loaded and help is printed", () => {
        const urls = resolvedModules(
            join(SRC, "cli", "bob.ts"),
            'await module.main(["--help"], { stdout: { write() {} }, stderr: { write() {} } });',
        );

        assert.deepEqual(installModulesAmong(urls), []);
    });

    it("loads only ownership, startup_report and state_layout from the daemon when service status --json runs on an empty home", async () => {
        const home = await createHermeticEnv();
        try {
            const io = JSON.stringify({ env: home.env, homeDir: home.root, cwd: home.root });
            const urls = resolvedModules(
                join(SRC, "cli", "bob.ts"),
                `await module.main(["service", "status", "--json"], { ...${io}, stdout: { write() { return true; } }, stderr: { write() { return true; } }, stdin: process.stdin, isStdoutTerminal: false, isStdinTerminal: false });`,
            );

            assert.ok(
                urls.some((url) => url.endsWith("/install/service_commands.ts")),
                "the status command did not run",
            );
            assert.deepEqual(daemonFilesAmong(urls), ["ownership.ts", "startup_report.ts", "state_layout.ts"]);
            assert.deepEqual(daemonModulesAmong(urls), []);
        } finally {
            await home.dispose();
        }
    });

    it("loads the daemon modules when serve's body is imported", () => {
        const urls = resolvedModules(join(SRC, "cli", "serve.ts"), "");

        assert.notDeepEqual(daemonModulesAmong(urls), []);
    });
});

type Fixture = { env: HermeticEnv; daemon: DaemonProcess };
type ScheduleAnswer = { schedule: { name: string; cron: string; request: string; role?: string } };
type RunItem = { kind: "run" | "skip"; job?: { number: string; request: { origin: Record<string, unknown> } } };

const envs: HermeticEnv[] = [];
const daemons: DaemonProcess[] = [];

afterEach(async () => {
    for (const daemon of daemons.splice(0)) {
        daemon.kill9();
        await daemon.exited;
    }
    for (const env of envs.splice(0)) await env.dispose();
});

async function readyDaemon(): Promise<Fixture> {
    const env = await createHermeticEnv();
    envs.push(env);
    const daemon = startDaemon({ hermetic: env, script: "echo", turnEndRule: false });
    daemons.push(daemon);
    await daemon.ready;
    return { env, daemon };
}

const bob = (fixture: Fixture, args: string[]) =>
    runBob(args, { runtimeDir: fixture.env.runtimeDir, env: fixture.env.env });

// Finds the scheduled runs by kind, since the history's order across UTC offsets is B-034's.
async function runItems(fixture: Fixture, name: string): Promise<RunItem[]> {
    const page = (await fixture.daemon.invoke("schedules.runs", { name })) as { items: RunItem[] };
    return page.items.filter((item) => item.kind === "run");
}

describe("bob schedules", () => {
    it("lists the six verbs for --help", async () => {
        const result = await runBob(["schedules", "--help"]);

        assert.equal(result.status, 0, result.stderr);
        for (const verb of ["list", "show", "create", "change", "remove", "run"]) {
            assert.ok(result.stdout.includes(verb), result.stdout);
        }
    });

    it("creates, lists, shows, changes, runs and removes an entry, with the text and with --json", async () => {
        const fixture = await readyDaemon();
        const create = ["schedules", "create", "nightly", "--cron", "0 3 * * *", "--request", "Tidy up."];

        const created = await bob(fixture, create);
        const listed = await bob(fixture, ["schedules", "list"]);
        const changed = await bob(fixture, ["schedules", "change", "nightly", "--request", "Tidy up well."]);
        const shown = await bob(fixture, ["schedules", "show", "nightly"]);
        const ran = await bob(fixture, ["schedules", "run", "nightly"]);
        const removed = await bob(fixture, ["schedules", "remove", "nightly"]);
        const listedAfter = await bob(fixture, ["schedules", "list"]);

        for (const result of [created, listed, changed, shown, ran, removed, listedAfter]) {
            assert.equal(result.status, 0, result.stderr);
        }
        assert.ok(listed.stdout.includes("nightly"), listed.stdout);
        assert.ok(listed.stdout.includes("0 3 * * *"), listed.stdout);
        assert.ok(shown.stdout.includes("Tidy up well."), shown.stdout);
        assert.ok(shown.stdout.includes("Runs:"), shown.stdout);
        assert.ok(!listedAfter.stdout.includes("nightly"), listedAfter.stdout);
    });

    it("prints the service's answer unchanged with --json, and show prints one object keyed by operation", async () => {
        const fixture = await readyDaemon();

        const created = await bob(fixture, [
            "schedules",
            "create",
            "nightly",
            "--cron",
            "0 3 * * *",
            "--request",
            "Tidy up.",
            "--json",
        ]);
        const listed = await bob(fixture, ["schedules", "list", "--json"]);
        const changed = await bob(fixture, ["schedules", "change", "nightly", "--cron", "0 4 * * *", "--json"]);
        const shown = await bob(fixture, ["schedules", "show", "nightly", "--json"]);
        const removed = await bob(fixture, ["schedules", "remove", "nightly", "--json"]);

        for (const result of [created, listed, changed, shown, removed]) assert.equal(result.status, 0, result.stderr);
        const createdAnswer = JSON.parse(created.stdout) as ScheduleAnswer;
        assert.equal(createdAnswer.schedule.name, "nightly");
        assert.equal(createdAnswer.schedule.cron, "0 3 * * *");
        assert.equal((JSON.parse(listed.stdout) as { schedules: unknown[] }).schedules.length, 1);
        assert.equal((JSON.parse(changed.stdout) as ScheduleAnswer).schedule.cron, "0 4 * * *");
        const shownAnswer = JSON.parse(shown.stdout) as Record<string, unknown>;
        assert.deepEqual(Object.keys(shownAnswer).sort(), ["schedules.get", "schedules.runs"]);
        assert.deepEqual(JSON.parse(removed.stdout), {});
    });

    it("creates one job whose origin records the entry, on demand and way in command line, for run", async () => {
        const fixture = await readyDaemon();
        await bob(fixture, ["schedules", "create", "nightly", "--cron", "0 3 * * *", "--request", "Tidy up."]);

        const ran = await bob(fixture, ["schedules", "run", "nightly", "--json"]);

        assert.equal(ran.status, 0, ran.stderr);
        const items = await runItems(fixture, "nightly");
        assert.equal(items.length, 1);
        const job = items[0]?.job;
        assert.equal(job?.number, (JSON.parse(ran.stdout) as { number: string }).number);
        assert.match(job?.number ?? "", /^S-\d+$/);
        const origin = job?.request.origin as { kind: string; entry: string; onDemand: { wayIn: string } };
        assert.equal(origin.kind, "schedule");
        assert.equal(origin.entry, "nightly");
        assert.equal(origin.onDemand.wayIn, "command line");
    });

    it("prints the service's reason on standard error and exits 1 when the service refuses", async () => {
        const fixture = await readyDaemon();

        const result = await bob(fixture, ["schedules", "remove", "nothing-here"]);

        assert.equal(result.status, 1);
        assert.equal(result.stdout, "");
        assert.ok(result.stderr.includes("nothing-here"), result.stderr);
    });

    it("loads no daemon module other than the state layout when a schedules command runs", async () => {
        const fixture = await readyDaemon();

        const result = spawnSync(
            process.execPath,
            [
                "--import",
                join(SRC, "..", "test", "support", "module_trace.ts"),
                join(SRC, "cli", "bob.ts"),
                "schedules",
                "list",
            ],
            { encoding: "utf8", env: { ...fixture.env.env, BOB_RUNTIME_DIR: fixture.env.runtimeDir } },
        );

        assert.equal(result.status, 0, result.stderr);
        const urls = result.stderr
            .split("\n")
            .filter((line) => line.startsWith("module-trace "))
            .map((line) => line.slice("module-trace ".length));
        assert.ok(
            urls.some((url) => url.endsWith("/cli/schedules_commands.ts")),
            "the group was not loaded",
        );
        assert.deepEqual(
            daemonModulesAmong(urls).filter((url) => !url.endsWith("/daemon/state_layout.ts")),
            [],
        );
    });
});
