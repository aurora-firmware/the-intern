/**
 * The editor of one instruction file, skill file or workspace file (S-008 REQ-013). It reads the file with `files.read`,
 * keeps the version token and saves with `files.write`. A refused save shows the reason and keeps what the team member
 * typed; after a `conflict` it also offers the text now on disk. It never creates or deletes a file.
 */
import { h } from "preact";
import { useContext, useEffect, useState } from "preact/hooks";
import { ClientError } from "../client/client.ts";
import { pageClient } from "../feed_connection.ts";
import { isConnected } from "./connection_banner.ts";
import { RefusalMessage } from "./refusal.ts";

type FileText = { text: string; version: string };

type EditorState = {
    isReading: boolean;
    text: string;
    version: string | undefined;
    failure: { error: unknown } | undefined;
};

const readFile = async (path: string): Promise<FileText> =>
    (await pageClient().invoke("files.read", { path })) as FileText;

const isConflict = (failure: { error: unknown } | undefined): boolean =>
    failure !== undefined && failure.error instanceof ClientError && failure.error.code === "conflict";

/** The editor for the file at `path`; `onClose` is called when the team member closes it. */
export const FileEditor = ({ path, onClose }: { path: string; onClose: () => void }) => {
    const connected = useContext(isConnected);
    const [state, setState] = useState<EditorState>({
        isReading: true,
        text: "",
        version: undefined,
        failure: undefined,
    });
    const [isSending, setSending] = useState(false);

    useEffect(() => {
        let isCurrent = true;
        setState({ isReading: true, text: "", version: undefined, failure: undefined });
        readFile(path).then(
            ({ text, version }) => isCurrent && setState({ isReading: false, text, version, failure: undefined }),
            (error) => isCurrent && setState({ isReading: false, text: "", version: undefined, failure: { error } }),
        );
        return () => {
            isCurrent = false;
        };
    }, [path]);

    const save = async () => {
        if (state.version === undefined) return;
        setSending(true);
        try {
            const written = (await pageClient().invoke("files.write", {
                path,
                text: state.text,
                version: state.version,
            })) as { version: string };
            setState((held) => ({ ...held, version: written.version, failure: undefined }));
        } catch (error) {
            setState((held) => ({ ...held, failure: { error } }));
        } finally {
            setSending(false);
        }
    };

    const useDiskText = async () => {
        try {
            const { text, version } = await readFile(path);
            setState({ isReading: false, text, version, failure: undefined });
        } catch (error) {
            setState((held) => ({ ...held, failure: { error } }));
        }
    };

    return h(
        "div",
        { class: "file-editor", "data-path": path },
        h("div", { class: "file-path", "data-verbatim": "" }, path),
        state.version !== undefined
            ? h("textarea", {
                  value: state.text,
                  onInput: (event: Event) => {
                      const typed = (event.target as HTMLTextAreaElement).value;
                      setState((held) => ({ ...held, text: typed }));
                  },
              })
            : null,
        state.failure !== undefined ? h(RefusalMessage, { error: state.failure.error }) : null,
        h(
            "div",
            { class: "actions" },
            h(
                "button",
                {
                    type: "button",
                    class: "button file-save",
                    disabled: !connected || isSending || state.version === undefined,
                    onClick: () => void save(),
                },
                "Save",
            ),
            isConflict(state.failure)
                ? h(
                      "button",
                      {
                          type: "button",
                          class: "button button-secondary file-use-disk",
                          disabled: !connected,
                          onClick: () => void useDiskText(),
                      },
                      "Use the text from disk",
                  )
                : null,
            h("button", { type: "button", class: "button button-secondary file-close", onClick: onClose }, "Close"),
        ),
    );
};
