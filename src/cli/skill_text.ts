/**
 * The text the `bob skills` and `bob instructions` commands print (S-008 REQ-012). Pure: each function turns service
 * answers into text of names, paths, sources and marks as words, and never prints file text or a skill's description.
 * A shadowed copy prints on an indented line under the copy in use. Every value goes through `terminal_text.ts`'s
 * `flat`, so no line of data starts at the margin or holds a control sequence.
 */
import { formatSeat } from "./conversation_text.ts";
import { flat } from "./terminal_text.ts";

type SourceView = { kind: "internal" } | { kind: "path"; path: string } | { kind: "workspace"; path: string };

/** One skill of the `skills.list` answer, and the answer of `skills.restore`. */
export type SkillView = {
    description: string;
    name: string;
    source: SourceView;
    path: string;
    enabled: boolean;
    shipped: boolean;
    edited: boolean;
    deleted?: true;
    shadowed: { path: string; source: SourceView }[];
};

/** The `skills.list` answer. */
export type SkillListView = {
    skills: readonly SkillView[];
    missing: readonly string[];
    leftOut: readonly { path: string; reason: string }[];
    seat?: { role: string; model: string; thinkingLevel?: string; workspace: string };
};

/** One entry of the `skills.paths.*` answers. */
export type SearchPathView = { path: string; ok: boolean; reason?: string };

/** One entry of the `instructions.list` answer. */
export type InstructionFileView = { kind: string; path: string; shipped: boolean; edited: boolean; missing: boolean };

const INDENT = "    ";

function sourceText(source: SourceView): string {
    return source.kind === "internal" ? "internal" : `${source.kind} ${flat(source.path)}`;
}

function words(marks: readonly (readonly [boolean, string])[]): string {
    const present = marks.filter(([isSet]) => isSet).map(([, word]) => word);
    return present.length === 0 ? "" : `  ${present.join(" ")}`;
}

/** The skill's line, then one indented line per copy it shadows. */
function skillLines(skill: SkillView): string[] {
    const marks = words([
        [skill.enabled, "enabled"],
        [skill.edited && skill.deleted !== true, "edited"],
        [skill.deleted === true, "deleted"],
    ]);
    const line = `${flat(skill.name)}  ${sourceText(skill.source)}  ${flat(skill.path)}${marks}`;
    return [line, ...skill.shadowed.map((copy) => `${INDENT}shadowed: ${sourceText(copy.source)}  ${flat(copy.path)}`)];
}

/** The seat of a conversation, then one line per skill, the missing names and the left-out paths. */
export function skillListText(result: SkillListView): string {
    const lines = result.seat === undefined ? [] : [`seat: ${formatSeat(result.seat)}`];
    lines.push(...result.skills.flatMap(skillLines));
    lines.push(...result.missing.map((name) => `missing: ${flat(name)}`));
    lines.push(...result.leftOut.map((left) => `left out: ${flat(left.path)} - ${flat(left.reason)}`));
    return lines.join("\n");
}

/** One line per search path, with the reason when it fails the check a search path must pass. */
export function searchPathsText(paths: readonly SearchPathView[]): string {
    return paths
        .map((entry) => (entry.ok ? flat(entry.path) : `${flat(entry.path)}  unusable: ${flat(entry.reason ?? "")}`))
        .join("\n");
}

/** One line per instruction file, in the order the prompt reads them. */
export function instructionListText(result: { files: readonly InstructionFileView[] }): string {
    return result.files
        .map((file) => {
            const marks = words([
                [file.shipped, "shipped"],
                [file.edited, "edited"],
                [file.missing, "missing"],
            ]);
            return `${flat(file.kind)}  ${flat(file.path)}${marks}`;
        })
        .join("\n");
}

/** One restored skill, as its line of the list. */
export function skillText(skill: SkillView): string {
    return skillLines(skill).join("\n");
}
