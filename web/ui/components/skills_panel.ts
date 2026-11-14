/**
 * The Skills panel (S-008 REQ-013) of a role or a seated conversation: its skills with a check box each, and the
 * instruction files its prompt reads. Any skill file or instruction file opens in the `FileEditor`. The panel reads
 * again when the model's `panelReloadNeeded` says a feed delta concerns it. It never creates or deletes a skill folder.
 */
import { h } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import type { FeedConnection } from "../feed_connection.ts";
import { pageClient } from "../feed_connection.ts";
import {
    type InstructionFileResult,
    type InstructionRow,
    instructionRows,
    type PanelDelta,
    panelReloadNeeded,
    type SkillListResult,
    type SkillRow,
    skillRows,
} from "../model/skills.ts";
import { listen } from "./activity.ts";
import { isConnected } from "./connection_banner.ts";
import { FileEditor } from "./file_editor.ts";
import { RefusalMessage } from "./refusal.ts";

export type SkillsTarget = { role: string } | { conversation: string };

type Rows = { skills: ReturnType<typeof skillRows>; instructions: InstructionRow[] };

const SKILL_FILE = "SKILL.md";

const conversationOf = (target: SkillsTarget): string | null => ("conversation" in target ? target.conversation : null);

const readRows = async (target: SkillsTarget): Promise<Rows> => {
    const [skills, instructions] = await Promise.all([
        pageClient().invoke("skills.list", target),
        pageClient().invoke("instructions.list", target),
    ]);
    return {
        skills: skillRows(skills as SkillListResult),
        instructions: instructionRows(instructions as { files: InstructionFileResult[] }),
    };
};

const SkillItem = ({
    row,
    failure,
    onChange,
    onOpen,
}: {
    row: SkillRow;
    failure: { error: unknown } | undefined;
    onChange: (isChecked: boolean) => void;
    onOpen: () => void;
}) => {
    const connected = useContext(isConnected);
    const isDeleted = row.marks.includes("deleted");
    return h(
        "li",
        { class: "skill-row", "data-skill": row.name },
        h(
            "label",
            null,
            h("input", {
                type: "checkbox",
                checked: row.isChecked,
                disabled: !connected || !row.isChangeable,
                onChange: (event: Event) => onChange((event.target as HTMLInputElement).checked),
            }),
            h("span", { class: "skill-name", "data-verbatim": "" }, row.name),
        ),
        row.description !== "" ? h("span", { class: "skill-description", "data-verbatim": "" }, row.description) : null,
        h("span", { class: "skill-source", "data-verbatim": "" }, row.sourceText),
        ...row.marks.map((mark) => h("span", { class: "badge" }, mark)),
        ...row.shadowed.map((copy) =>
            h("div", { class: "skill-shadowed", "data-verbatim": "" }, `Shadows ${copy.sourceText}: ${copy.path}`),
        ),
        isDeleted
            ? null
            : h("button", { type: "button", class: "button button-secondary file-open", onClick: onOpen }, "Edit"),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
    );
};

/** The skills and instruction files of the role or conversation, kept current by the instance feed. */
export const SkillsPanel = ({ target, feed }: { target: SkillsTarget; feed?: FeedConnection | null | undefined }) => {
    const [rows, setRows] = useState<Rows | undefined>(undefined);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const [skillFailure, setSkillFailure] = useState<{ name: string; error: unknown } | undefined>(undefined);
    const [openPath, setOpenPath] = useState<string | undefined>(undefined);
    const [reloads, setReloads] = useState(0);
    const key = JSON.stringify(target);

    useEffect(() => {
        let isCurrent = true;
        readRows(JSON.parse(key) as SkillsTarget).then(
            (read) => {
                if (!isCurrent) return;
                setRows(read);
                setFailure(undefined);
            },
            (error) => isCurrent && setFailure({ error }),
        );
        return () => {
            isCurrent = false;
        };
    }, [key, reloads]);

    useEffect(() => {
        if (!feed) return;
        const conversation = conversationOf(JSON.parse(key) as SkillsTarget);
        return listen(feed, (event) => {
            if (event.type === "instance-snapshot") setReloads((count) => count + 1);
            else if (event.type === "instance-delta" && panelReloadNeeded(event.delta as PanelDelta, conversation)) {
                setReloads((count) => count + 1);
            }
        });
    }, [feed, key]);

    const change = async (name: string, isChecked: boolean) => {
        setSkillFailure(undefined);
        try {
            await pageClient().invoke(isChecked ? "skills.enable" : "skills.disable", { ...target, name });
        } catch (error) {
            setSkillFailure({ name, error });
        }
        setReloads((count) => count + 1);
    };

    return h(
        "div",
        { class: "skills-panel" },
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        rows !== undefined
            ? h(
                  "ul",
                  { class: "skill-rows" },
                  ...rows.skills.skills.map((row) =>
                      h(SkillItem, {
                          key: row.name,
                          row,
                          failure: skillFailure?.name === row.name ? skillFailure : undefined,
                          onChange: (isChecked) => void change(row.name, isChecked),
                          onOpen: () => setOpenPath(`${row.path}/${SKILL_FILE}`),
                      }),
                  ),
              )
            : null,
        rows !== undefined && rows.skills.missing.length > 0
            ? h("p", { class: "skills-missing" }, `Not found: ${rows.skills.missing.join(", ")}`)
            : null,
        rows !== undefined && rows.skills.leftOut.length > 0
            ? h(
                  "ul",
                  { class: "skills-left-out" },
                  ...rows.skills.leftOut.map(({ path, reason }) =>
                      h("li", { key: path, "data-verbatim": "" }, `Left out ${path}: ${reason}`),
                  ),
              )
            : null,
        rows !== undefined
            ? h(
                  "ul",
                  { class: "instruction-rows" },
                  ...rows.instructions.map((row) =>
                      h(
                          "li",
                          { class: "instruction-row", "data-kind": row.kind, key: row.path },
                          h("span", { class: "instruction-path", "data-verbatim": "" }, row.path),
                          ...row.marks.map((mark) => h("span", { class: "badge" }, mark)),
                          h(
                              "button",
                              {
                                  type: "button",
                                  class: "button button-secondary file-open",
                                  onClick: () => setOpenPath(row.path),
                              },
                              "Edit",
                          ),
                      ),
                  ),
              )
            : null,
        openPath !== undefined
            ? h(FileEditor, { key: openPath, path: openPath, onClose: () => setOpenPath(undefined) })
            : null,
    );
};

/** The control that opens the panel of one conversation, collapsed; the panel reads when it is first opened. */
export const ConversationSkills = ({
    conversationId,
    feed,
}: {
    conversationId: string;
    feed: FeedConnection | null | undefined;
}) => {
    const [isOpen, setOpen] = useState(false);
    return h(
        "details",
        {
            class: "conversation-skills",
            onToggle: (event: Event) => setOpen((event.currentTarget as HTMLDetailsElement).open),
        },
        h("summary", null, "Skills"),
        isOpen ? h(SkillsPanel, { target: { conversation: conversationId }, feed }) : null,
    );
};
