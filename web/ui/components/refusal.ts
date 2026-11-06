import { h } from "preact";
import { ClientError, UnreachableError } from "../client/client.ts";

/** What a failed call tells the team member; a service that can't be reached is connection state, not a refusal. */
export const refusalText = (error: unknown): string | undefined => {
    if (error instanceof UnreachableError || (error instanceof ClientError && error.code === "unavailable")) {
        return undefined;
    }
    return error instanceof Error ? error.message : String(error);
};

/** The service's message for a failed call, next to the action that made it (S-006 REQ-013). */
export const RefusalMessage = ({ error }: { error: unknown }) => {
    const text = error === undefined ? undefined : refusalText(error);
    return text === undefined ? null : h("div", { class: "error refusal", role: "alert" }, text);
};
