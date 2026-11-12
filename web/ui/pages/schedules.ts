/**
 * The Schedules page (S-007 REQ-012): each schedule entry with its next due time, its recent scheduled runs linked to
 * their Job pages, and its skipped fires with the reason and any open run's link. A team member adds, changes, runs and
 * removes entries here; the service owns the rules, and its refusal shows next to the form or entry it concerns. The
 * entries are read again after a `shouldRereadSchedules` delta and on each new instance snapshot; a skipped fire joins
 * its entry with `addSkip`. Roles, models and workspaces are native choices from `roles.list`, `models.list` and
 * `workspaces.list`.
 */
import { h } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { listen } from "../components/activity.ts";
import { isConnected } from "../components/connection_banner.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";
import { requestId } from "../model/request_id.ts";
import {
    addSkip,
    type ScheduleCard,
    type ScheduleDelta,
    type ScheduleHistoryItem,
    type SchedulesState,
    shouldRereadSchedules,
} from "../model/schedules.ts";

type Entry = {
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
type Choices = { roles: string[]; models: Model[]; workspaces: string[] };
type Fields = {
    cron: string;
    request: string;
    role: string;
    model: string;
    thinkingLevel: string;
    workspace: string;
};
type RunsItem = { kind: "run"; firedAt: string; job: { number: string } } | { kind: "skip"; skip: ScheduleSkipText };
type ScheduleSkipText = { entry: string; dueTime: string; reason: string; openRun: string | null };
type Data = { entries: Entry[]; cards: SchedulesState; choices: Choices };
type Reload = () => Promise<void>;
type Apply = (delta: ScheduleDelta) => void;

const RECENT_RUNS = 10;
const NOT_SET = "";
const OPTIONAL_KEYS = ["role", "model", "thinkingLevel", "workspace"] as const;

// A feed connection has no way to remove a listener, so it gets one that speaks to the mounted page.
let mountedReload: Reload | undefined;
let mountedApply: Apply | undefined;
const attachedFeeds = new WeakSet<FeedConnection>();

const attachFeed = (feed: FeedConnection) => {
    if (attachedFeeds.has(feed)) return;
    attachedFeeds.add(feed);
    feed.onInstanceSnapshot(() => void mountedReload?.());
    listen(feed, (event) => {
        if (event.type !== "instance-delta") return;
        const delta = event.delta as ScheduleDelta;
        if (shouldRereadSchedules(delta)) void mountedReload?.();
        mountedApply?.(delta);
    });
};

const historyItemOf = (item: RunsItem): ScheduleHistoryItem =>
    item.kind === "run"
        ? { kind: "run", firedAt: item.firedAt, jobNumber: item.job.number }
        : { kind: "skip", skip: item.skip };

const readData = async (): Promise<Data> => {
    const client = pageClient();
    const { schedules } = (await client.invoke("schedules.list")) as { schedules: Entry[] };
    const cards: ScheduleCard[] = await Promise.all(
        schedules.map(async ({ name }) => {
            const { items } = (await client.invoke("schedules.runs", { name, limit: RECENT_RUNS })) as {
                items: RunsItem[];
            };
            return { name, history: items.map(historyItemOf) };
        }),
    );
    const { roles } = (await client.invoke("roles.list")) as { roles: { name: string }[] };
    const models = (await client.invoke("models.list")) as Model[];
    const { workspaces } = (await client.invoke("workspaces.list")) as { workspaces: { path: string }[] };
    const choices = {
        roles: roles.map((role) => role.name),
        models,
        workspaces: workspaces.map((workspace) => workspace.path),
    };
    return { entries: schedules, cards, choices };
};

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

const EntryCard = ({
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

const CreateEntry = ({ choices, reload }: { choices: Choices; reload: Reload }) => {
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

/** The schedule entries, each with its next due time, recent scheduled runs and skipped fires. */
export const SchedulesPage = ({ feed }: { feed: FeedConnection | null | undefined }) => {
    const [data, setData] = useState<Data | undefined>(undefined);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);

    useEffect(() => {
        // `undefined` means the tab is still connecting: the first read waits for the feed.
        if (feed === undefined) return;
        let isClosed = false;
        const reload: Reload = async () => {
            try {
                const read = await readData();
                if (isClosed) return;
                setData(read);
                setFailure(undefined);
            } catch (error) {
                if (!isClosed) setFailure({ error });
            }
        };
        const apply: Apply = (delta) =>
            setData((held) => (held === undefined ? held : { ...held, cards: addSkip(held.cards, delta) }));
        mountedReload = reload;
        mountedApply = apply;
        if (feed !== null) attachFeed(feed);
        void reload();
        return () => {
            isClosed = true;
            if (mountedReload === reload) mountedReload = undefined;
            if (mountedApply === apply) mountedApply = undefined;
        };
    }, [feed]);

    const reload: Reload = async () => void (await mountedReload?.());
    return h(
        "div",
        { class: "schedules" },
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        data === undefined
            ? null
            : [
                  ...data.entries.map((entry) =>
                      h(EntryCard, {
                          entry,
                          card: data.cards.find((card) => card.name === entry.name),
                          choices: data.choices,
                          reload,
                          key: entry.name,
                      }),
                  ),
                  h(CreateEntry, { choices: data.choices, reload }),
              ],
    );
};
