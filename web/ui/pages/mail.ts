/**
 * The Mail page (S-009 REQ-018): each mail account with its name, address, kind, status, last error and last check,
 * and the notice address with its sending account. The accounts and the notice are read again after a mail
 * `settings_changed` delta and on each new instance snapshot; a `mail_account_status` delta sets one account's status
 * without a read. A refusal of a read shows on the page; a lost connection is the banner's to show.
 */
import { h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { listen } from "../components/activity.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";
import {
    applyStatusDelta,
    type MailAccountView,
    type MailDelta,
    type MailNoticeView,
    type MailState,
    type MailStatusDelta,
    needsReload,
} from "../model/mail.ts";

type Reload = () => Promise<void>;
type Apply = (delta: MailStatusDelta) => void;

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
        const delta = event.delta as MailDelta;
        if (needsReload(delta)) void mountedReload?.();
        if (delta.type === "mail_account_status") mountedApply?.(delta as MailStatusDelta);
    });
};

const readState = async (): Promise<MailState> => {
    const client = pageClient();
    const { accounts } = (await client.invoke("mail.accounts.list")) as { accounts: MailAccountView[] };
    const { notice } = (await client.invoke("mail.notices.get")) as { notice: MailNoticeView };
    return { accounts, notice };
};

const NOT_SET = "Not set";

const field = (className: string, label: string, value: string) =>
    h("div", null, h("dt", null, label), h("dd", { class: className }, value));

const AccountCard = ({ account }: { account: MailAccountView }) =>
    h(
        "section",
        { class: "card mail-account", "data-account": account.name },
        h("h3", null, account.name),
        h(
            "dl",
            null,
            field("mail-address", "Address", account.address),
            field("mail-kind", "Kind", account.kind),
            field("mail-status", "Status", account.status),
            field("mail-error", "Last error", account.lastError?.message ?? ""),
            field("mail-checked", "Last check", account.lastCheck ?? ""),
        ),
    );

const NoticeSettings = ({ notice }: { notice: MailNoticeView }) =>
    h(
        "section",
        { class: "card mail-notice" },
        h("h3", null, "Notice mail"),
        h(
            "dl",
            null,
            field("mail-notice-to", "Notice address", notice.to ?? NOT_SET),
            field("mail-notice-from", "Sending account", notice.from ?? NOT_SET),
        ),
    );

/** The mail accounts with their live status, and the notice settings. */
export const MailPage = ({ feed }: { feed: FeedConnection | null | undefined }) => {
    const [state, setState] = useState<MailState | undefined>(undefined);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);

    useEffect(() => {
        // `undefined` means the tab is still connecting: the first read waits for the feed.
        if (feed === undefined) return;
        let isClosed = false;
        // The status deltas seen since a read began are put back on what it returns, as a read can straddle one.
        const seenStatuses: MailStatusDelta[] = [];
        // Reads overlap and finish in any order: only the one that started last may show what it read.
        let latestRead = 0;
        const reload: Reload = async () => {
            const thisRead = ++latestRead;
            const seenBefore = seenStatuses.length;
            try {
                const read = await readState();
                if (isClosed || thisRead !== latestRead) return;
                setState(seenStatuses.slice(seenBefore).reduce(applyStatusDelta, read));
                setFailure(undefined);
            } catch (error) {
                if (!isClosed && thisRead === latestRead) setFailure({ error });
            }
        };
        const apply: Apply = (delta) => {
            seenStatuses.push(delta);
            setState((held) => (held === undefined ? held : applyStatusDelta(held, delta)));
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

    return h(
        "div",
        { class: "mail" },
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        state === undefined
            ? null
            : [
                  h(NoticeSettings, { notice: state.notice }),
                  ...state.accounts.map((account) => h(AccountCard, { account, key: account.name })),
              ],
    );
};
