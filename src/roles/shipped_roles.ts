import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { type RoleDefinition, SHIPPED_TOOL_NAMES } from "./role_model.ts";

export const SHIPPED_ROLE_NAMES = ["bob", "gp", "desk"] as const;
export const DEFAULT_LEAD_ROLE = "bob";

const readShippedText = (relativePath: string): Promise<string> =>
    readFile(fileURLToPath(new URL(`./shipped/${relativePath}`, import.meta.url)), "utf8");

const shippedSkillFolder = (name: string): string =>
    fileURLToPath(new URL(`./shipped/skills/${name}`, import.meta.url));

const SKILLS_BY_ROLE: Record<(typeof SHIPPED_ROLE_NAMES)[number], string[]> = {
    bob: [],
    gp: [shippedSkillFolder("carry-out-a-part")],
    desk: [],
};

const TOOLS_BY_ROLE: Record<(typeof SHIPPED_ROLE_NAMES)[number], string[]> = {
    bob: [...SHIPPED_TOOL_NAMES],
    gp: [...SHIPPED_TOOL_NAMES],
    desk: [],
};

export const loadShippedRoles = (): Promise<RoleDefinition[]> =>
    Promise.all(
        SHIPPED_ROLE_NAMES.map(
            async (name): Promise<RoleDefinition> => ({
                name,
                instructions: await readShippedText(`${name}.md`),
                tools: TOOLS_BY_ROLE[name],
                skills: SKILLS_BY_ROLE[name],
            }),
        ),
    );

export const loadPreamble = (): Promise<string> => readShippedText("preamble.md");
