import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { FoundSkill, SourceScan } from "../../src/skills/skill_discovery.ts";
import {
    enabledSkillsOf,
    resolveCatalog,
    type ScannedSource,
    type SkillSource,
} from "../../src/skills/skill_resolution.ts";

const internal: SkillSource = { kind: "internal" };
const pathSource = (path: string): SkillSource => ({ kind: "path", path });
const workspace: SkillSource = { kind: "workspace", path: "/ws" };

const found = (name: string, folder: string): FoundSkill => ({
    name,
    description: `Does ${name}`,
    folder,
    file: `${folder}/SKILL.md`,
});

const scanned = (source: SkillSource, ...skills: FoundSkill[]): ScannedSource => {
    const scan: SourceScan = { skills, leftOut: [], diagnostics: [], missing: false };
    return { source, scan };
};

describe("resolveCatalog", () => {
    it("uses the higher source's copy and lists the other as shadowed with its source", () => {
        const low = found("lint", "/data/skills/lint");
        const high = found("lint", "/extra/lint");

        const catalog = resolveCatalog([scanned(internal, low), scanned(pathSource("/extra"), high)]);

        assert.equal(catalog.skills.length, 1);
        assert.equal(catalog.skills[0]?.folder, "/extra/lint");
        assert.deepEqual(catalog.skills[0]?.source, pathSource("/extra"));
        assert.deepEqual(catalog.skills[0]?.shadowed, [{ path: "/data/skills/lint", source: internal }]);
    });

    it("uses the folder that sorts first inside one source and shadows the other with a diagnostic", () => {
        const catalog = resolveCatalog([
            scanned(pathSource("/p"), found("lint", "/p/y/lint"), found("lint", "/p/x/lint")),
        ]);

        assert.equal(catalog.skills[0]?.folder, "/p/x/lint");
        assert.deepEqual(catalog.skills[0]?.shadowed, [{ path: "/p/y/lint", source: pathSource("/p") }]);
        assert.equal(catalog.diagnostics.length, 1);
        assert.match(catalog.diagnostics[0] ?? "", /\/p\/y\/lint\/SKILL\.md.*shadowed inside its source/);
    });

    it("uses the workspace copy over a later search path", () => {
        const catalog = resolveCatalog([
            scanned(internal),
            scanned(pathSource("/late"), found("lint", "/late/lint")),
            scanned(workspace, found("lint", "/ws/.pi/skills/lint")),
        ]);

        assert.deepEqual(catalog.skills[0]?.source, workspace);
        assert.deepEqual(catalog.skills[0]?.shadowed, [{ path: "/late/lint", source: pathSource("/late") }]);
    });

    it("carries each source's left-out files and diagnostics", () => {
        const source = scanned(internal);
        source.scan.leftOut.push({ path: "/a/SKILL.md", reason: "description is required" });
        source.scan.diagnostics.push("a diagnostic");

        const catalog = resolveCatalog([source]);

        assert.deepEqual(catalog.leftOut, [{ path: "/a/SKILL.md", reason: "description is required" }]);
        assert.deepEqual(catalog.diagnostics, ["a diagnostic"]);
    });
});

describe("enabledSkillsOf", () => {
    const catalog = resolveCatalog([
        scanned(internal, found("alpha", "/d/alpha"), found("beta", "/d/beta")),
        scanned(workspace, found("local", "/ws/.pi/skills/local")),
    ]);

    it("returns the named skills the catalog uses, every workspace skill, and a missing name", () => {
        const result = enabledSkillsOf(catalog, new Set(["alpha", "ghost"]));

        assert.deepEqual(result.enabled.map((skill) => skill.name).sort(), ["alpha", "local"]);
        assert.deepEqual(result.missing, ["ghost"]);
    });
});
