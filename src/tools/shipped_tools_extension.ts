import { defineExtension } from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";

export const SHIPPED_TOOLS_EXTENSION_NAME = "intern.tools";

/** pi-durable's `read`, `write`, `edit` and `bash`; a conversation's agent `tools` select which of them a request offers. */
export const shippedToolsExtension = defineExtension({
    name: SHIPPED_TOOLS_EXTENSION_NAME,
    tools: CodingTools.tools,
});
