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
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { listen } from "../components/activity.ts";
import { isConnected } from "../components/connection_banner.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { type FeedConnection, pageClient } from "../feed_connection.ts";
import {
    applyStatusDelta,
    changeInput,
    clearSecret,
    createInput,
    emptyForm,
    fieldsFor,
    formFor,
    type MailAccountView,
    type MailDelta,
    type MailForm,
    type MailNoticeView,
    type MailState,
    type MailStatusDelta,
    needsReload,
} from "../model/mail.ts";

type Reload = () => Promise<void>;
type Apply = (delta: MailStatusDelta) => void;
type Report = (text: string) => void;
type Setter = (name: keyof MailForm) => (value: string) => void;
type Data = { state: MailState; roles: string[] };
type ServerCheck = { ok: boolean; message?: string };
type TestResult = { imap: ServerCheck; smtp?: ServerCheck };
type SignInStart =
    | { kind: "device_code"; code: string; address: string }
    | { kind: "browser"; address: string; port: number };

const AUTHS = ["password", "password_command", "google", "microsoft", "microsoft_app"];
const SECURITIES = ["tls", "starttls", "none"];
const KINDS = ["owned", "monitored"];
const NOT_SET = "Not set";
const DEFAULT = "";
const SECRET_LABELS: Record<string, string> = { password: "Password", clientSecret: "Client secret" };
const FIELD_LABELS: Record<string, string> = {
    ...SECRET_LABELS,
    passwordCommand: "Password command (one part per line)",
    clientId: "Client ID",
    tenant: "Tenant",
};

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

/** One action at a time: whether it is going, and what the service said when it refused. */
const useCall = () => {
    const [isCalling, setCalling] = useState(false);
    const [failure, setFailure] = useState<{ error: unknown } | undefined>(undefined);
    const call = async (action: () => Promise<void>) => {
        setCalling(true);
        setFailure(undefined);
        try {
            await action();
        } catch (error) {
            setFailure({ error });
        } finally {
            setCalling(false);
        }
    };
    return { isCalling, failure, call };
};

const useForm = (initial: MailForm) => {
    const [form, setForm] = useState(initial);
    const set: Setter = (name) => (value) => setForm((held) => ({ ...held, [name]: value }));
    return { form, setForm, set };
};

const textBox = (label: string, name: string, value: string, onChange: (value: string) => void, type = "text") =>
    h(
        "label",
        null,
        label,
        h(type === "area" ? "textarea" : "input", {
            name,
            value,
            ...(type === "area" ? { rows: 3 } : { type, autocomplete: "off" }),
            onInput: (event: Event) => onChange((event.target as HTMLInputElement).value),
        }),
    );

const selectBox = (
    label: string,
    name: string,
    value: string,
    options: readonly string[],
    onChange: (value: string) => void,
    emptyLabel: string | null = "Default",
) =>
    h(
        "label",
        null,
        label,
        h(
            "select",
            { name, value, onChange: (event: Event) => onChange((event.target as HTMLSelectElement).value) },
            emptyLabel === null ? null : h("option", { value: DEFAULT }, emptyLabel),
            ...[...new Set(value === DEFAULT || options.includes(value) ? options : [...options, value])].map((each) =>
                h("option", { value: each }, each),
            ),
        ),
    );

const actionButton = (label: string, className: string, isDisabled: boolean, onClick: () => unknown) =>
    h("button", { type: "button", class: `button ${className}`, disabled: isDisabled, onClick }, label);

const authFields = (form: MailForm, set: Setter, only: (field: string) => boolean) =>
    fieldsFor(form.auth)
        .filter(only)
        .map((name) => {
            const isSecret = name in SECRET_LABELS;
            const type = isSecret ? "password" : name === "passwordCommand" ? "area" : "text";
            return textBox(FIELD_LABELS[name], name, form[name], set(name), type);
        });

const isSecretField = (name: string) => name in SECRET_LABELS;
const isAnyField = () => true;

const settingFields = (form: MailForm, set: Setter, roles: string[]) => [
    textBox("Check interval (seconds)", "checkIntervalSeconds", form.checkIntervalSeconds, set("checkIntervalSeconds")),
    selectBox("Triage role", "triageRole", form.triageRole, roles, set("triageRole")),
    textBox("Allowlist (one address per line)", "allow", form.allow, set("allow"), "area"),
];

const createFields = (form: MailForm, set: Setter, roles: string[]) => [
    textBox("Name", "name", form.name, set("name")),
    selectBox("Kind", "kind", form.kind, KINDS, set("kind"), null),
    textBox("Address", "address", form.address, set("address")),
    textBox("IMAP host", "imapHost", form.imapHost, set("imapHost")),
    textBox("IMAP port", "imapPort", form.imapPort, set("imapPort")),
    selectBox("IMAP security", "imapSecurity", form.imapSecurity, SECURITIES, set("imapSecurity")),
    textBox("SMTP host", "smtpHost", form.smtpHost, set("smtpHost")),
    textBox("SMTP port", "smtpPort", form.smtpPort, set("smtpPort")),
    selectBox("SMTP security", "smtpSecurity", form.smtpSecurity, SECURITIES, set("smtpSecurity")),
    textBox("Login", "login", form.login, set("login")),
    selectBox("Authentication", "auth", form.auth, AUTHS, set("auth"), null),
    ...authFields(form, set, isAnyField),
    ...settingFields(form, set, roles),
];

const field = (className: string, label: string, value: string) =>
    h("div", null, h("dt", null, label), h("dd", { class: className }, value));

const checkText = (label: string, check: ServerCheck) =>
    check.ok ? `${label}: ok` : `${label}: failed${check.message === undefined ? "" : ` - ${check.message}`}`;

const TestOutcome = ({ result }: { result: TestResult }) =>
    h(
        "div",
        { class: "mail-test-result" },
        h("p", { class: "mail-test-imap" }, checkText("IMAP", result.imap)),
        result.smtp === undefined ? null : h("p", { class: "mail-test-smtp" }, checkText("SMTP", result.smtp)),
    );

const SignInOutcome = ({ start }: { start: SignInStart }) =>
    h(
        "p",
        { class: "mail-signin-start" },
        "Open ",
        h(
            "a",
            {
                class: "mail-signin-address",
                href: start.address,
                target: "_blank",
                rel: "noopener",
                "data-verbatim": "",
            },
            start.address,
        ),
        start.kind === "device_code"
            ? [" and enter the code ", h("span", { class: "mail-signin-code", "data-verbatim": "" }, start.code)]
            : [
                  ". On another machine, forward port ",
                  h("span", { class: "mail-signin-port", "data-verbatim": "" }, String(start.port)),
                  " to this one first.",
              ],
    );

const AccountCard = ({
    account,
    roles,
    reload,
    report,
}: {
    account: MailAccountView;
    roles: string[];
    reload: Reload;
    report: Report;
}) => {
    const connected = useContext(isConnected);
    const { form, setForm, set } = useForm(formFor(account));
    const { isCalling, failure, call } = useCall();
    const [test, setTest] = useState<TestResult | undefined>(undefined);
    const [signIn, setSignIn] = useState<SignInStart | undefined>(undefined);
    const settings = JSON.stringify(formFor(account));
    const stored = useRef(settings);

    // A reread that brought different settings replaces the form; the team member's own edits stay otherwise.
    useEffect(() => {
        if (stored.current === settings) return;
        stored.current = settings;
        setForm(formFor(account));
    }, [settings, account, setForm]);
    // The sign-in's instructions are done with once the account is ready.
    useEffect(() => {
        if (account.status === "ready") setSignIn(undefined);
    }, [account.status]);

    const invoke = (operation: string, input: Record<string, unknown> = {}) =>
        pageClient().invoke(operation, { name: account.name, ...input });
    const save = () =>
        call(async () => {
            try {
                await invoke("mail.accounts.change", changeInput(account, form));
            } finally {
                setForm(clearSecret);
            }
            report(`${account.name} saved`);
            await reload();
        });
    const runTest = () => call(async () => setTest((await invoke("mail.accounts.test")) as TestResult));
    const startSignIn = () => call(async () => setSignIn((await invoke("mail.accounts.signin")) as SignInStart));
    const remove = () =>
        call(async () => {
            await invoke("mail.accounts.remove");
            report(`${account.name} removed`);
            await reload();
        });
    const isDisabled = !connected || isCalling;
    return h(
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
        ...authFields(form, set, isSecretField),
        ...settingFields(form, set, roles),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        actionButton("Save", "mail-save", isDisabled, save),
        actionButton("Test", "button-secondary mail-test", isDisabled, runTest),
        actionButton("Sign in", "button-secondary mail-signin", isDisabled, startSignIn),
        actionButton("Remove", "button-destructive mail-remove", isDisabled, remove),
        test === undefined ? null : h(TestOutcome, { result: test }),
        signIn === undefined ? null : h(SignInOutcome, { start: signIn }),
    );
};

const CreateAccount = ({ roles, reload, report }: { roles: string[]; reload: Reload; report: Report }) => {
    const connected = useContext(isConnected);
    const { form, setForm, set } = useForm(emptyForm());
    const { isCalling, failure, call } = useCall();
    const create = () =>
        call(async () => {
            try {
                await pageClient().invoke("mail.accounts.create", createInput(form));
            } finally {
                setForm(clearSecret);
            }
            report(`${form.name.trim()} created`);
            setForm(emptyForm());
            await reload();
        });
    return h(
        "section",
        { class: "card mail-create" },
        h("h3", null, "Add an account"),
        ...createFields(form, set, roles),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        actionButton("Add", "mail-create-submit", !connected || isCalling, create),
    );
};

const noticeText = (notice: MailNoticeView) =>
    notice.to === undefined ? "Notice cleared" : `Notice set: to ${notice.to}, from ${notice.from}`;

const NoticeSettings = ({
    notice,
    accounts,
    reload,
    report,
}: {
    notice: MailNoticeView;
    accounts: MailAccountView[];
    reload: Reload;
    report: Report;
}) => {
    const connected = useContext(isConnected);
    const [to, setTo] = useState(notice.to ?? "");
    const [from, setFrom] = useState(notice.from ?? "");
    const { isCalling, failure, call } = useCall();
    const stored = `${notice.to ?? ""}\n${notice.from ?? ""}`;

    // A reread that brought a different notice replaces the form.
    useEffect(() => {
        const [heldTo, heldFrom] = stored.split("\n");
        setTo(heldTo);
        setFrom(heldFrom);
    }, [stored]);

    const send = (input: Record<string, string>) =>
        call(async () => {
            const answer = (await pageClient().invoke("mail.notices.set", input)) as { notice: MailNoticeView };
            report(noticeText(answer.notice));
            await reload();
        });
    const isDisabled = !connected || isCalling;
    return h(
        "section",
        { class: "card mail-notice" },
        h("h3", null, "Notice mail"),
        h(
            "dl",
            null,
            field("mail-notice-to", "Notice address", notice.to ?? NOT_SET),
            field("mail-notice-from", "Sending account", notice.from ?? NOT_SET),
        ),
        textBox("Notice address", "to", to, setTo),
        selectBox(
            "Sending account",
            "from",
            from,
            accounts.map((account) => account.name),
            setFrom,
            NOT_SET,
        ),
        failure !== undefined ? h(RefusalMessage, { error: failure.error }) : null,
        actionButton("Save", "mail-notice-save", isDisabled, () => send({ to, from })),
        actionButton("Clear", "button-secondary mail-notice-clear", isDisabled, () => send({})),
    );
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
