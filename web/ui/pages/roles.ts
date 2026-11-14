/**
 * The Roles page (S-006 REQ-009): every role with its settings, a form that creates a role, and for each role Save,
 * Restore and Remove. The service decides what is allowed (S-001 REQ-003) and a refusal shows next to the role it
 * concerns. Each role opens its Skills panel. The "Skills and instructions" section edits the common prompt, lists the
 * skill search paths with add and remove, and restores each shipped file. The list is read again after a
 * `settings_changed` or `files_changed` delta and on each new instance snapshot. Models and workspaces are native
 * choices from `models.list` and `workspaces.list`.
 */
import { h } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { listen } from "../components/activity.ts";
import { isConnected } from "../components/connection_banner.ts";
import { FileEditor } from "../components/file_editor.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { SkillsPanel } from "../components/skills_panel.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";

type Role = {
    name: string;
    instructions?: string;
    instructionsVersion?: string;
    instructionsMissing?: true;
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
type SearchPath = { path: string; ok: boolean; reason?: string };
type ShippedSkill = { name: string; edited: boolean };
type Data = {
    roles: Role[];
    models: Model[];
    workspaces: Workspace[];
    searchPaths: SearchPath[];
    shippedSkills: ShippedSkill[];
    commonPromptPath: string | undefined;
};
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
        const deltaType = event.type === "instance-delta" ? (event.delta as { type?: string }).type : undefined;
        if (deltaType === "settings_changed" || deltaType === "files_changed") void mountedReload?.();
    });
};

const readData = async (): Promise<Data> => {
    const client = pageClient();
    const { roles } = (await client.invoke("roles.list")) as { roles: Role[] };
    const models = (await client.invoke("models.list")) as Model[];
    const { workspaces } = (await client.invoke("workspaces.list")) as { workspaces: Workspace[] };
    const searchPaths = (await client.invoke("skills.paths.list")) as SearchPath[];
    // Any role lists the shipped skills and names the common prompt; the shipped roles are always there.
    const reader = roles.find((role) => role.shipped)?.name ?? roles[0]?.name;
    if (reader === undefined)
        return { roles, models, workspaces, searchPaths, shippedSkills: [], commonPromptPath: undefined };
    const skills = (await client.invoke("skills.list", { role: reader })) as {
        skills: (ShippedSkill & { shipped: boolean })[];
    };
    const instructions = (await client.invoke("instructions.list", { role: reader })) as {
        files: { kind: string; path: string }[];
    };
    return {
        roles,
        models,
        workspaces,
        searchPaths,
        shippedSkills: skills.skills.filter((skill) => skill.shipped).map(({ name, edited }) => ({ name, edited })),
        commonPromptPath: instructions.files.find((file) => file.kind === "common")?.path,
    };
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
    ...settingsOf(fields),
});

/** A change sends the instructions only when they differ, with the token of the file as the page read it. */
const changeOf = (fields: Fields, role: Role): Record<string, unknown> => {
    const { instructions, ...rest } = inputOf(fields);
    if (instructions === (role.instructions ?? "")) return rest;
    return {
        instructions,
        ...(role.instructionsVersion === undefined ? {} : { instructionsVersion: role.instructionsVersion }),
        ...rest,
    };
};

const settingsOf = (fields: Fields): Record<string, unknown> => ({
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
    text("Skills (names, one per line)", "skills", fields.skills, set("skills")),
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

const RoleCard = ({
    role,
    data,
    reload,
    feed,
}: {
    role: Role;
    data: Data;
    reload: Reload;
    feed: FeedConnection | null | undefined;
}) => {
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
        role.instructionsMissing === true
            ? h(
                  "p",
                  { class: "instructions-missing" },
                  "This role's instruction file is missing. Saving instructions writes it again.",
              )
            : null,
        ...settingsFields(data, fields, set),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        button("Save", "role-save", invoke("roles.change", changeOf(fields, role))),
        button("Restore", "role-restore", invoke("roles.restore", {})),
        button("Remove", "button-destructive role-remove", invoke("roles.remove", {})),
        h(RoleSkills, { role: role.name, feed }),
    );
};

/** The control that opens the Skills panel of one role, collapsed; the panel reads when it is first opened. */
const RoleSkills = ({ role, feed }: { role: string; feed: FeedConnection | null | undefined }) => {
    const [isOpen, setOpen] = useState(false);
    return h(
        "details",
        {
            class: "role-skills",
            onToggle: (event: Event) => setOpen((event.currentTarget as HTMLDetailsElement).open),
        },
        h("summary", null, "Skills"),
        isOpen ? h(SkillsPanel, { target: { role }, feed }) : null,
    );
};

/** A button that calls one operation, reads the page again and shows a refusal next to itself. */
const ActionButton = ({
    label,
    className,
    operation,
    input,
    reload,
    onDone,
}: {
    label: string;
    className: string;
    operation: string;
    input: Record<string, unknown>;
    reload: Reload;
    onDone?: () => void;
}) => {
    const connected = useContext(isConnected);
    const [isCalling, setCalling] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const call = async () => {
        setCalling(true);
        setFailure(undefined);
        try {
            await pageClient().invoke(operation, input);
            onDone?.();
            await reload();
        } catch (error) {
            setFailure({ error });
        } finally {
            setCalling(false);
        }
    };
    return [
        h(
            "button",
            {
                type: "button",
                class: `button button-secondary ${className}`,
                disabled: !connected || isCalling,
                onClick: () => void call(),
            },
            label,
        ),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
    ];
};

const CommonPrompt = ({ path, reload }: { path: string | undefined; reload: Reload }) => {
    const [isOpen, setOpen] = useState(false);
    return h(
        "div",
        { class: "common-prompt" },
        h("h4", null, "Common prompt"),
        path === undefined
            ? null
            : h(
                  "button",
                  { type: "button", class: "button button-secondary file-open", onClick: () => setOpen(true) },
                  "Edit",
              ),
        h(ActionButton, {
            label: "Restore",
            className: "restore-common",
            operation: "instructions.restore",
            input: { name: "common" },
            reload,
        }),
        isOpen && path !== undefined ? h(FileEditor, { path, onClose: () => setOpen(false) }) : null,
    );
};

const SearchPaths = ({ paths, reload }: { paths: SearchPath[]; reload: Reload }) => {
    const connected = useContext(isConnected);
    const [path, setPath] = useState("");
    const [isCalling, setCalling] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const add = async () => {
        setCalling(true);
        setFailure(undefined);
        try {
            await pageClient().invoke("skills.paths.add", { path });
            setPath("");
            await reload();
        } catch (error) {
            setFailure({ error });
        } finally {
            setCalling(false);
        }
    };
    return h(
        "div",
        { class: "search-paths" },
        h("h4", null, "Skill search paths"),
        h(
            "ul",
            null,
            ...paths.map((entry) =>
                h(
                    "li",
                    { class: "search-path", "data-path": entry.path, key: entry.path },
                    h("span", { "data-verbatim": "" }, entry.path),
                    entry.ok ? null : h("span", { class: "badge" }, `unusable: ${entry.reason ?? ""}`),
                    h(ActionButton, {
                        label: "Remove",
                        className: "search-path-remove",
                        operation: "skills.paths.remove",
                        input: { path: entry.path },
                        reload,
                    }),
                ),
            ),
        ),
        h(
            "div",
            { class: "search-paths-form" },
            text("Folder", "searchPath", path, setPath, true),
            h(
                "button",
                {
                    type: "button",
                    class: "button search-path-add",
                    disabled: !connected || isCalling,
                    onClick: () => void add(),
                },
                "Add",
            ),
            failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        ),
    );
};

const SkillsAndInstructions = ({ data, reload }: { data: Data; reload: Reload }) =>
    h(
        "section",
        { class: "skills-instructions" },
        h("h3", null, "Skills and instructions"),
        h(CommonPrompt, { path: data.commonPromptPath, reload }),
        h(SearchPaths, { paths: data.searchPaths, reload }),
        h(
            "div",
            { class: "restore-roles" },
            h("h4", null, "Shipped role instructions"),
            ...data.roles
                .filter((role) => role.shipped)
                .map((role) =>
                    h(
                        "div",
                        { class: "restore-role", "data-role": role.name, key: role.name },
                        h("span", { "data-verbatim": "" }, role.name),
                        h(ActionButton, {
                            label: "Restore",
                            className: "restore-role-instructions",
                            operation: "instructions.restore",
                            input: { name: role.name },
                            reload,
                        }),
                    ),
                ),
        ),
        h(
            "div",
            { class: "restore-skills" },
            h("h4", null, "Shipped skills"),
            ...data.shippedSkills.map((skill) =>
                h(
                    "div",
                    {
                        class: "shipped-skill",
                        "data-skill": skill.name,
                        "data-edited": String(skill.edited),
                        key: skill.name,
                    },
                    h("span", { "data-verbatim": "" }, skill.name),
                    skill.edited ? h("span", { class: "badge" }, "edited") : null,
                    h(ActionButton, {
                        label: "Restore",
                        className: "skill-restore",
                        operation: "skills.restore",
                        input: { name: skill.name },
                        reload,
                    }),
                ),
            ),
        ),
    );

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
            "A change to a role's tools, default skills, default model, thinking level or workspace affects only agents seated afterwards. A change to its instructions reaches running agents from their next model request.",
        ),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        data === undefined
            ? null
            : [
                  ...data.roles.map((role) => h(RoleCard, { role, data, reload, feed, key: role.name })),
                  h(CreateRole, { data, reload }),
                  h(SkillsAndInstructions, { data, reload }),
              ],
    );
};
