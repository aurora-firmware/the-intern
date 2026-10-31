export type LogFields = Record<string, string | number | boolean>;

export type Logger = {
    error(message: string, fields?: LogFields): void;
    info(message: string, fields?: LogFields): void;
    debug(message: string, fields?: LogFields): void;
};

export type LoggerOptions = {
    verbose?: boolean;
    stream?: { write(chunk: string): unknown };
    now?: () => number;
};

const NEEDS_QUOTING = /[\s"=]/;

function formatValue(value: string | number | boolean): string {
    const text = String(value);
    return NEEDS_QUOTING.test(text) ? JSON.stringify(text) : text;
}

function formatMessage(message: string): string {
    return message.replaceAll("\r", "\\r").replaceAll("\n", "\\n");
}

function formatFields(fields: LogFields): string {
    return Object.entries(fields)
        .map(([key, value]) => ` ${key}=${formatValue(value)}`)
        .join("");
}

export function createLogger(options: LoggerOptions = {}): Logger {
    const isVerbose = options.verbose ?? false;
    const stream = options.stream ?? process.stderr;
    const now = options.now ?? Date.now;

    function write(level: string, message: string, fields: LogFields = {}): void {
        const timestamp = new Date(now()).toISOString();
        stream.write(`${timestamp} ${level} ${formatMessage(message)}${formatFields(fields)}\n`);
    }

    return {
        error: (message, fields) => write("ERROR", message, fields),
        info: (message, fields) => write("INFO", message, fields),
        debug: (message, fields) => {
            if (isVerbose) write("DEBUG", message, fields);
        },
    };
}
