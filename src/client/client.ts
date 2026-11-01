export type StreamEvent = { event: string; id?: string; data: string };

export type Transport = {
    call(name: string, input: unknown): Promise<unknown>;
    stream(path: string): AsyncIterable<StreamEvent>;
};

export class ClientError extends Error {
    readonly code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = "ClientError";
        this.code = code;
    }
}

export class UnreachableError extends Error {
    readonly target: string;

    constructor(target: string, reason: string) {
        super(reason);
        this.name = "UnreachableError";
        this.target = target;
    }
}
