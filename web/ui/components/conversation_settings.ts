/**
 * Compact, reset and change seat for a conversation of a job, in a collapsed area under Stop and Redirect (S-006
 * REQ-007). It draws the controls and any refusal; the results are entries of the feed that `activity.ts` draws. While
 * the service can't be reached every action is disabled (REQ-014).
 */
import { h } from "preact";
import { useContext, useRef, useState } from "preact/hooks";
import { pageClient } from "../feed_connection.ts";
import { isConnected } from "./connection_banner.ts";
import { RefusalMessage } from "./refusal.ts";

type Choices = { roles: string[]; models: string[]; workspaces: string[] };
type Role = { name: string };
type Model = { model: string };
type Workspace = { path: string };

const DEFAULT_CHOICE = "";
const DEFAULT_LABEL = "(the role's default)";

/** One call at a time: whether it is going, and what the service said when it refused. */
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

const readChoices = async (): Promise<Choices> => {
    const [roles, models, workspaces] = await Promise.all([
        pageClient().invoke("roles.list", {}),
        pageClient().invoke("models.list", {}),
        pageClient().invoke("workspaces.list", {}),
    ]);
    return {
        roles: (roles as { roles: Role[] }).roles.map((role) => role.name),
        models: (models as Model[]).map((each) => each.model),
        workspaces: (workspaces as { workspaces: Workspace[] }).workspaces.map((each) => each.path),
    };
};

const Select = ({
    name,
    label,
    values,
    hasDefault,
}: {
    name: string;
    label: string;
    values: string[];
    hasDefault: boolean;
}) =>
    h(
        "label",
        null,
        label,
        h(
            "select",
            { class: `seat-${name}`, name },
            hasDefault ? h("option", { value: DEFAULT_CHOICE }, DEFAULT_LABEL) : null,
            ...values.map((value) => h("option", { value, "data-verbatim": "" }, value)),
        ),
    );

/** Compaction runs at once; a reset waits for one confirmation in a native dialog. */
const Actions = ({ conversationId }: { conversationId: string }) => {
    const connected = useContext(isConnected);
    const dialog = useRef<HTMLDialogElement>(null);
    const { sending, failure, run } = useCall();
    const reset = async () => {
        dialog.current?.close();
        await run(() => pageClient().invoke("conversations.reset", { conversationId }));
    };
    return h(
        "div",
        { class: "settings-actions" },
        h(
            "button",
            {
                type: "button",
                class: "button button-secondary compact-run",
                disabled: !connected || sending,
                onClick: () => void run(() => pageClient().invoke("conversations.compact", { conversationId })),
            },
            "Compact",
        ),
        h(
            "button",
            {
                type: "button",
                class: "button button-destructive reset-open",
                disabled: !connected || sending,
                onClick: () => dialog.current?.showModal(),
            },
            "Reset",
        ),
        h(
            "dialog",
            { ref: dialog, class: "reset-dialog" },
            h("p", null, "Reset this conversation? Its earlier context is dropped."),
            h(
                "div",
                { class: "actions" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "button button-secondary reset-cancel",
                        onClick: () => dialog.current?.close(),
                    },
                    "Keep it",
                ),
                h(
                    "button",
                    {
                        type: "button",
                        class: "button button-destructive reset-confirm",
                        disabled: !connected,
                        onClick: reset,
                    },
                    "Reset",
                ),
            ),
        ),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
    );
};

/** The role, model and workspace to seat the conversation in, chosen from what the service lists. */
const SeatForm = ({ conversationId, choices }: { conversationId: string; choices: Choices }) => {
    const connected = useContext(isConnected);
    const { sending, failure, run } = useCall();
    const change = (event: Event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget as HTMLFormElement);
        const chosen = Object.fromEntries(
            (["role", "model", "workspace"] as const).flatMap((name) => {
                const value = form.get(name);
                return typeof value === "string" && value !== DEFAULT_CHOICE ? [[name, value]] : [];
            }),
        );
        void run(() => pageClient().invoke("conversations.seat", { conversationId, ...chosen }));
    };
    return h(
        "form",
        { class: "seat-form", onSubmit: change },
        h(Select, { name: "role", label: "Role", values: choices.roles, hasDefault: false }),
        h(Select, { name: "model", label: "Model", values: choices.models, hasDefault: true }),
        h(Select, { name: "workspace", label: "Workspace", values: choices.workspaces, hasDefault: true }),
        h("button", { type: "submit", class: "button seat-change", disabled: !connected || sending }, "Change seat"),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
    );
};

/** Compact, reset and change seat, collapsed. The seat's choices are read when the area is first opened. */
export const ConversationSettings = ({ conversationId }: { conversationId: string }) => {
    const [choices, setChoices] = useState<Choices | undefined>(undefined);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const isRead = useRef(false);
    const readOnFirstOpen = (event: Event) => {
        if (!(event.currentTarget as HTMLDetailsElement).open || isRead.current) return;
        isRead.current = true;
        readChoices().then(setChoices, (error) => {
            isRead.current = false;
            setFailure({ error });
        });
    };
    return h(
        "details",
        { class: "conversation-settings", onToggle: readOnFirstOpen },
        h("summary", null, "Settings"),
        h(Actions, { conversationId }),
        choices !== undefined ? h(SeatForm, { conversationId, choices }) : null,
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
    );
};
