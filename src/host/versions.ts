import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineDoc } from "@earendil-works/pi-durable";
import manifest from "../../package.json" with { type: "json" };
import { type HarnessHost, internalHarness } from "./harness_host.ts";

const context = BACKGROUND_CONTEXT;

export type Versions = { intern: string; pi: string };

// A daemon document (S-002 Definitions, "Database"): the versions that last opened the database.
const versionsDocument = defineDoc<{ intern?: string; pi?: string }>({
    kind: "intern.versions",
    version: 1,
    scope: "session",
    initial: () => ({}),
    checkpointWhen: () => false,
});

export function runningVersions(): Versions {
    return { intern: manifest.version, pi: manifest.dependencies["@earendil-works/pi-durable"] };
}

function toVersions(stored: Readonly<{ intern?: string; pi?: string }> | undefined): Versions | undefined {
    if (stored?.intern === undefined || stored.pi === undefined) return undefined;
    return { intern: stored.intern, pi: stored.pi };
}

/** Records the versions that open the database. Returns the previous ones when they differ; never migrates. */
export async function recordOpenedVersions(
    host: HarnessHost,
    running: Versions,
): Promise<{ changed: boolean; previous?: Versions }> {
    const harness = internalHarness(host);
    const previous = toVersions(await harness.snapshot(versionsDocument, context));
    if (previous?.intern === running.intern && previous.pi === running.pi) return { changed: false };

    await harness.commit(async (tx) => {
        const draft = await tx.doc(versionsDocument);
        draft.intern = running.intern;
        draft.pi = running.pi;
    }, context);
    return previous === undefined ? { changed: false } : { changed: true, previous };
}
