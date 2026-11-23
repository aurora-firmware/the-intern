import { join } from "node:path";
import { defineExtension } from "@earendil-works/pi-durable";
import { CodingTools, createBashTool } from "@earendil-works/pi-durable/tools";

export const SHIPPED_TOOLS_EXTENSION_NAME = "intern.tools";

export type ShippedToolsOptions = {
    /** The instance's runtime directory; read at each `bash` call, so it may be unknown until startup step 3 has run. */
    runtimeDir: () => string;
};

/**
 * pi-durable's `read`, `write`, `edit` and `bash`; a conversation's agent `tools` select which of them a request offers.
 * `bash` runs with the instance's runtime directory, the call's conversation id and the launcher folder, so `bob` in
 * an agent's shell reaches the instance that runs the agent (S-008 REQ-014).
 */
export function createShippedToolsExtension(options: ShippedToolsOptions) {
    const bash = createBashTool({
        prepare(execution, api) {
            const runtimeDir = options.runtimeDir();
            execution.env.BOB_RUNTIME_DIR = runtimeDir;
            execution.env.BOB_CONVERSATION_ID = String(api.conversationId);
            const inherited = execution.inheritEnv ? (process.env.PATH ?? "") : (execution.env.PATH ?? "");
            execution.env.PATH = [join(runtimeDir, "bin"), inherited].filter((part) => part !== "").join(":");
        },
    });
    return defineExtension({
        name: SHIPPED_TOOLS_EXTENSION_NAME,
        tools: (CodingTools.tools ?? []).map((tool) => (tool.name === bash.name ? bash : tool)),
    });
}
