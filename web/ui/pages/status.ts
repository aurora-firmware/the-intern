/**
 * The Status page (S-006 REQ-011): the daemon's state as `daemon.status` reports it, the usage in total and per
 * conversation (`usage.get`, `conversations.list`), and the available models and thinking levels (`models.list`).
 * Status and usage are read again after each instance delta, at most once a second, and the models after a
 * `settings_changed` delta. Each new instance snapshot reads all of them again.
 */
import { type ComponentChild, h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { listen } from "../components/activity.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";
import { throttled } from "../model/throttle.ts";

const REFRESH_INTERVAL_MS = 1000;

type Totals = { input: number; output: number; totalTokens: number; cost: { total: number } };
type UsageReport = { models: Record<string, Totals>; tools: Record<string, Totals> };
type Status = {
    phase: string;
    startedAt: string;
    versions: { intern: string; pi: string };
    instance: { configDir: string; stateDir: string; dataDir: string; runtimeDir: string };
    workerThreads: { count: number; inUse: number; waiting: unknown[] };
};
type ModelSummary = { model: string; thinkingLevels: string[] };
type Usage = { total: UsageReport; conversations: { id: string; report: UsageReport }[] };
type Refresh = { readState: () => void; readModels: () => void; readAll: () => void };

// A feed connection has no way to remove a listener, so it gets one that speaks to the mounted page.
let mountedRefresh: Refresh | undefined;
const attachedFeeds = new WeakSet<FeedConnection>();

const attachFeed = (feed: FeedConnection) => {
    if (attachedFeeds.has(feed)) return;
    attachedFeeds.add(feed);
    feed.onInstanceSnapshot(() => mountedRefresh?.readAll());
    listen(feed, (event) => {
        if (event.type !== "instance-delta") return;
        mountedRefresh?.readState();
        if ((event.delta as { type?: string }).type === "settings_changed") mountedRefresh?.readModels();
    });
};

const readStatus = async (): Promise<Status> => (await pageClient().invoke("daemon.status")) as Status;

const readUsage = async (): Promise<Usage> => {
    const client = pageClient();
    const total = (await client.invoke("usage.get", {})) as UsageReport;
    const listed = (await client.invoke("conversations.list", {})) as { id: string }[];
    const conversations = await Promise.all(
        listed.map(async ({ id }) => ({
            id,
            report: (await client.invoke("usage.get", { conversationId: id })) as UsageReport,
        })),
    );
    return { total, conversations };
};

const readModels = async (): Promise<ModelSummary[]> =>
    (await pageClient().invoke("models.list", {})) as ModelSummary[];

const field = (label: string, name: string, value: string | number) =>
    h("div", null, h("dt", null, label), h("dd", { "data-field": name }, String(value)));

const StatusSection = ({ status }: { status: Status }) =>
    h(
        "section",
        { class: "status-daemon" },
        h("h3", null, "Daemon"),
        h(
            "dl",
            null,
            field("Phase", "phase", status.phase),
            field("Started", "startedAt", status.startedAt),
            field("The Intern", "intern", status.versions.intern),
            field("pi", "pi", status.versions.pi),
            field("Config directory", "configDir", status.instance.configDir),
            field("State directory", "stateDir", status.instance.stateDir),
            field("Data directory", "dataDir", status.instance.dataDir),
            field("Runtime directory", "runtimeDir", status.instance.runtimeDir),
            field("Worker threads", "workerThreadCount", status.workerThreads.count),
            field("Worker threads in use", "workerThreadsInUse", status.workerThreads.inUse),
            field("Worker threads waiting", "workerThreadsWaiting", status.workerThreads.waiting.length),
        ),
    );

const usageRows = (kind: "model" | "tool", bucket: Record<string, Totals>) =>
    Object.entries(bucket).map(([name, totals]) =>
        h(
            "li",
            { class: "usage-row", "data-kind": kind, "data-name": name, "data-total-tokens": totals.totalTokens },
            `${kind} ${name}: ${totals.input} in, ${totals.output} out, ${totals.totalTokens} tokens, cost ${totals.cost.total}`,
        ),
    );

const UsageBlock = ({
    heading,
    report,
    className,
    conversationId,
}: {
    heading: string;
    report: UsageReport;
    className: string;
    conversationId?: string;
}) => {
    const rows = [...usageRows("model", report.models), ...usageRows("tool", report.tools)];
    return h(
        "section",
        { class: `status-usage ${className}`, "data-conversation": conversationId },
        h("h4", null, heading),
        rows.length === 0 ? h("p", null, "No usage yet") : h("ul", null, rows),
    );
};

const UsageSection = ({ usage }: { usage: Usage }) =>
    h(
        "section",
        { class: "status-usage-section" },
        h("h3", null, "Usage"),
        h(UsageBlock, { heading: "Total", report: usage.total, className: "status-usage-total" }),
        usage.conversations.map(({ id, report }) =>
            h(UsageBlock, {
                heading: `Conversation ${id}`,
                report,
                className: "status-usage-conversation",
                conversationId: id,
                key: id,
            }),
        ),
    );

const ModelsSection = ({ models }: { models: ModelSummary[] }) =>
    h(
        "section",
        { class: "status-models" },
        h("h3", null, "Models"),
        h(
            "ul",
            null,
            models.map(({ model, thinkingLevels }) =>
                h(
                    "li",
                    { class: "status-model", "data-model": model, key: model },
                    h("code", null, model),
                    " ",
                    h("span", { class: "status-model-levels" }, thinkingLevels.join(", ")),
                ),
            ),
        ),
    );

/** The daemon's state, the usage and the models, kept current. */
export const StatusPage = ({ feed }: { feed: FeedConnection | null | undefined }) => {
    const [status, setStatus] = useState<Status | undefined>(undefined);
    const [usage, setUsage] = useState<Usage | undefined>(undefined);
    const [models, setModels] = useState<ModelSummary[] | undefined>(undefined);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);

    useEffect(() => {
        // `undefined` means the tab is still connecting: the first read waits for the feed.
        if (feed === undefined) return;
        let isClosed = false;
        const load =
            <T>(read: () => Promise<T>, show: (value: T) => void) =>
            async () => {
                try {
                    const value = await read();
                    if (isClosed) return;
                    show(value);
                    setFailure(undefined);
                } catch (error) {
                    if (!isClosed) setFailure({ error });
                }
            };
        const loadStatus = load(readStatus, setStatus);
        const loadUsage = load(readUsage, setUsage);
        const loadModels = load(readModels, setModels);
        const readState = throttled(() => void Promise.all([loadStatus(), loadUsage()]), REFRESH_INTERVAL_MS);
        const refresh: Refresh = {
            readState,
            readModels: () => void loadModels(),
            readAll: () => void Promise.all([loadStatus(), loadUsage(), loadModels()]),
        };
        mountedRefresh = refresh;
        if (feed !== null) attachFeed(feed);
        refresh.readAll();
        return () => {
            isClosed = true;
            if (mountedRefresh === refresh) mountedRefresh = undefined;
        };
    }, [feed]);

    const parts: ComponentChild[] = [
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        status === undefined ? null : h(StatusSection, { status }),
        usage === undefined ? null : h(UsageSection, { usage }),
        models === undefined ? null : h(ModelsSection, { models }),
    ];
    return h("div", { class: "status" }, ...parts);
};
