/**
 * The schedule entry forms and cards of the Schedules page (S-007 REQ-012): the form that adds an entry, and for each
 * entry its form with Save, Run now and Remove, plus its recent scheduled runs and skipped fires. The service owns the
 * rules; its refusal shows next to the form or entry it concerns. While the service can't be reached every action is
 * disabled and typed text stays (S-006 REQ-013, REQ-014).
 */
import { h } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { pageClient } from "../feed_connection.ts";
import { requestId } from "../model/request_id.ts";
import type { ScheduleCard, ScheduleHistoryItem } from "../model/schedules.ts";
import { isConnected } from "./connection_banner.ts";
import { RefusalMessage } from "./refusal.ts";

export type Entry = {
    name: string;
    cron: string;
    request: string;
    role?: string;
    model?: string;
    thinkingLevel?: string;
    workspace?: string;
    nextDueTime: string;
};
type Model = { model: string; thinkingLevels: string[] };
export type Choices = { roles: string[]; models: Model[]; workspaces: string[] };
type Fields = {
    cron: string;
    request: string;
    role: string;
    model: string;
    thinkingLevel: string;
    workspace: string;
};
type Reload = () => Promise<void>;

const NOT_SET = "";
const OPTIONAL_KEYS = ["role", "model", "thinkingLevel", "workspace"] as const;

const fieldsOf = (entry: Entry | undefined): Fields => ({
    cron: entry?.cron ?? "",
    request: entry?.request ?? "",
    role: entry?.role ?? NOT_SET,
    model: entry?.model ?? NOT_SET,
    thinkingLevel: entry?.thinkingLevel ?? NOT_SET,
    workspace: entry?.workspace ?? NOT_SET,
});

/** The values the form names. A value left unset is left out of a new entry and clears the entry's value in a change. */
const inputOf = (fields: Fields, unset: null | undefined): Record<string, unknown> => ({
    cron: fields.cron,
    request: fields.request,
    ...Object.fromEntries(OPTIONAL_KEYS.map((key) => [key, fields[key] === NOT_SET ? unset : fields[key]])),
});

const choice = (
    label: string,
    name: string,
    value: string,
    options: readonly string[],
    onChange: (value: string) => void,
) =>
    h(
        "label",
        null,
        label,
        h(
            "select",
            { name, value, onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
            h("option", { value: NOT_SET }, "Default"),
            ...[...new Set(value === NOT_SET || options.includes(value) ? options : [...options, value])].map((each) =>
                h("option", { value: each }, each),
            ),
        ),
    );

const text = (label: string, name: string, value: string, onChange: (value: string) => void, isInput: boolean) =>
    h(
        "label",
        null,
        label,
        h(isInput ? "input" : "textarea", {
            name,
            value,
            ...(isInput ? { type: "text" } : { rows: 3 }),
            onInput: (event: Event) => onChange((event.target as HTMLInputElement).value),
        }),
    );

const levelsFor = (choices: Choices, model: string): string[] => {
    const named = choices.models.find((each) => each.model === model);
    return named !== undefined
        ? named.thinkingLevels
        : [...new Set(choices.models.flatMap((each) => each.thinkingLevels))];
};

const useFields = (initial: Fields) => {
    const [fields, setFields] = useState(initial);
    const set = (name: keyof Fields) => (value: string) => setFields((held) => ({ ...held, [name]: value }));
    return { fields, setFields, set };
};

const entryFields = (choices: Choices, fields: Fields, set: (name: keyof Fields) => (value: string) => void) => [
    text("Cron", "cron", fields.cron, set("cron"), true),
    text("Request", "request", fields.request, set("request"), false),
    choice("Role", "role", fields.role, choices.roles, set("role")),
    choice(
        "Model",
        "model",
        fields.model,
        choices.models.map((each) => each.model),
        set("model"),
    ),
    choice(
        "Thinking level",
        "thinkingLevel",
        fields.thinkingLevel,
        levelsFor(choices, fields.model),
        set("thinkingLevel"),
    ),
    choice("Workspace", "workspace", fields.workspace, choices.workspaces, set("workspace")),
];

/** One action at a time: whether it is going, and what the service said when it refused. */
const useCall = () => {
    const [isCalling, setCalling] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const call = async (action: () => Promise<void>) => {
        setCalling(true);
        setFailure(undefined);
        try {
            await action();
        } catch (error) {
            setFailure({ error });
        } finally {
            setCalling(false);
        }
    };
    return { isCalling, failure, call };
};

const actionButton = (label: string, className: string, isDisabled: boolean, onClick: () => unknown) =>
    h("button", { type: "button", class: `button ${className}`, disabled: isDisabled, onClick }, label);

const jobLink = (number: string) => h("a", { href: `#/jobs/${number}`, "data-verbatim": "" }, number);

const historyRow = (item: ScheduleHistoryItem) =>
    item.kind === "run"
        ? h("li", { class: "schedule-run", key: `run-${item.jobNumber}` }, `${item.firedAt} `, jobLink(item.jobNumber))
        : h(
              "li",
              { class: "schedule-skip", key: `skip-${item.skip.dueTime}` },
              `${item.skip.dueTime} skipped: `,
              h("span", { class: "schedule-skip-reason" }, item.skip.reason),
              item.skip.openRun === null ? null : [" ", jobLink(item.skip.openRun)],
          );

/** An entry with its form, its actions and its history. */
export const EntryCard = ({
    entry,
    card,
    choices,
    reload,
}: {
    entry: Entry;
    card: ScheduleCard | undefined;
    choices: Choices;
    reload: Reload;
}) => {
    const connected = useContext(isConnected);
    const { fields, setFields, set } = useFields(fieldsOf(entry));
    const { isCalling, failure, call } = useCall();
    const stored = useRef(entry);

    // A reread that brought different values replaces the form; the team member's own edits stay otherwise.
    useEffect(() => {
        if (JSON.stringify(stored.current) === JSON.stringify(entry)) return;
        stored.current = entry;
        setFields(fieldsOf(entry));
    }, [entry, setFields]);

    const invoke = (operation: string, input: Record<string, unknown>) => () =>
        call(async () => {
            await pageClient().invoke(operation, { name: entry.name, ...input });
            await reload();
        });
    const isDisabled = !connected || isCalling;
    return h(
        "section",
        { class: "schedule", "data-entry": entry.name },
        h("h3", null, h("span", { "data-verbatim": "" }, entry.name)),
        h("p", null, "Next due ", h("span", { class: "schedule-next" }, entry.nextDueTime)),
        ...entryFields(choices, fields, set),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        actionButton("Save", "schedule-save", isDisabled, invoke("schedules.change", inputOf(fields, null))),
        actionButton(
            "Run now",
            "schedule-run-now",
            isDisabled,
            invoke("schedules.run", { idempotencyKey: requestId() }),
        ),
        actionButton("Remove", "button-destructive schedule-remove", isDisabled, invoke("schedules.remove", {})),
        h("ul", { class: "schedule-history" }, ...(card?.history ?? []).map(historyRow)),
    );
};

/** The form that adds an entry. */
export const CreateEntry = ({ choices, reload }: { choices: Choices; reload: Reload }) => {
    const connected = useContext(isConnected);
    const [name, setName] = useState("");
    const { fields, setFields, set } = useFields(fieldsOf(undefined));
    const { isCalling, failure, call } = useCall();

    const create = () =>
        call(async () => {
            await pageClient().invoke("schedules.create", {
                name,
                ...inputOf(fields, undefined),
                idempotencyKey: requestId(),
            });
            setName("");
            setFields(fieldsOf(undefined));
            await reload();
        });

    return h(
        "section",
        { class: "schedule-create" },
        h("h3", null, "Add an entry"),
        text("Name", "name", name, setName, true),
        ...entryFields(choices, fields, set),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        actionButton("Add", "schedule-create-submit", !connected || isCalling, create),
    );
};
