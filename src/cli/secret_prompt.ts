/**
 * How `bob mail` reads a secret (S-009 REQ-017). On a terminal the prompt goes to standard error and standard input is
 * put in raw mode, so nothing typed is echoed; with `--secret-stdin` the secret is all of standard input less one
 * trailing line end. No flag or environment variable carries a secret. Imports no daemon code.
 */
import type { CommandIo } from "./command_line.ts";

export type ReadSecretOptions = { io: CommandIo; prompt: string; fromStdin: boolean };

type RawCapable = NodeJS.ReadableStream & { setRawMode?: (mode: boolean) => unknown };

const CTRL_C = "\u0003";
const CTRL_D = "\u0004";
const BACKSPACE = "\u007f";
const LINE_END = /\r\n|\n|\r/;
const TRAILING_LINE_END = /(?:\r\n|\n|\r)$/;

async function readAll(stdin: NodeJS.ReadableStream): Promise<string> {
    const chunks: string[] = [];
    stdin.setEncoding("utf8");
    for await (const chunk of stdin) chunks.push(String(chunk));
    return chunks.join("");
}

async function readFromStdin(io: CommandIo): Promise<string> {
    const secret = (await readAll(io.stdin)).replace(TRAILING_LINE_END, "");
    if (secret === "") throw new Error("Standard input held no secret: it is empty.");
    return secret;
}

function readFromTerminal(io: CommandIo, prompt: string): Promise<string> {
    const stdin = io.stdin as RawCapable;
    if (stdin.setRawMode === undefined) throw new Error("Standard input cannot be put in raw mode.");
    const setRawMode = stdin.setRawMode.bind(stdin);
    io.stderr.write(prompt);
    setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    return new Promise((resolve, reject) => {
        let typed = "";
        const finish = (settle: () => void) => {
            stdin.removeListener("data", onData);
            stdin.removeListener("end", onEnd);
            setRawMode(false);
            stdin.pause();
            io.stderr.write("\n");
            settle();
        };
        const onEnd = () => finish(() => reject(new Error("Standard input ended before a secret was typed.")));
        const onData = (chunk: string | Buffer) => {
            for (const char of String(chunk)) {
                if (char === CTRL_C) return finish(() => reject(new Error("The secret prompt was interrupted.")));
                if (char === CTRL_D || LINE_END.test(char)) return finish(() => resolve(typed));
                typed = char === BACKSPACE ? typed.slice(0, -1) : typed + char;
            }
        };
        stdin.on("data", onData);
        stdin.on("end", onEnd);
    });
}

/** The secret, read without echo from a terminal or, with `fromStdin`, from standard input. */
export async function readSecret({ io, prompt, fromStdin }: ReadSecretOptions): Promise<string> {
    if (fromStdin) return readFromStdin(io);
    if (!io.isStdinTerminal) {
        throw new Error("Standard input is not a terminal: pass --secret-stdin to read the secret from it.");
    }
    return readFromTerminal(io, prompt);
}
