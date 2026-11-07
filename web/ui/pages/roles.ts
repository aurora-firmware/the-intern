/**
 * The Roles page (S-006 REQ-009): every role with its settings, a form that creates a role, and for each role Save,
 * Restore and Remove. The service decides what is allowed (S-001 REQ-003) and a refusal shows next to the role it
 * concerns. The list is read again after a `settings_changed` delta and on each new instance snapshot. Models and
 * workspaces are native choices from `models.list` and `workspaces.list`.
 */
import { h } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { listen } from "../components/activity.ts";
import { isConnected } from "../components/connection_banner.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";

type Role = {
    name: string;
    instructions: string;
    tools: string[];
    skills: string[];
    model?: string;
    thinkingLevel?: string;
    workspace?: string;
    shipped: boolean;
    changed: boolean;
};
type Model = { model: string; thinkingLevels: string[] };
type Workspace = { path: string };
type Data = { roles: Role[]; models: Model[]; workspaces: Workspace[] };
type Fields = {
    instructions: string;
    tools: string;
    skills: string;
    model: string;
    thinkingLevel: string;
    workspace: string;
};
type Reload = () => Promise<void>;

const NOT_SET = "";

// A feed connection has no way to remove a listener, so it gets one that speaks to the mounted page.
let mountedReload: Reload | undefined;
const attachedFeeds = new WeakSet<FeedConnection>();

const attachFeed = (feed: FeedConnection) => {
    if (attachedFeeds.has(feed)) return;
    attachedFeeds.add(feed);
    feed.onInstanceSnapshot(() => void mountedReload?.());
    listen(feed, (event) => {
        if (event.type === "instance-delta" && (event.delta as { type?: string }).type === "settings_changed") {
            void mountedReload?.();
        }
    });
};

const readData = async (): Promise<Data> => {
    const client = pageClient();
    const { roles } = (await client.invoke("roles.list")) as { roles: Role[] };
    const models = (await client.invoke("models.list")) as Model[];
    const { workspaces } = (await client.invoke("workspaces.list")) as { workspaces: Workspace[] };
    return { roles, models, workspaces };
};

const linesOf = (text: string): string[] =>
    text
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");

const fieldsOf = (role: Role | undefined): Fields => ({
    instructions: role?.instructions ?? "",
    tools: (role?.tools ?? []).join("\n"),
    skills: (role?.skills ?? []).join("\n"),
    model: role?.model ?? NOT_SET,
    thinkingLevel: role?.thinkingLevel ?? NOT_SET,
    workspace: role?.workspace ?? NOT_SET,
});

/** The role fields the form names; a choice left unset is left out, so the service keeps its value. */
const inputOf = (fields: Fields): Record<string, unknown> => ({
    instructions: fields.instructions,
    tools: linesOf(fields.tools),
    skills: linesOf(fields.skills),
    ...(fields.model === NOT_SET ? {} : { model: fields.model }),
    ...(fields.thinkingLevel === NOT_SET ? {} : { thinkingLevel: fields.thinkingLevel }),
    ...(fields.workspace === NOT_SET ? {} : { workspace: fields.workspace }),
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

const text = (label: string, name: string, value: string, onChange: (value: string) => void, isInput = false) =>
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

const useFields = (initial: Fields) => {
    const [fields, setFields] = useState(initial);
    const set = (name: keyof Fields) => (value: string) => setFields((held) => ({ ...held, [name]: value }));
    return { fields, setFields, set };
};

const levelsFor = (data: Data, model: string): string[] => {
    const named = data.models.find((each) => each.model === model);
    return named !== undefined
        ? named.thinkingLevels
        : [...new Set(data.models.flatMap((each) => each.thinkingLevels))];
};

const settingsFields = (data: Data, fields: Fields, set: (name: keyof Fields) => (value: string) => void) => [
    text("Instructions", "instructions", fields.instructions, set("instructions")),
    text("Tools (one per line)", "tools", fields.tools, set("tools")),
    text("Skills (absolute paths, one per line)", "skills", fields.skills, set("skills")),
    choice(
        "Default model",
        "model",
        fields.model,
        data.models.map((each) => each.model),
        set("model"),
    ),
    choice(
        "Thinking level",
        "thinkingLevel",
        fields.thinkingLevel,
        levelsFor(data, fields.model),
        set("thinkingLevel"),
    ),
    choice(
        "Workspace",
        "workspace",
        fields.workspace,
        data.workspaces.map((each) => each.path),
        set("workspace"),
    ),
];

type Calling = (action: () => Promise<void>) => Promise<void>;

const RoleCard = ({ role, data, reload }: { role: Role; data: Data; reload: Reload }) => {
    const connected = useContext(isConnected);
    const { fields, setFields, set } = useFields(fieldsOf(role));
    const [isCalling, setCalling] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const stored = useRef(role);

    // A reread that brought different values replaces the form; the team member's own edits stay otherwise.
    useEffect(() => {
        if (JSON.stringify(stored.current) === JSON.stringify(role)) return;
        stored.current = role;
        setFields(fieldsOf(role));
    }, [role, setFields]);

    const call: Calling = async (action) => {
        setCalling(true);
        setFailure(undefined);
        try {
            await action();
            await reload();
        } catch (error) {
            setFailure({ error });
        } finally {
            setCalling(false);
        }
    };
    const invoke = (operation: string, input: Record<string, unknown>) => () =>
        call(async () => void (await pageClient().invoke(operation, { name: role.name, ...input })));
    const button = (label: string, className: string, onClick: () => unknown) =>
        h(
            "button",
            { type: "button", class: `button ${className}`, disabled: !connected || isCalling, onClick },
            label,
        );

    const origin = role.shipped ? (role.changed ? " (shipped, changed)" : " (shipped)") : " (team)";
    return h(
        "section",
        { class: "role", "data-role": role.name, "data-changed": String(role.changed) },
        h("h3", null, h("span", { "data-verbatim": "" }, role.name), origin),
        ...settingsFields(data, fields, set),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        button("Save", "role-save", invoke("roles.change", inputOf(fields))),
        button("Restore", "role-restore", invoke("roles.restore", {})),
        button("Remove", "button-destructive role-remove", invoke("roles.remove", {})),
    );
};

const CreateRole = ({ data, reload }: { data: Data; reload: Reload }) => {
    const connected = useContext(isConnected);
    const [name, setName] = useState("");
    const { fields, setFields, set } = useFields(fieldsOf(undefined));
    const [isCalling, setCalling] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);

    const create = async () => {
        setCalling(true);
        setFailure(undefined);
        try {
            await pageClient().invoke("roles.create", { name, ...inputOf(fields) });
            setName("");
            setFields(fieldsOf(undefined));
            await reload();
        } catch (error) {
            setFailure({ error });
        } finally {
            setCalling(false);
        }
    };

    return h(
        "section",
        { class: "role-create" },
        h("h3", null, "Create a role"),
        text("Name", "name", name, setName, true),
        ...settingsFields(data, fields, set),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        h(
            "button",
            {
                type: "button",
                class: "button role-create-submit",
                disabled: !connected || isCalling,
                onClick: create,
            },
            "Create",
        ),
    );
};

/** The roles, a form to create one, and the note that a change reaches only agents seated afterwards. */
export const RolesPage = ({ feed }: { feed: FeedConnection | null | undefined }) => {
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
        mountedReload = reload;
        if (feed !== null) attachFeed(feed);
        void reload();
        return () => {
            isClosed = true;
            if (mountedReload === reload) mountedReload = undefined;
        };
    }, [feed]);

    const reload: Reload = async () => void (await mountedReload?.());
    return h(
        "div",
        { class: "roles" },
        h(
            "p",
            { class: "roles-note" },
            "A change affects only agents seated afterwards; agents already seated keep theirs.",
        ),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        data === undefined
            ? null
            : [
                  ...data.roles.map((role) => h(RoleCard, { role, data, reload, key: role.name })),
                  h(CreateRole, { data, reload }),
              ],
    );
};
