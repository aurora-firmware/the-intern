import { register } from "node:module";

// Registers a resolve hook that writes every resolved file: URL to standard error, so an inspection can list
// the modules a bob command loads. Use it as: node --import ./test/support/module_trace.ts src/cli/bob.ts ...
const RESOLVE_HOOK_SOURCE = `
import { writeSync } from "node:fs";
export async function resolve(specifier, context, nextResolve) {
    const result = await nextResolve(specifier, context);
    if (result.url.startsWith("file:")) writeSync(2, "module-trace " + result.url + "\\n");
    return result;
}
`;

register(`data:text/javascript,${encodeURIComponent(RESOLVE_HOOK_SOURCE)}`);
