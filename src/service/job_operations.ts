/**
 * The control operation that starts a job's lead conversation (S-001 REQ-012, S-002 REQ-012, REQ-013). The Jobs
 * component calls it when a job is created. The job id is the idempotency key: a job has one lead conversation, and a
 * repeated call returns it and submits the first input once, because the input's request id is derived from the job id.
 */
import type { AgentsComponent } from "../agents/agents_component.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { submitInput } from "../host/conversation_control.ts";
import { createSeatedConversation, type Origin, readConversationMeta } from "../host/seating.ts";
import { RoleRefusedError } from "../roles/role_catalog.ts";
import type { Seat } from "../roles/role_model.ts";
import { DEFAULT_LEAD_ROLE } from "../roles/shipped_roles.ts";
import { type Caller, defineOperation, type Operation, ServiceError } from "./operations.ts";
import { seatActorFor } from "./seat_operations.ts";

type LeadOrigin = Exclude<Origin, { kind: "invocation" }>;
type SourceOrigin = Extract<LeadOrigin, { kind: "schedule" | "trigger" }>;
// A team member's or an agent's origin is built from the caller, so the input names only its kind.
type OriginInput = SourceOrigin | { kind: "request" | "follow_up" };
type Overrides = { model?: string; thinkingLevel?: string; workspace?: string };
type StartLeadInput = {
    jobId: string;
    firstInput: string;
    origin?: OriginInput;
    role?: string;
} & Overrides;
type StartLeadResult = { conversationId: string; created: boolean };

const IN_PROCESS_WAY_IN = "in-process";
const OVERRIDE_FIELDS = ["model", "thinkingLevel", "workspace"] as const;
// Only a job source states its origin's details; the details of the other kinds come from the caller.
const ORIGIN_FIELDS: Record<LeadOrigin["kind"], readonly string[]> = {
    request: [],
    schedule: ["entry", "fireTime"],
    trigger: ["trigger", "event"],
    follow_up: [],
};
const CALLER_ORIGIN_KIND = { team_member: "request", agent: "follow_up" } as const;

function asRecord(raw: unknown, name: string): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${name} must be an object`);
    return raw as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
    const value = record[field];
    if (typeof value !== "string" || value === "") throw new Error(`${field} must be a non-empty string`);
    return value;
}

function parseOrigin(raw: unknown): OriginInput {
    const record = asRecord(raw, "origin");
    const kind = record.kind as LeadOrigin["kind"];
    const fields = ORIGIN_FIELDS[kind];
    if (fields === undefined) throw new Error(`origin.kind must be one of ${Object.keys(ORIGIN_FIELDS).join(", ")}`);
    const origin: Record<string, string> = { kind };
    for (const field of fields) origin[field] = requireString(record, field);
    return origin as OriginInput;
}

function parseStartLead(raw: unknown): StartLeadInput {
    const record = asRecord(raw, "input");
    const input: StartLeadInput = {
        jobId: requireString(record, "jobId"),
        firstInput: requireString(record, "firstInput"),
    };
    if (record.origin !== undefined) input.origin = parseOrigin(record.origin);
    if (record.role !== undefined) input.role = requireString(record, "role");
    for (const field of OVERRIDE_FIELDS) {
        if (record[field] !== undefined) input[field] = requireString(record, field);
    }
    return input;
}

/**
 * Builds the origin of a job's lead conversation from its caller (S-002 REQ-012): a team member's request with the
 * caller's way in, a follow-up of an agent's own conversation, or the schedule or trigger origin a job source states.
 * Throws `invalid_input` when the input names an origin of another kind than the caller's.
 */
export function originFor(caller: Caller, input: Pick<StartLeadInput, "origin">): LeadOrigin {
    const { actor } = caller;
    const named = input.origin;
    if (actor.kind === "job_source") {
        if (named?.kind !== "schedule" && named?.kind !== "trigger") {
            throw new ServiceError(
                "invalid_input",
                `Job source ${actor.source} must name a schedule or trigger origin`,
            );
        }
        return named;
    }
    const kind = CALLER_ORIGIN_KIND[actor.kind];
    if (named !== undefined && named.kind !== kind) {
        throw new ServiceError("invalid_input", `A ${actor.kind} call records a ${kind} origin, not ${named.kind}`);
    }
    if (actor.kind === "team_member") return { kind: "request", wayIn: actor.wayIn ?? IN_PROCESS_WAY_IN };
    return { kind: "follow_up", conversationId: actor.conversationId };
}

function refusalCode(error: RoleRefusedError): "not_found" | "invalid_input" | "conflict" {
    return error.kind === "invalid" ? "invalid_input" : error.kind;
}

// An agent's own conversation must exist: its follow-up origin names it, and its seat record names its role.
async function agentRoleOf(host: ServiceContext["host"], caller: Caller): Promise<string | undefined> {
    if (caller.actor.kind !== "agent") return undefined;
    const meta = await readConversationMeta(host, caller.actor.conversationId);
    if (meta === undefined) {
        throw new ServiceError("not_found", `There is no conversation ${caller.actor.conversationId} to follow up`);
    }
    return meta.seat.role;
}

export function jobOperations(component: AgentsComponent) {
    const startLead = defineOperation<ServiceContext, StartLeadInput, StartLeadResult>({
        name: "jobs.startLead",
        kind: "control",
        parse: parseStartLead,
        async run({ host }, input, caller) {
            const { jobId, firstInput, origin: _named, role, ...overrides } = input;
            const origin = originFor(caller, input);
            if (origin.kind !== "request" && Object.keys(overrides).length > 0) {
                throw new ServiceError(
                    "invalid_input",
                    `A ${origin.kind} job source cannot name a model, thinking level or workspace`,
                );
            }
            const callerRole = await agentRoleOf(host, caller);
            let seat: Seat;
            try {
                seat = component.runtime().catalog.seatFor(role ?? DEFAULT_LEAD_ROLE, overrides);
            } catch (error) {
                if (error instanceof RoleRefusedError) throw new ServiceError(refusalCode(error), error.message);
                throw error;
            }
            const result = await createSeatedConversation(host, {
                scope: "jobs.startLead",
                key: jobId,
                job: { jobId, isLead: true, origin, depth: 0 },
                seat,
                actor: seatActorFor(caller, callerRole),
            });
            // Every call submits: pi-durable deduplicates the request id, so a repeat repairs a crash before this point.
            await submitInput(host, result.conversationId, {
                content: firstInput,
                requestId: `lead:${jobId}`,
                busyMode: "followUp",
            });
            return result;
        },
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [startLead];
    return operations;
}
