import type { Logger } from "../daemon/logger.ts";

export type ServiceErrorCode = "not_found" | "invalid_input" | "busy" | "conflict" | "unavailable" | "internal";

export class ServiceError extends Error {
    readonly code: ServiceErrorCode;

    constructor(code: ServiceErrorCode, message: string) {
        super(message);
        this.name = "ServiceError";
        this.code = code;
    }
}

export type DaemonPhase = "starting" | "ready" | "stopping";

export type Actor =
    | { kind: "team_member"; wayIn?: string }
    | { kind: "agent"; conversationId: string }
    | { kind: "job_source"; source: string };

export type Caller = { actor: Actor };

export type OperationKind = "read" | "control";

export type OperationDefinition<C, I, O> = {
    name: string;
    kind: OperationKind;
    phases?: readonly DaemonPhase[];
    parse(raw: unknown): I;
    run(ctx: C, input: I, caller: Caller): Promise<O>;
};

export type Operation<C, I, O> = OperationDefinition<C, I, O> & { phases: readonly DaemonPhase[] };

export type Catalogue = {
    list(): { name: string; kind: OperationKind }[];
    invoke(name: string, input: unknown, caller: Caller): Promise<unknown>;
};

export type CatalogueOptions<C> = {
    context: C;
    phase(): DaemonPhase;
    logger: Logger;
};

// The catalogue holds operations of differing input and output types, so it can only see them type-erased.
// biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
export type AnyOperation<C> = Operation<C, any, any>;

const DEFAULT_PHASES: readonly DaemonPhase[] = ["ready"];

export function defineOperation<C, I, O>(definition: OperationDefinition<C, I, O>): Operation<C, I, O> {
    if (definition.kind !== "read" && definition.kind !== "control") {
        throw new Error(
            `Operation ${definition.name} must be marked "read" or "control" as its kind, got ${String(definition.kind)}`,
        );
    }
    return { ...definition, phases: definition.phases ?? DEFAULT_PHASES };
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function parseInput<I>(operation: Operation<unknown, I, unknown>, raw: unknown): I {
    try {
        return operation.parse(raw);
    } catch (error) {
        throw new ServiceError("invalid_input", `Invalid input for ${operation.name}: ${describeError(error)}`);
    }
}

export function createCatalogue<C>(operations: readonly AnyOperation<C>[], options: CatalogueOptions<C>): Catalogue {
    const byName = new Map<string, AnyOperation<C>>();
    for (const operation of operations) {
        if (byName.has(operation.name)) throw new Error(`Operation ${operation.name} is defined more than once`);
        byName.set(operation.name, operation);
    }

    async function execute(operation: AnyOperation<C>, input: unknown, caller: Caller): Promise<unknown> {
        try {
            return await operation.run(options.context, input, caller);
        } catch (error) {
            if (error instanceof ServiceError) throw error;
            options.logger.error(`operation ${operation.name} failed`, { error: describeError(error) });
            throw new ServiceError("internal", `Operation ${operation.name} failed unexpectedly`);
        }
    }

    return {
        list: () =>
            [...byName.values()]
                .map(({ name, kind }) => ({ name, kind }))
                .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
        async invoke(name, rawInput, caller) {
            const operation = byName.get(name);
            if (!operation) throw new ServiceError("not_found", `Unknown operation ${name}`);
            if (!caller?.actor)
                throw new ServiceError("invalid_input", `Operation ${name} needs a caller with an actor`);
            const phase = options.phase();
            if (!operation.phases.includes(phase)) {
                throw new ServiceError("unavailable", `Operation ${name} is unavailable while the daemon is ${phase}`);
            }
            return execute(operation, parseInput(operation, rawInput), caller);
        },
    };
}
