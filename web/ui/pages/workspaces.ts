/**
 * The Workspaces page (S-006 REQ-010): the registered workspaces, a form that registers one and a button that
 * unregisters one (S-001 REQ-018). The service decides and a refusal shows next to the action that made it. The list
 * is read again after a `settings_changed` delta and on each new instance snapshot.
 */
import { h } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { listen } from "../components/activity.ts";
import { isConnected } from "../components/connection_banner.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";

type Workspace = { path: string; kind: "registered" | "role_default"; role?: string };
type Reload = () => Promise<void>;

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

const readWorkspaces = async (): Promise<Workspace[]> => {
    const { workspaces } = (await pageClient().invoke("workspaces.list")) as { workspaces: Workspace[] };
    return workspaces;
};

/** Runs a call, shows its refusal, and reads the list again once it is done. */
const useCall = (reload: Reload) => {
    const [isCalling, setCalling] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const call = async (action: () => Promise<void>) => {
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
    return { isCalling, failure, call };
};

const WorkspaceRow = ({ workspace, reload }: { workspace: Workspace; reload: Reload }) => {
    const connected = useContext(isConnected);
    const { isCalling, failure, call } = useCall(reload);
    const unregister = () => call(async () => void (await pageClient().invoke("workspaces.unregister", workspace)));
    return h(
        "li",
        { class: "workspace", "data-path": workspace.path, "data-kind": workspace.kind },
        h("code", null, workspace.path),
        workspace.kind === "role_default" ? ` (default of the ${workspace.role} role)` : null,
        workspace.kind === "registered"
            ? h(
                  "button",
                  {
                      type: "button",
                      class: "button button-destructive workspace-unregister",
                      disabled: !connected || isCalling,
                      onClick: unregister,
                  },
                  "Unregister",
              )
            : null,
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
    );
};

const RegisterWorkspace = ({ reload }: { reload: Reload }) => {
    const connected = useContext(isConnected);
    const [path, setPath] = useState("");
    const { isCalling, failure, call } = useCall(reload);
    const register = () =>
        call(async () => {
            await pageClient().invoke("workspaces.register", { path });
            setPath("");
        });
    return h(
        "section",
        { class: "workspace-register" },
        h("h3", null, "Register a workspace"),
        h(
            "label",
            null,
            "Absolute path of an existing directory",
            h("input", {
                type: "text",
                name: "path",
                value: path,
                onInput: (event: Event) => setPath((event.target as HTMLInputElement).value),
            }),
        ),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        h(
            "button",
            {
                type: "button",
                class: "button workspace-register-submit",
                disabled: !connected || isCalling,
                onClick: register,
            },
            "Register",
        ),
    );
};

/** The workspaces, and a form to register one. */
export const WorkspacesPage = ({ feed }: { feed: FeedConnection | null | undefined }) => {
    const [workspaces, setWorkspaces] = useState<Workspace[] | undefined>(undefined);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);

    useEffect(() => {
        // `undefined` means the tab is still connecting: the first read waits for the feed.
        if (feed === undefined) return;
        let isClosed = false;
        const reload: Reload = async () => {
            try {
                const read = await readWorkspaces();
                if (isClosed) return;
                setWorkspaces(read);
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
        { class: "workspaces" },
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        workspaces === undefined
            ? null
            : h(
                  "ul",
                  { class: "workspace-list" },
                  workspaces.map((workspace) => h(WorkspaceRow, { workspace, reload, key: workspace.path })),
              ),
        h(RegisterWorkspace, { reload }),
    );
};
