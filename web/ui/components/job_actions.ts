import { h } from "preact";
import { useContext, useState } from "preact/hooks";
import { pageClient } from "../feed_connection.ts";
import { isConnected } from "./connection_banner.ts";
import type { JobRecord } from "./job_record.ts";
import { RefusalMessage } from "./refusal.ts";

type EditableField = "title" | "description" | "definitionOfDone";

const EDIT_FIELDS: readonly { name: EditableField; label: string; isLong: boolean }[] = [
    { name: "title", label: "Title", isLong: false },
    { name: "description", label: "Description", isLong: true },
    { name: "definitionOfDone", label: "Definition of done", isLong: true },
];

/** One call at a time for a part of the page: whether it is going, and what the service said when it refused. */
const useCall = () => {
    const [sending, setSending] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const run = async (call: () => Promise<unknown>): Promise<boolean> => {
        setSending(true);
        setFailure(undefined);
        try {
            await call();
            return true;
        } catch (error) {
            setFailure({ error });
            return false;
        } finally {
            setSending(false);
        }
    };
    return { sending, failure, run };
};

const textOf = (event: Event) => (event.target as HTMLInputElement | HTMLTextAreaElement).value;

/** The title, description and definition of done as inputs; Save sends the ones the team member changed. */
const EditForm = ({ record }: { record: JobRecord }) => {
    const connected = useContext(isConnected);
    const [typed, setTyped] = useState<Partial<Record<EditableField, string>>>({});
    const { sending, failure, run } = useCall();
    const changed = EDIT_FIELDS.filter(({ name }) => typed[name] !== undefined && typed[name] !== record[name]);

    const save = async () => {
        const fields = Object.fromEntries(changed.map(({ name }) => [name, typed[name]]));
        if (await run(() => pageClient().invoke("jobs.update", { job: record.number, ...fields }))) setTyped({});
    };

    return h(
        "div",
        { class: "job-edit" },
        ...EDIT_FIELDS.map(({ name, label, isLong }) =>
            h(
                "label",
                { key: name },
                label,
                h(isLong ? "textarea" : "input", {
                    name,
                    value: typed[name] ?? record[name],
                    onInput: (event: Event) => setTyped({ ...typed, [name]: textOf(event) }),
                }),
            ),
        ),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        h(
            "button",
            { type: "button", class: "button", disabled: !connected || sending || changed.length === 0, onClick: save },
            "Save",
        ),
    );
};

/** Complete or cancel with a justification. An empty one is sent as it is: the service refuses it (S-006 REQ-013). */
const FinishForm = ({ number }: { number: string }) => {
    const connected = useContext(isConnected);
    const [justification, setJustification] = useState("");
    const { sending, failure, run } = useCall();
    const finish = (operation: "jobs.complete" | "jobs.cancel") => async () => {
        if (await run(() => pageClient().invoke(operation, { job: number, justification }))) setJustification("");
    };
    const button = (cls: string, label: string, operation: "jobs.complete" | "jobs.cancel") =>
        h(
            "button",
            { type: "button", class: `button ${cls}`, disabled: !connected || sending, onClick: finish(operation) },
            label,
        );

    return h(
        "div",
        { class: "job-finish" },
        h(
            "label",
            null,
            "Justification",
            h("textarea", { value: justification, onInput: (event: Event) => setJustification(textOf(event)) }),
        ),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        button("job-complete", "Complete", "jobs.complete"),
        button("job-cancel button-destructive", "Cancel", "jobs.cancel"),
    );
};

/** Relates this job to another, given by its number. */
const RelateForm = ({ number }: { number: string }) => {
    const connected = useContext(isConnected);
    const [other, setOther] = useState("");
    const { sending, failure, run } = useCall();
    const relate = async () => {
        if (await run(() => pageClient().invoke("jobs.relate", { job: number, other }))) setOther("");
    };
    return h(
        "div",
        { class: "job-relate" },
        h(
            "label",
            null,
            "Relate to job",
            h("input", { value: other, onInput: (event: Event) => setOther(textOf(event)) }),
        ),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        h("button", { type: "button", class: "button", disabled: !connected || sending, onClick: relate }, "Relate"),
    );
};

/** Removes the relation between two jobs; it sits next to the related job it removes. */
export const UnrelateButton = ({ number, other }: { number: string; other: string }) => {
    const connected = useContext(isConnected);
    const { sending, failure, run } = useCall();
    return h(
        "span",
        null,
        h(
            "button",
            {
                type: "button",
                class: "button button-secondary job-unrelate",
                disabled: !connected || sending,
                onClick: () => run(() => pageClient().invoke("jobs.unrelate", { job: number, other })),
            },
            "Remove",
        ),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
    );
};

/** What a team member does to a job from its page (S-006 REQ-004): edit, complete, cancel and relate. */
export const JobActions = ({ record }: { record: JobRecord }) =>
    h(
        "section",
        { class: "job-actions", key: record.number },
        h("h3", null, "Actions"),
        h(EditForm, { record }),
        h(FinishForm, { number: record.number }),
        h(RelateForm, { number: record.number }),
    );
