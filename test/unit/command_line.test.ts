import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    type CommandSpec,
    EXIT_CODES,
    type ParsedCommandLine,
    parseCommandLine,
    RESERVED_GROUPS,
} from "../../src/cli/command_line.ts";

const run = async () => 0;

const COMMANDS: CommandSpec[] = [
    {
        group: "jobs",
        verb: "list",
        summary: "List jobs.",
        positionals: [],
        options: { state: { type: "string", multiple: true, description: "Only jobs in this state." } },
        isData: true,
        callsService: true,
        run,
    },
    {
        group: "jobs",
        verb: "show",
        summary: "Show one job.",
        positionals: [{ name: "job", required: true }],
        options: {},
        isData: true,
        callsService: true,
        run,
    },
    {
        group: "schedules",
        verb: "list",
        summary: "List schedules.",
        positionals: [],
        options: {},
        isData: true,
        callsService: true,
        run,
    },
    {
        verb: "status",
        summary: "Show the status.",
        positionals: [],
        options: {},
        isData: true,
        callsService: true,
        run,
    },
    {
        verb: "serve",
        summary: "Run the daemon.",
        positionals: [],
        options: { verbose: { type: "boolean", description: "Log more." } },
        isData: false,
        callsService: false,
        run,
    },
    {
        verb: "import",
        summary: "Import data.",
        positionals: [{ name: "path", required: true }],
        options: {},
        isData: false,
        callsService: false,
        run,
    },
];

const parse = (...argv: string[]): ParsedCommandLine => parseCommandLine(argv, COMMANDS);

function usageOf(result: ParsedCommandLine): string {
    assert.ok(result.kind === "help" || result.kind === "usage-error", `unexpected result ${result.kind}`);
    return result.usage;
}

describe("exit codes", () => {
    it("names the four exit statuses of the command line", () => {
        assert.deepEqual(EXIT_CODES, { ok: 0, refused: 1, usage: 2, unreachable: 3 });
    });
});

describe("help", () => {
    it("returns the top-level usage for --help without listing a reserved group", () => {
        const usage = usageOf(parse("--help"));
        assert.equal(parse("--help").kind, "help");
        assert.match(usage, /status/);
        assert.match(usage, /jobs/);
        for (const group of RESERVED_GROUPS) {
            assert.doesNotMatch(usage, new RegExp(group));
        }
    });

    it("returns the usage of a group for --help after the group", () => {
        const result = parse("jobs", "--help");
        assert.equal(result.kind, "help");
        assert.match(usageOf(result), /bob jobs <command>/);
        assert.match(usageOf(result), /show/);
    });

    it("returns the usage of a command for --help after group and verb", () => {
        const result = parse("jobs", "list", "--help");
        assert.equal(result.kind, "help");
        assert.match(usageOf(result), /bob jobs list/);
        assert.match(usageOf(result), /--state/);
    });

    it("returns the usage of a top-level command for --help after it", () => {
        const result = parse("status", "--help");
        assert.equal(result.kind, "help");
        assert.match(usageOf(result), /bob status/);
    });
});

describe("usage errors", () => {
    it("returns the top-level usage when the group is unknown", () => {
        const result = parse("jbos", "list");
        assert.equal(result.kind, "usage-error");
        assert.match(usageOf(result), /Usage: bob <command>/);
    });

    it("returns the group usage when the verb is unknown", () => {
        const result = parse("jobs", "lisst");
        assert.equal(result.kind, "usage-error");
        assert.match(usageOf(result), /Usage: bob jobs <command>/);
    });

    it("returns the group usage when an option is unknown", () => {
        const result = parse("jobs", "list", "--bogus");
        assert.equal(result.kind, "usage-error");
        assert.match(usageOf(result), /Usage: bob jobs <command>/);
    });

    it("returns a usage error when a required argument is missing", () => {
        const result = parse("jobs", "show");
        assert.equal(result.kind, "usage-error");
        assert.match(usageOf(result), /Usage: bob jobs <command>/);
        assert.match(result.kind === "usage-error" ? result.message : "", /job/);
    });

    it("returns the usage of a top-level command when it gets an unknown option", () => {
        const result = parse("status", "--bogus");
        assert.equal(result.kind, "usage-error");
        assert.match(usageOf(result), /Usage: bob status \[options\]/);
    });

    it("returns the usage of a top-level command when it gets a surplus argument", () => {
        const result = parse("status", "extra");
        assert.equal(result.kind, "usage-error");
        assert.match(usageOf(result), /Usage: bob status \[options\]/);
    });

    it("returns a usage error when no command is given", () => {
        assert.equal(parse().kind, "usage-error");
    });

    it("returns a usage error for a surplus argument", () => {
        assert.equal(parse("jobs", "show", "J1", "J2").kind, "usage-error");
    });
});

describe("reserved groups", () => {
    for (const argv of [["schedules", "list"], ["schedules"], ["mail", "--help"], ["knowledge", "x", "--bogus"]]) {
        it(`returns a reserved-group result naming the group for ${argv.join(" ")}`, () => {
            const result = parse(...argv);
            assert.equal(result.kind, "reserved-group");
            assert.equal(result.kind === "reserved-group" ? result.group : "", argv[0]);
        });
    }
});

describe("parsed commands", () => {
    it("returns the command with its positionals and options", () => {
        const result = parse("jobs", "list", "--state", "open", "--state", "done");
        assert.ok(result.kind === "command");
        assert.equal(result.command.verb, "list");
        assert.deepEqual(result.input.options, { state: ["open", "done"] });
        assert.equal(result.input.json, false);
    });

    it("accepts --json on a data command", () => {
        const result = parse("jobs", "show", "J1", "--json");
        assert.ok(result.kind === "command");
        assert.deepEqual(result.input.positionals, ["J1"]);
        assert.equal(result.input.json, true);
    });

    it("returns a usage error when --json is given to serve", () => {
        assert.equal(parse("serve", "--json").kind, "usage-error");
    });

    it("returns a usage error when --json is given to import", () => {
        assert.equal(parse("import", "dump", "--json").kind, "usage-error");
    });

    it("returns the runtime directory for a command that calls the service", () => {
        const result = parse("status", "--runtime-dir", "/run/bob");
        assert.ok(result.kind === "command");
        assert.equal(result.input.runtimeDir, "/run/bob");
    });

    it("returns a usage error when --runtime-dir is given to a command that does not call the service", () => {
        assert.equal(parse("import", "dump", "--runtime-dir", "/x").kind, "usage-error");
    });

    it("keeps the options of serve out of the shared fields", () => {
        const result = parse("serve", "--verbose");
        assert.ok(result.kind === "command");
        assert.deepEqual(result.input.options, { verbose: true });
    });
});
