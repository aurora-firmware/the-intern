/**
 * The seat change operation (S-001 R-4, R-7): a team member changes the seat of any conversation, naming a role and
 * optionally a model, a thinking level and a registered workspace. A new agent of that role is seated with the Full
 * context mode, or with the Clean mode when the change names a reset (R-11). An override that doesn't
 * resolve is refused and the seat stays unchanged.
 */
import type { AgentsComponent } from "../agents/agents_component.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { changeSeat, readConversationMeta, resetWithSeat, type SeatActor } from "../host/seating.ts";
import { RoleRefusedError } from "../roles/role_catalog.ts";
import type { Seat } from "../roles/role_model.ts";
import { type Caller, defineOperation, type Operation, ServiceError } from "./operations.ts";

type SeatInput = {
    conversationId: string;
    role: string;
    model?: string;
    thinkingLevel?: string;
    workspace?: string;
    reset?: { note?: string };
};
type SeatResult = Pick<Seat, "role" | "model" | "thinkingLevel" | "workspace">;

const IN_PROCESS_WAY_IN = "in-process";
const OPTIONAL_FIELDS = ["model", "thinkingLevel", "workspace"] as const;

function asRecord(raw: unknown): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("input must be an object");
    return raw as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
    const value = record[field];
    if (typeof value !== "string" || value === "") throw new Error(`${field} must be a non-empty string`);
    return value;
}

function parseReset(raw: unknown): { note?: string } {
    const record = asRecord(raw);
    return record.note === undefined ? {} : { note: requireString(record, "note") };
}

function parseSeat(raw: unknown): SeatInput {
    const record = asRecord(raw);
    const input: SeatInput = {
        conversationId: requireString(record, "conversationId"),
        role: requireString(record, "role"),
    };
    for (const field of OPTIONAL_FIELDS) {
        if (record[field] !== undefined) input[field] = requireString(record, field);
    }
    if (record.reset !== undefined) input.reset = parseReset(record.reset);
    return input;
}

/** Maps the caller's actor to the actor of a seat record. An agent's role is the one its conversation is seated in. */
export function seatActorFor(caller: Caller, role?: string): SeatActor {
    const { actor } = caller;
    if (actor.kind === "team_member") return { kind: "team_member", wayIn: actor.wayIn ?? IN_PROCESS_WAY_IN };
    if (actor.kind === "job_source") return actor;
    if (role === undefined)
        throw new Error(`The seat record of agent conversation ${actor.conversationId} needs its role`);
    return { kind: "agent", conversationId: actor.conversationId, role };
}

function refusalCode(error: RoleRefusedError): "not_found" | "invalid_input" | "conflict" {
    return error.kind === "invalid" ? "invalid_input" : error.kind;
}

export function seatOperations(component: AgentsComponent) {
    const seatOperation = defineOperation<ServiceContext, SeatInput, SeatResult>({
        name: "conversations.seat",
        kind: "control",
        parse: parseSeat,
        async run({ host }, { conversationId, role, reset, ...overrides }, caller) {
            if ((await readConversationMeta(host, conversationId)) === undefined) {
                throw new ServiceError("not_found", `There is no seated conversation ${conversationId}`);
            }
            let seat: Seat;
            try {
                seat = component.runtime().catalog.seatFor(role, overrides);
            } catch (error) {
                if (error instanceof RoleRefusedError) throw new ServiceError(refusalCode(error), error.message);
                throw error;
            }
            const callerRole =
                caller.actor.kind === "agent"
                    ? (await readConversationMeta(host, caller.actor.conversationId))?.seat.role
                    : undefined;
            const actor = seatActorFor(caller, callerRole);
            if (reset === undefined) {
                await changeSeat(host, conversationId, { seat, actor, contextMode: "full" });
            } else {
                const change = { seat, actor, contextMode: "clean" as const };
                await resetWithSeat(host, conversationId, { ...reset, change });
            }
            const { thinkingLevel, model, workspace } = seat;
            return { role: seat.role, model, ...(thinkingLevel !== undefined && { thinkingLevel }), workspace };
        },
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [seatOperation];
    return operations;
}
