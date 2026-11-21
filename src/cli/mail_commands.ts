/**
 * The `bob mail` commands that read and remove accounts and set the notice mail (S-009 REQ-017): each calls one
 * `mail.*` operation with the arguments given and prints the answer with `mail_text.ts`. The service validates every
 * value, so a refusal is printed as the service gives it. Imports no daemon code.
 */
import type { Client } from "../client/client.ts";
import type { MailAccountView, MailNoticeView, MailTestResult } from "../service/mail_operations.ts";
import type { CommandInput, CommandSpec } from "./command_line.ts";
import { EXIT_CODES } from "./command_line.ts";
import { withClient } from "./connection.ts";
import { formatAccountDetail, formatAccountLine, formatNotices, formatTestResult } from "./mail_text.ts";
import { writeError, writeJson, writeLine } from "./output.ts";

const namePositional = { name: "name", required: true };

function mailCommand(
    spec: Pick<CommandSpec, "verb" | "summary" | "positionals" | "options">,
    action: (client: Client, input: CommandInput) => Promise<number>,
): CommandSpec {
    return {
        group: "mail",
        ...spec,
        isData: true,
        callsService: true,
        run: (input) => withClient(input, (client) => action(client, input)),
    };
}

// Prints the answer as JSON, or the text of it.
function printAnswer(input: CommandInput, answer: unknown, text: string): number {
    if (input.json) writeJson(input.io, answer);
    else writeLine(input.io, text);
    return EXIT_CODES.ok;
}

const mailList = mailCommand(
    { verb: "list", summary: "List mail accounts.", positionals: [], options: {} },
    async (client, input) => {
        const answer = (await client.invoke("mail.accounts.list", {})) as { accounts: MailAccountView[] };
        if (input.json) writeJson(input.io, answer);
        else if (answer.accounts.length > 0) writeLine(input.io, answer.accounts.map(formatAccountLine).join("\n"));
        return EXIT_CODES.ok;
    },
);

const mailShow = mailCommand(
    { verb: "show", summary: "Show one mail account.", positionals: [namePositional], options: {} },
    async (client, input) => {
        const answer = (await client.invoke("mail.accounts.get", { name: input.positionals[0] })) as {
            account: MailAccountView;
        };
        return printAnswer(input, answer, formatAccountDetail(answer.account));
    },
);

const mailTest = mailCommand(
    { verb: "test", summary: "Check the login to an account's servers.", positionals: [namePositional], options: {} },
    async (client, input) => {
        const result = (await client.invoke("mail.accounts.test", { name: input.positionals[0] })) as MailTestResult;
        return printAnswer(input, result, formatTestResult(result));
    },
);

const mailRemove = mailCommand(
    { verb: "remove", summary: "Remove a mail account.", positionals: [namePositional], options: {} },
    async (client, input) => {
        const [name] = input.positionals;
        const answer = await client.invoke("mail.accounts.remove", { name });
        return printAnswer(input, answer, `${name} removed`);
    },
);

type NoticeAnswer = { notice: MailNoticeView };

async function setNotices(client: Client, input: CommandInput): Promise<number> {
    const { to, from } = input.options;
    if (typeof to !== "string" || typeof from !== "string") {
        writeError(input.io, "bob mail notices set needs both --to <address> and --from <account>.");
        return EXIT_CODES.usage;
    }
    const answer = (await client.invoke("mail.notices.set", { to, from })) as NoticeAnswer;
    return printAnswer(input, answer, formatNotices(answer.notice));
}

const mailNotices = mailCommand(
    {
        verb: "notices",
        summary: "Show the notice mail settings; with set or clear, change them.",
        positionals: [{ name: "action", required: false }],
        options: {
            to: { type: "string", description: "With set: the address notices go to." },
            from: { type: "string", description: "With set: the account notices come from." },
        },
    },
    async (client, input) => {
        const [action] = input.positionals;
        if (action === "set") return setNotices(client, input);
        if (action === "clear") {
            const answer = (await client.invoke("mail.notices.set", {})) as NoticeAnswer;
            return printAnswer(input, answer, "notices cleared");
        }
        if (action !== undefined) {
            writeError(
                input.io,
                `Unknown action "${action}": use "set" or "clear", or give none to show the settings.`,
            );
            return EXIT_CODES.usage;
        }
        const answer = (await client.invoke("mail.notices.get", {})) as NoticeAnswer;
        return printAnswer(input, answer, formatNotices(answer.notice));
    },
);

export const MAIL_COMMANDS: readonly CommandSpec[] = [mailList, mailShow, mailTest, mailRemove, mailNotices];
