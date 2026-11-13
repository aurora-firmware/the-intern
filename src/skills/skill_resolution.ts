import type { SourceScan } from "./skill_discovery.ts";

export type SkillSource = { kind: "internal" } | { kind: "path"; path: string } | { kind: "workspace"; path: string };

export type ScannedSource = { source: SkillSource; scan: SourceScan };

export type CatalogSkill = {
    name: string;
    description: string;
    folder: string;
    file: string;
    source: SkillSource;
    shadowed: { path: string; source: SkillSource }[];
};

export type Catalog = {
    skills: CatalogSkill[];
    leftOut: SourceScan["leftOut"];
    diagnostics: string[];
};

const byteOrder = (left: string, right: string): number => Buffer.compare(Buffer.from(left), Buffer.from(right));

/** The copy of each name a source uses, with the copies it shadows inside the source. */
function resolveInsideSource({ source, scan }: ScannedSource, diagnostics: string[]): Map<string, CatalogSkill> {
    const used = new Map<string, CatalogSkill>();
    const copies = [...scan.skills].sort((left, right) => byteOrder(left.folder, right.folder));
    for (const copy of copies) {
        const winner = used.get(copy.name);
        if (winner === undefined) {
            used.set(copy.name, { ...copy, source, shadowed: [] });
            continue;
        }
        winner.shadowed.push({ path: copy.folder, source });
        diagnostics.push(`${copy.file}: skill "${copy.name}": shadowed inside its source`);
    }
    return used;
}

function shadow(lower: CatalogSkill, higher: CatalogSkill): void {
    higher.shadowed.push({ path: lower.folder, source: lower.source }, ...lower.shadowed);
}

/** Resolves skill names across sources given in rising priority. */
export function resolveCatalog(sources: readonly ScannedSource[]): Catalog {
    const diagnostics: string[] = [];
    const leftOut: Catalog["leftOut"] = [];
    const byName = new Map<string, CatalogSkill>();
    for (const scanned of sources) {
        leftOut.push(...scanned.scan.leftOut);
        diagnostics.push(...scanned.scan.diagnostics);
        for (const [name, skill] of resolveInsideSource(scanned, diagnostics)) {
            const lower = byName.get(name);
            if (lower !== undefined) {
                shadow(lower, skill);
            }
            byName.set(name, skill);
        }
    }
    const skills = [...byName.values()].sort((left, right) => byteOrder(left.name, right.name));
    return { skills, leftOut, diagnostics };
}

/** The names of the set the catalog uses, plus every workspace skill; a name the catalog lacks is missing. */
export function enabledSkillsOf(
    catalog: Catalog,
    enabledSet: ReadonlySet<string>,
): { enabled: CatalogSkill[]; missing: string[] } {
    const enabled = catalog.skills.filter((skill) => skill.source.kind === "workspace" || enabledSet.has(skill.name));
    const held = new Set(catalog.skills.map((skill) => skill.name));
    const missing = [...enabledSet].filter((name) => !held.has(name));
    return { enabled, missing };
}
