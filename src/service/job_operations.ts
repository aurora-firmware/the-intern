/**
 * The control operation that starts a job's lead conversation (S-001 R-12, S-002 R-12, R-13). The Jobs component calls
 * it when a job is created. The job id is the idempotency key: a job has one lead conversation, and a repeated call
 * returns it and submits the first input once, because the input's request id is derived from the job id.
 */
import type { AgentsComponent } from "../agents/agents_component.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { submitInput } from "../host/conversation_control.ts";
import { createSeatedConversation, type Origin, readConversationMeta } from "../host/seating.ts";
import { RoleRefusedError } from "../roles/role_catalog.ts";
import type { Seat } from "../roles/role_model.ts";
import { DEFAULT_LEAD_ROLE } from "../roles/shipped_roles.ts";
import { defineOperation, type Operation, ServiceError } from "./operations.ts";
import { seatActorFor } from "./seat_operations.ts";

type LeadOrigin = Exclude<Origin, { kind: "invocation" }>;
type Overrides = { model?: string; thinkingLevel?: string; workspace?: string };
type StartLeadInput = {
    jobId: string;
    firstInput: string;
    origin: LeadOrigin;
    role?: string;
} & Overrides;
type StartLeadResult = { conversationId: string; created: boolean };

const OVERRIDE_FIELDS = ["model", "thinkingLevel", "workspace"] as const;
const ORIGIN_FIELDS: Record<LeadOrigin["kind"], readonly string[]> = {
    request: ["wayIn"],
    schedule: ["entry", "fireTime"],
    trigger: ["trigger", "event"],
    follow_up: ["conversationId"],
};

function asRecord(raw: unknown, name: string): Record<string, unknown> {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error(`${name} must be an object`);
    return raw as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, field: string): string {
    const value = record[field];
    if (typeof value !== "string" || value === "") throw new Error(`${field} must be a non-empty string`);
    return value;
}

function parseOrigin(raw: unknown): LeadOrigin {
    const record = asRecord(raw, "origin");
    const kind = record.kind as LeadOrigin["kind"];
    const fields = ORIGIN_FIELDS[kind];
    if (fields === undefined) throw new Error(`origin.kind must be one of ${Object.keys(ORIGIN_FIELDS).join(", ")}`);
    const origin: Record<string, string> = { kind };
    for (const field of fields) origin[field] = requireString(record, field);
    return origin as LeadOrigin;
}

function parseStartLead(raw: unknown): StartLeadInput {
    const record = asRecord(raw, "input");
    const input: StartLeadInput = {
        jobId: requireString(record, "jobId"),
        firstInput: requireString(record, "firstInput"),
        origin: parseOrigin(record.origin),
    };
    if (record.role !== undefined) input.role = requireString(record, "role");
    for (const field of OVERRIDE_FIELDS) {
        if (record[field] !== undefined) input[field] = requireString(record, field);
    }
    return input;
}

function refusalCode(error: RoleRefusedError): "not_found" | "invalid_input" | "conflict" {
    return error.kind === "invalid" ? "invalid_input" : error.kind;
}

export function jobOperations(component: AgentsComponent) {
    const startLead = defineOperation<ServiceContext, StartLeadInput, StartLeadResult>({
        name: "jobs.startLead",
        kind: "control",
        parse: parseStartLead,
        async run({ host }, input, caller) {
            const { jobId, firstInput, origin, role, ...overrides } = input;
            if (origin.kind !== "request" && Object.keys(overrides).length > 0) {
                throw new ServiceError(
                    "invalid_input",
                    `A ${origin.kind} job source cannot name a model, thinking level or workspace`,
                );
            }
            if (
                origin.kind === "follow_up" &&
                (await readConversationMeta(host, origin.conversationId)) === undefined
            ) {
                throw new ServiceError("not_found", `There is no conversation ${origin.conversationId} to follow up`);
            }
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
                actor: seatActorFor(caller),
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
