/**
 * The Skills panel's pure model (S-008 REQ-013): rows from the `skills.list` and `instructions.list` results, and which
 * feed deltas make the panel read them again. It imports no daemon type, so Node tests it without a DOM.
 */

type SourceResult = { kind: "internal" } | { kind: "path"; path: string } | { kind: "workspace"; path: string };

/** One skill of a `skills.list` result. */
export type SkillResult = {
    description: string;
    name: string;
    source: SourceResult;
    path: string;
    enabled: boolean;
    shipped: boolean;
    edited: boolean;
    deleted?: true;
    shadowed: { path: string; source: SourceResult }[];
};

/** A `skills.list` result. */
export type SkillListResult = {
    skills: readonly SkillResult[];
    missing: readonly string[];
    leftOut: readonly { path: string; reason: string }[];
};

/** One file of an `instructions.list` result. */
export type InstructionFileResult = {
    kind: string;
    path: string;
    shipped: boolean;
    edited: boolean;
    missing: boolean;
};

export type ShadowedRow = { sourceText: string; path: string };

/** A skill as the panel shows it. A workspace skill is always on, so its check box is checked and cannot change. */
export type SkillRow = {
    name: string;
    description: string;
    sourceText: string;
    path: string;
    isChecked: boolean;
    isChangeable: boolean;
    marks: string[];
    shadowed: ShadowedRow[];
};

export type SkillRows = {
    skills: SkillRow[];
    missing: string[];
    leftOut: { path: string; reason: string }[];
};

export type InstructionRow = { kind: string; path: string; marks: string[] };

/** The deltas the panel looks at. Declared here so the page imports no daemon type. */
export type PanelDelta =
    | { type: "skills_changed"; conversationId: string; enabledSkills: string[] }
    | { type: "settings_changed"; section: string }
    | { type: "files_changed"; path: string; kind: string }
    | { type: "run_started" | "run_finished" | "conversation_created"; conversationId: string };

const sourceText = (source: SourceResult): string =>
    source.kind === "internal" ? "internal" : `${source.kind} ${source.path}`;

const marksOf = (marks: readonly (readonly [boolean, string])[]): string[] =>
    marks.filter(([isSet]) => isSet).map(([, word]) => word);

const skillRow = (skill: SkillResult): SkillRow => {
    const isWorkspace = skill.source.kind === "workspace";
    return {
        name: skill.name,
        description: skill.description,
        sourceText: sourceText(skill.source),
        path: skill.path,
        isChecked: isWorkspace || skill.enabled,
        isChangeable: !isWorkspace,
        marks: marksOf([
            [skill.edited && skill.deleted !== true, "edited"],
            [skill.deleted === true, "deleted"],
        ]),
        shadowed: skill.shadowed.map((copy) => ({ sourceText: sourceText(copy.source), path: copy.path })),
    };
};

/** The rows of a `skills.list` result: each skill with the copies it shadows, then the missing names and left-out paths. */
export const skillRows = (list: SkillListResult): SkillRows => ({
    skills: list.skills.map(skillRow),
    missing: [...list.missing],
    leftOut: list.leftOut.map(({ path, reason }) => ({ path, reason })),
});

/** The rows of an `instructions.list` result, in the order the prompt reads the files. */
export const instructionRows = (list: { files: readonly InstructionFileResult[] }): InstructionRow[] =>
    list.files.map((file) => ({
        kind: file.kind,
        path: file.path,
        marks: marksOf([
            [file.shipped, "shipped"],
            [file.edited, "edited"],
            [file.missing, "missing"],
        ]),
    }));

/**
 * Whether the panel reads again after the delta: a `skills_changed` of its own conversation (`target`, null for a role
 * panel), any `settings_changed`, any `files_changed`.
 */
export const panelReloadNeeded = (delta: PanelDelta, target: string | null): boolean => {
    switch (delta.type) {
        case "skills_changed":
            return target !== null && delta.conversationId === target;
        case "settings_changed":
        case "files_changed":
            return true;
        default:
            return false;
    }
};
