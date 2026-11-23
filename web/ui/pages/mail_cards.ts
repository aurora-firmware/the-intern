/**
 * The Mail page's account cards and forms (S-009 REQ-018): each account with its change form, Test, Sign in and
 * Remove, the form that adds an account, and the notice settings. The service owns the rules; its refusal shows next
 * to the form or card it concerns. A secret field is emptied right after each call, before the result shows.
 */
import { h } from "preact";
import { useContext, useEffect, useRef, useState } from "preact/hooks";
import { isConnected } from "../components/connection_banner.ts";
import { RefusalMessage } from "../components/refusal.ts";
import { pageClient } from "../feed_connection.ts";
import {
    changeInput,
    clearSecret,
    createInput,
    emptyForm,
    formFor,
    type MailAccountView,
    type MailNoticeView,
} from "../model/mail.ts";
import {
    actionButton,
    authFields,
    createFields,
    field,
    isSecretField,
    NOT_SET,
    type Reload,
    type Report,
    selectBox,
    settingFields,
    textBox,
    useCall,
    useForm,
} from "./mail_form.ts";

type ServerCheck = { ok: boolean; message?: string };
type TestResult = { imap: ServerCheck; smtp?: ServerCheck };
type SignInStart =
    | { kind: "device_code"; code: string; address: string }
    | { kind: "browser"; address: string; port: number };

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

export const AccountCard = ({
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

export const CreateAccount = ({ roles, reload, report }: { roles: string[]; reload: Reload; report: Report }) => {
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

export const NoticeSettings = ({
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
