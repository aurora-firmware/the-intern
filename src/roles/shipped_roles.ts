import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type RoleDefinition, SHIPPED_TOOL_NAMES } from "./role_model.ts";

export const SHIPPED_ROLE_NAMES = ["bob", "gp", "desk"] as const;
export const DEFAULT_LEAD_ROLE = "bob";

const readShippedText = (relativePath: string): Promise<string> =>
    readFile(fileURLToPath(new URL(`../shipped/${relativePath}`, import.meta.url)), "utf8");

const SKILLS_BY_ROLE: Record<(typeof SHIPPED_ROLE_NAMES)[number], string[]> = {
    bob: ["about-the-intern", "bob-command-line"],
    gp: ["carry-out-a-part", "bob-command-line"],
    desk: ["about-the-intern"],
};

const TOOLS_BY_ROLE: Record<(typeof SHIPPED_ROLE_NAMES)[number], string[]> = {
    bob: [...SHIPPED_TOOL_NAMES],
    gp: [...SHIPPED_TOOL_NAMES],
    desk: [],
};

export const SHIPPED_ROLES: RoleDefinition[] = SHIPPED_ROLE_NAMES.map((name) => ({
    name,
    tools: TOOLS_BY_ROLE[name],
    skills: SKILLS_BY_ROLE[name],
}));

export const loadPreamble = (): Promise<string> => readShippedText("instructions/common.md");
