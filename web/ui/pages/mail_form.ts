/**
 * The form pieces of the Mail page (S-009 REQ-018): the text and choice fields, the fields each kind and `auth` need,
 * the action buttons, and the hooks that hold a form and one call at a time. A secret field is a password field.
 */
import { h } from "preact";
import { useState } from "preact/hooks";
import { fieldsFor, type MailForm } from "../model/mail.ts";

export type Reload = () => Promise<void>;
export type Report = (text: string) => void;
export type Setter = (name: keyof MailForm) => (value: string) => void;

const AUTHS = ["password", "password_command", "google", "microsoft", "microsoft_app"];
const SECURITIES = ["tls", "starttls", "none"];
const KINDS = ["owned", "monitored"];
export const NOT_SET = "Not set";
const DEFAULT = "";
const SECRET_LABELS: Record<string, string> = { password: "Password", clientSecret: "Client secret" };
const FIELD_LABELS: Record<string, string> = {
    ...SECRET_LABELS,
    passwordCommand: "Password command (one part per line)",
    clientId: "Client ID",
    tenant: "Tenant",
};

/** One action at a time: whether it is going, and what the service said when it refused. */
export const useCall = () => {
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

export const useForm = (initial: MailForm) => {
    const [form, setForm] = useState(initial);
    const set: Setter = (name) => (value) => setForm((held) => ({ ...held, [name]: value }));
    return { form, setForm, set };
};

export const textBox = (label: string, name: string, value: string, onChange: (value: string) => void, type = "text") =>
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

export const selectBox = (
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

export const actionButton = (label: string, className: string, isDisabled: boolean, onClick: () => unknown) =>
    h("button", { type: "button", class: `button ${className}`, disabled: isDisabled, onClick }, label);

export const authFields = (form: MailForm, set: Setter, only: (field: string) => boolean) =>
    fieldsFor(form.auth)
        .filter(only)
        .map((name) => {
            const isSecret = name in SECRET_LABELS;
            const type = isSecret ? "password" : name === "passwordCommand" ? "area" : "text";
            return textBox(FIELD_LABELS[name], name, form[name], set(name), type);
        });

export const isSecretField = (name: string) => name in SECRET_LABELS;
const isAnyField = () => true;

export const settingFields = (form: MailForm, set: Setter, roles: string[]) => [
    textBox("Check interval (seconds)", "checkIntervalSeconds", form.checkIntervalSeconds, set("checkIntervalSeconds")),
    selectBox("Triage role", "triageRole", form.triageRole, roles, set("triageRole")),
    textBox("Allowlist (one address per line)", "allow", form.allow, set("allow"), "area"),
];

export const createFields = (form: MailForm, set: Setter, roles: string[]) => [
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

export const field = (className: string, label: string, value: string) =>
    h("div", null, h("dt", null, label), h("dd", { class: className }, value));
