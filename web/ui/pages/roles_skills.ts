/**
 * The parts of the Roles page that concern skills and instruction files (S-008 REQ-013): the "Skills and
 * instructions" section (the common prompt, the skill search paths, a restore button for each shipped file) and the
 * collapsed Skills panel of a role. A refusal shows next to the button or form it concerns.
 */
import { h } from "preact";
import { useContext, useState } from "preact/hooks";
import { isConnected } from "../components/connection_banner.ts";
import { FileEditor } from "../components/file_editor.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { SkillsPanel } from "../components/skills_panel.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";

type SearchPath = { path: string; ok: boolean; reason?: string };
type ShippedSkill = { name: string; edited: boolean };
type Reload = () => Promise<void>;

/** What the section shows, read with `readSkillsData`. */
export type SkillsData = {
    searchPaths: SearchPath[];
    shippedSkills: ShippedSkill[];
    commonPromptPath: string | undefined;
};

/** Any role lists the shipped skills and names the common prompt; `reader` is a shipped role when there is one. */
export const readSkillsData = async (reader: string | undefined): Promise<SkillsData> => {
    const client = pageClient();
    const searchPaths = (await client.invoke("skills.paths.list")) as SearchPath[];
    if (reader === undefined) return { searchPaths, shippedSkills: [], commonPromptPath: undefined };
    const skills = (await client.invoke("skills.list", { role: reader })) as {
        skills: (ShippedSkill & { shipped: boolean })[];
    };
    const instructions = (await client.invoke("instructions.list", { role: reader })) as {
        files: { kind: string; path: string }[];
    };
    return {
        searchPaths,
        shippedSkills: skills.skills.filter((skill) => skill.shipped).map(({ name, edited }) => ({ name, edited })),
        commonPromptPath: instructions.files.find((file) => file.kind === "common")?.path,
    };
};

/** The control that opens the Skills panel of one role, collapsed; the panel reads when it is first opened. */
export const RoleSkills = ({ role, feed }: { role: string; feed: FeedConnection | null | undefined }) => {
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
}: {
    label: string;
    className: string;
    operation: string;
    input: Record<string, unknown>;
    reload: Reload;
}) => {
    const connected = useContext(isConnected);
    const [isCalling, setCalling] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const call = async () => {
        setCalling(true);
        setFailure(undefined);
        try {
            await pageClient().invoke(operation, input);
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
            h(
                "label",
                null,
                "Folder",
                h("input", {
                    type: "text",
                    name: "searchPath",
                    value: path,
                    onInput: (event: Event) => setPath((event.target as HTMLInputElement).value),
                }),
            ),
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

export const SkillsAndInstructions = ({
    roles,
    data,
    reload,
}: {
    roles: { name: string; shipped: boolean }[];
    data: SkillsData;
    reload: Reload;
}) =>
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
            ...roles
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
