import { h } from "preact";
import { useContext, useRef, useState } from "preact/hooks";
import { pageClient } from "../feed_connection.ts";
import { createDraftStore, loadDraft } from "../model/drafts.ts";
import { routeHash } from "../model/routes.ts";
import { isConnected } from "./connection_banner.ts";
import { RefusalMessage } from "./refusal.ts";
import { DraftTextBox } from "./text_box.ts";

const PAGE = "desk";
const BOX = "new-job";
const drafts = createDraftStore(window.sessionStorage);

/**
 * The form that creates a job directly through `jobs.create` (S-006 REQ-008), with its text and an optional title.
 * Empty text goes to the service, which refuses it; the refusal shows here and nothing is created. The new job's page
 * opens from its short number.
 */
export const CreateJobForm = () => {
    const connected = useContext(isConnected);
    const clearRef = useRef<(() => void) | null>(null);
    const [title, setTitle] = useState("");
    const [isCreating, setCreating] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);

    const create = async () => {
        setCreating(true);
        setFailure(undefined);
        try {
            const text = loadDraft(drafts, PAGE, BOX) ?? "";
            const job = (await pageClient().invoke("jobs.create", {
                text,
                ...(title === "" ? {} : { title }),
            })) as { number: string };
            clearRef.current?.();
            setTitle("");
            window.location.hash = routeHash({ page: "job", number: job.number });
        } catch (error) {
            setFailure({ error });
        } finally {
            setCreating(false);
        }
    };

    return h(
        "section",
        { class: "create-job" },
        h("h3", null, "Create a job"),
        h(
            "label",
            null,
            "Title (optional)",
            h("input", {
                type: "text",
                value: title,
                onInput: (event: Event) => setTitle((event.target as HTMLInputElement).value),
            }),
        ),
        h("label", null, "Text", h(DraftTextBox, { page: PAGE, box: BOX, clearRef, store: drafts })),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        h("button", { type: "button", class: "button", disabled: !connected || isCreating, onClick: create }, "Create"),
    );
};
