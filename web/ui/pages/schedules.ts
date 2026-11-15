/**
 * The Schedules page (S-007 REQ-012): each schedule entry with its next due time, its recent scheduled runs linked to
 * their Job pages, and its skipped fires with the reason and any open run's link. A team member adds, changes, runs and
 * removes entries here; the service owns the rules, and its refusal shows next to the form or entry it concerns. The
 * entries are read again after a `shouldRereadSchedules` delta and on each new instance snapshot; a skipped fire joins
 * its entry with `addSkip`. Roles, models and workspaces are native choices from `roles.list`, `models.list` and
 * `workspaces.list`.
 */
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { listen } from "../components/activity.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { type Choices, CreateEntry, type Entry, EntryCard } from "../components/schedule_entries.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";
import {
    addSkip,
    addSkips,
    type ScheduleCard,
    type ScheduleDelta,
    type ScheduleHistoryItem,
    type SchedulesState,
    shouldRereadSchedules,
} from "../model/schedules.ts";

type RunsItem = { kind: "run"; firedAt: string; job: { number: string } } | { kind: "skip"; skip: ScheduleSkipText };
type ScheduleSkipText = { entry: string; dueTime: string; reason: string; openRun: string | null };
type Data = { entries: Entry[]; cards: SchedulesState; choices: Choices };
type Reload = () => Promise<void>;
type Apply = (delta: ScheduleDelta) => void;

const RECENT_RUNS = 10;

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
    const models = (await client.invoke("models.list")) as Choices["models"];
    const { workspaces } = (await client.invoke("workspaces.list")) as { workspaces: { path: string }[] };
    const choices = {
        roles: roles.map((role) => role.name),
        models,
        workspaces: workspaces.map((workspace) => workspace.path),
    };
    return { entries: schedules, cards, choices };
};

/** The schedule entries, each with its next due time, recent scheduled runs and skipped fires. */
export const SchedulesPage = ({ feed }: { feed: FeedConnection | null | undefined }) => {
    const [data, setData] = useState<Data | undefined>(undefined);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);

    useEffect(() => {
        // `undefined` means the tab is still connecting: the first read waits for the feed.
        if (feed === undefined) return;
        let isClosed = false;
        // A read can straddle a skip delta, and the delta does not trigger a reread: the skips seen since the read
        // began are put back on what it returns.
        const seenSkips: ScheduleDelta[] = [];
        const reload: Reload = async () => {
            const seenBefore = seenSkips.length;
            try {
                const read = await readData();
                if (isClosed) return;
                setData({ ...read, cards: addSkips(read.cards, seenSkips.slice(seenBefore)) });
                setFailure(undefined);
            } catch (error) {
                if (!isClosed) setFailure({ error });
            }
        };
        const apply: Apply = (delta) => {
            if (delta.type === "schedule_fire_skipped") seenSkips.push(delta);
            setData((held) => (held === undefined ? held : { ...held, cards: addSkip(held.cards, delta) }));
        };
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
