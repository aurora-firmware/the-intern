import type { Context } from "@earendil-works/chord/context";
import { defineExtension, type Extension, type PromptInput, section } from "@earendil-works/pi-durable";
import { type ConversationMeta, conversationMetaDoc } from "../host/seating.ts";
import type { DiagnosticLog } from "../skills/skill_discovery.ts";
import { type PromptPartsOptions, readCommonPrompt, readPromptParts } from "./prompt_sources.ts";
import { type PromptSection, renderPromptSections } from "./role_prompt.ts";

export const ROLE_PROMPT_EXTENSION_NAME = "intern.role-prompt";

const SECTION_KEYS = ["intern-common", "intern-role", "intern-lead-duty", "intern-workspace-context", "intern-skills"];

// The folders and settings are known only after startup, so each is read when a request is prepared.
export type RolePromptExtensionOptions = {
    dataDir: () => string;
    searchPaths: () => readonly string[];
    defaultsOf: PromptPartsOptions["defaultsOf"];
    diagnostics: DiagnosticLog;
    shippedRoot?: string;
};

// The seat comes from the conversation's own document, never from the catalog, so a seat change replaces every part of
// the previous seat.
async function readDocument(input: PromptInput, context: Context): Promise<ConversationMeta | undefined> {
    const meta = await input.read.snapshot(conversationMetaDoc, input.conversationId, context);
    return meta === undefined || meta.jobId === "" ? undefined : meta;
}

export function createRolePromptExtension(options: RolePromptExtensionOptions): Extension {
    const { diagnostics } = options;
    // pi-durable hands every section of one request preparation the same input, so the files are read and rendered once
    // per request and each section takes its part. All sections of one prompt then come from one state of the files,
    // the next request reads afresh, and nothing outlives the request that rendered it.
    const renderedByRequest = new WeakMap<PromptInput, Promise<PromptSection[]>>();
    const renderRequest = async (input: PromptInput, context: Context): Promise<PromptSection[]> => {
        const dataDir = options.dataDir();
        const meta = await readDocument(input, context);
        if (meta === undefined) {
            const common = await readCommonPrompt({ dataDir, diagnostics });
            return common === undefined ? [] : [{ key: "intern-common", text: common }];
        }
        const parts = await readPromptParts({
            meta,
            dataDir,
            searchPaths: options.searchPaths(),
            defaultsOf: options.defaultsOf,
            diagnostics,
            shippedRoot: options.shippedRoot,
        });
        return renderPromptSections(parts);
    };
    const sections = SECTION_KEYS.map((key) =>
        section(key, async (input, context) => {
            let rendered = renderedByRequest.get(input);
            if (rendered === undefined) {
                rendered = renderRequest(input, context);
                renderedByRequest.set(input, rendered);
            }
            return (await rendered).find((part) => part.key === key)?.text;
        }),
    );
    return defineExtension({ name: ROLE_PROMPT_EXTENSION_NAME, sections });
}
