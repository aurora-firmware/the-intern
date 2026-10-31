import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Extension, type PromptInput, section } from "@earendil-works/pi-durable";
import { conversationMetaDoc } from "../host/seating.ts";
import type { Seat } from "../roles/role_model.ts";
import { renderRolePrompt } from "./role_prompt.ts";
import type { WorkspaceContext } from "./workspace_context.ts";

export const ROLE_PROMPT_EXTENSION_NAME = "intern.role-prompt";

const PREAMBLE_KEY = "intern.preamble";
const SECTION_KEYS = [
    PREAMBLE_KEY,
    "intern.role",
    "intern.role-skills",
    "intern.workspace-context",
    "intern.workspace-skills",
];

export type RolePromptExtensionOptions = {
    preamble: string;
    loader: { load(seat: Seat): WorkspaceContext };
};

// The seat comes from the conversation's own document, never from the catalog, so a seated agent keeps the role it was
// seated with and a seat change replaces every part of the previous seat.
async function readSeat(input: PromptInput, context: Context): Promise<Seat | undefined> {
    const meta = await input.read.snapshot(conversationMetaDoc, input.conversationId, context);
    return meta === undefined || meta.jobId === "" ? undefined : meta.seat;
}

export function createRolePromptExtension(options: RolePromptExtensionOptions): Extension {
    const { preamble, loader } = options;
    const sections = SECTION_KEYS.map((key) =>
        // pi-durable section keys allow no dots, so the dot of the rendered part's key becomes a hyphen.
        section(key.replace(".", "-"), async (input, context) => {
            const seat = await readSeat(input, context);
            if (seat === undefined) return key === PREAMBLE_KEY && preamble !== "" ? preamble : undefined;
            const rendered = renderRolePrompt({ preamble, seat, ...loader.load(seat) });
            return rendered.find((part) => part.key === key)?.text;
        }),
    );
    return defineExtension({ name: ROLE_PROMPT_EXTENSION_NAME, sections });
}
