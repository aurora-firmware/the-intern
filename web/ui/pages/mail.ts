/**
 * The Mail page (S-009 REQ-018): each mail account with its name, address, kind, status, last error and last check,
 * and the notice address with its sending account. A team member adds, changes, tests, signs in and removes accounts
 * here and sets or clears the notice settings; the service owns the rules, and its refusal shows next to the form or
 * account it concerns. The accounts and the notice are read again after a mail `settings_changed` delta and on each
 * new instance snapshot; a `mail_account_status` delta sets one account's status without a read. A secret field
 * starts empty, is never filled from the service and is emptied after each call. A refusal of a read shows on the
 * page; a lost connection is the banner's to show.
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
import { AccountCard, CreateAccount, NoticeSettings } from "./mail_cards.ts";
import type { Reload } from "./mail_form.ts";

type Apply = (delta: MailStatusDelta) => void;
type Data = { state: MailState; roles: string[] };

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

const readData = async (): Promise<Data> => {
    const client = pageClient();
    const { accounts } = (await client.invoke("mail.accounts.list")) as { accounts: MailAccountView[] };
    const { notice } = (await client.invoke("mail.notices.get")) as { notice: MailNoticeView };
    const { roles } = (await client.invoke("roles.list")) as { roles: { name: string }[] };
    return { state: { accounts, notice }, roles: roles.map((role) => role.name) };
};

/** The mail accounts with their live status and actions, and the notice settings. */
export const MailPage = ({ feed }: { feed: FeedConnection | null | undefined }) => {
    const [data, setData] = useState<Data | undefined>(undefined);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const [result, setResult] = useState<string | undefined>(undefined);

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
                const read = await readData();
                if (isClosed || thisRead !== latestRead) return;
                setData({ ...read, state: seenStatuses.slice(seenBefore).reduce(applyStatusDelta, read.state) });
                setFailure(undefined);
            } catch (error) {
                if (!isClosed && thisRead === latestRead) setFailure({ error });
            }
        };
        const apply: Apply = (delta) => {
            seenStatuses.push(delta);
            setData((held) => (held === undefined ? held : { ...held, state: applyStatusDelta(held.state, delta) }));
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
        { class: "mail" },
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        result === undefined ? null : h("p", { class: "mail-result", role: "status" }, result),
        data === undefined
            ? null
            : [
                  h(NoticeSettings, {
                      notice: data.state.notice,
                      accounts: data.state.accounts,
                      reload,
                      report: setResult,
                  }),
                  ...data.state.accounts.map((account) =>
                      h(AccountCard, { account, roles: data.roles, reload, report: setResult, key: account.name }),
                  ),
                  h(CreateAccount, { roles: data.roles, reload, report: setResult }),
              ],
    );
};
