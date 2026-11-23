import { h } from "preact";
import { useContext, useRef, useState } from "preact/hooks";
import { isConnected } from "./connection_banner.ts";
import { RefusalMessage } from "./refusal.ts";

const EXPORT_PATH = "/export";
const GENERAL_ERROR = "The export could not be made. Check the daemon's log, then try again.";

/** The refusal's `message` from the text the frame loaded; a text that doesn't parse, such as an error page, gives none. */
const refusalMessageOf = (text: string | null | undefined): string => {
    try {
        const message = (JSON.parse(text ?? "") as { error?: { message?: unknown } }).error?.message;
        return typeof message === "string" ? message : GENERAL_ERROR;
    } catch {
        return GENERAL_ERROR;
    }
};

/**
 * The export download (S-006 REQ-012): one confirmation in a native dialog, then a hidden same-origin frame at
 * `/export`, so the browser's download manager writes the file and the page holds none of it. A refusal has no
 * `Content-Disposition`, so the frame loads it and fires `load`; a download fires nothing, and the page can't know
 * whether it finished.
 */
export const ExportDownload = () => {
    const connected = useContext(isConnected);
    const dialog = useRef<HTMLDialogElement>(null);
    const [attempt, setAttempt] = useState(0);
    const [failure, setFailure] = useState<string | undefined>(undefined);

    const start = () => {
        dialog.current?.close();
        setFailure(undefined);
        setAttempt(attempt + 1);
    };
    const onFrameLoad = (event: Event) => {
        const frame = event.currentTarget as HTMLIFrameElement;
        setFailure(refusalMessageOf(frame.contentDocument?.body?.textContent));
    };

    return h(
        "section",
        { class: "export-download" },
        h("h3", null, "Export"),
        h(
            "button",
            {
                type: "button",
                class: "button export-open",
                disabled: !connected,
                onClick: () => dialog.current?.showModal(),
            },
            "Download a copy",
        ),
        h(
            "dialog",
            { ref: dialog, class: "export-dialog" },
            h(
                "p",
                null,
                "The file holds every conversation and the whole job record. Settings (the configuration file) aren't in it. Anyone who can reach this page can take it.",
            ),
            h(
                "div",
                { class: "actions" },
                h(
                    "button",
                    {
                        type: "button",
                        class: "button button-secondary export-cancel",
                        onClick: () => dialog.current?.close(),
                    },
                    "Cancel",
                ),
                h(
                    "button",
                    { type: "button", class: "button export-confirm", disabled: !connected, onClick: start },
                    "Download",
                ),
            ),
        ),
        failure !== undefined ? h(RefusalMessage, { error: new Error(failure) }) : null,
        attempt > 0 && failure === undefined
            ? h(
                  "p",
                  { class: "export-notice" },
                  "The copy is being made, and your browser will show the download. Only a finished download is a good backup.",
              )
            : null,
        attempt > 0
            ? h("iframe", {
                  key: attempt,
                  src: EXPORT_PATH,
                  hidden: true,
                  title: "Export download",
                  onLoad: onFrameLoad,
              })
            : null,
    );
};
