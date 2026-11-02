/**
 * The control operation that starts a job's lead conversation (S-001 REQ-012, S-002 REQ-012, REQ-013). The Jobs
 * component calls it when a job is created. The job id is the idempotency key: a job has one lead conversation, and a
 * repeated call returns it and submits the first input once, because the input's request id is derived from the job id.
 */
import type { AgentsComponent } from "../agents/agents_component.ts";
import type { ServiceContext } from "../daemon/daemon.ts";
import { submitInput } from "../host/conversation_control.ts";
import type { HarnessHost } from "../host/harness_host.ts";
import { createSeatedConversation, type Origin, readConversationMeta, type SeatActor } from "../host/seating.ts";
import { type JobAuthor, type JobOrigin, letterFor } from "../jobs/job_model.ts";
import { type Job, JobNotFoundError, JobRefusedError } from "../jobs/job_store.ts";
import type { JobsComponentOptions } from "../jobs/jobs_component.ts";
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

/** What a job's lead conversation starts with; the job store keeps the parts the job itself doesn't hold. */
export type LeadStart = {
    jobId: string;
    firstInput: string;
    origin: Origin;
    role?: string;
    overrides: Overrides;
    actor: SeatActor;
};

/**
 * Seats the job's lead conversation and submits its first input (S-002 REQ-013). The job id is the idempotency key, so
 * a repeat returns the conversation, and the request id derived from it makes the first input go in once.
 */
export async function startLeadConversation(
    ctx: ServiceContext,
    agents: AgentsComponent,
    input: LeadStart,
): Promise<StartLeadResult> {
    const { host } = ctx;
    const { jobId, firstInput, origin, role, overrides, actor } = input;
    let seat: Seat;
    try {
        seat = agents.runtime().catalog.seatFor(role ?? DEFAULT_LEAD_ROLE, overrides);
    } catch (error) {
        if (error instanceof RoleRefusedError) throw new ServiceError(refusalCode(error), error.message);
        throw error;
    }
    const result = await createSeatedConversation(host, {
        scope: "jobs.startLead",
        key: jobId,
        job: { jobId, isLead: true, origin: origin as LeadOrigin, depth: 0 },
        seat,
        actor,
    });
    // Every call submits: pi-durable deduplicates the request id, so a repeat repairs a crash before this point.
    await submitInput(host, result.conversationId, {
        content: firstInput,
        requestId: `lead:${jobId}`,
        busyMode: "followUp",
    });
    return result;
}

export function jobOperations(component: AgentsComponent) {
    const startLead = defineOperation<ServiceContext, StartLeadInput, StartLeadResult>({
        name: "jobs.startLead",
        kind: "control",
        parse: parseStartLead,
        async run(ctx, input, caller) {
            const { host } = ctx;
            const { jobId, firstInput, origin: _named, role, ...overrides } = input;
            const origin = originFor(caller, input);
            if (origin.kind !== "request" && Object.keys(overrides).length > 0) {
                throw new ServiceError(
                    "invalid_input",
                    `A ${origin.kind} job source cannot name a model, thinking level or workspace`,
                );
            }
            const callerRole = await agentRoleOf(host, caller);
            return startLeadConversation(ctx, component, {
                jobId,
                firstInput,
                origin,
                ...(role !== undefined && { role }),
                overrides,
                actor: seatActorFor(caller, callerRole),
            });
        },
    });

    // biome-ignore lint/suspicious/noExplicitAny: heterogeneous operations cannot share a narrower type
    const operations: Operation<ServiceContext, any, any>[] = [startLead];
    return operations;
}

export type JobView = Job & { leadConversation?: string };

export type CreateJobRequest = {
    text: string;
    title?: string;
    statedBy?: string;
    idempotencyKey?: string;
    role?: string;
    model?: string;
    thinkingLevel?: string;
    workspace?: string;
    origin?: unknown;
};

const MAX_KEY_LENGTH = 200;
const CREATE_STRING_FIELDS = [
    "title",
    "statedBy",
    "idempotencyKey",
    "role",
    "model",
    "thinkingLevel",
    "workspace",
] as const;

function parseCreateJob(raw: unknown): CreateJobRequest {
    const record = asRecord(raw, "input");
    const request: CreateJobRequest = { text: requireString(record, "text") };
    for (const field of CREATE_STRING_FIELDS) {
        if (record[field] !== undefined) request[field] = requireString(record, field);
    }
    if (record.origin !== undefined) request.origin = record.origin;
    return request;
}

function sourceOrigin(raw: unknown, source: string): SourceOrigin {
    const mustName = `Job source ${source} must name a schedule or trigger origin`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
        throw new ServiceError("invalid_input", mustName);
    const kind = (raw as { kind?: unknown }).kind;
    if (kind !== "schedule" && kind !== "trigger") throw new ServiceError("invalid_input", mustName);
    try {
        return parseOrigin(raw) as SourceOrigin;
    } catch (error) {
        throw new ServiceError("invalid_input", `Invalid origin: ${error instanceof Error ? error.message : error}`);
    }
}

type CallerFacts = { origin: JobOrigin; author: JobAuthor; actor: SeatActor; relatedTo?: string };

// The job's origin and the lead's seat actor come from the caller; only a job source names an origin of its own.
async function describeCaller(host: HarnessHost, request: CreateJobRequest, caller: Caller): Promise<CallerFacts> {
    const { actor } = caller;
    if (actor.kind === "job_source") {
        return {
            origin: sourceOrigin(request.origin, actor.source),
            author: { kind: "daemon" },
            actor: seatActorFor(caller),
        };
    }
    if (request.origin !== undefined) {
        throw new ServiceError("invalid_input", `A ${actor.kind} call cannot name an origin; it comes from the caller`);
    }
    if (actor.kind === "team_member") {
        const wayIn = actor.wayIn ?? IN_PROCESS_WAY_IN;
        const origin: JobOrigin = { kind: "request", wayIn, ...(actor.observed && { observed: actor.observed }) };
        return { origin, author: { kind: "team_member", wayIn }, actor: seatActorFor(caller) };
    }
    const meta = await readConversationMeta(host, actor.conversationId);
    if (meta === undefined) {
        throw new ServiceError("not_found", `There is no conversation ${actor.conversationId} to follow up`);
    }
    return {
        origin: { kind: "follow_up", jobId: meta.jobId, conversationId: actor.conversationId },
        author: { kind: "agent", conversationId: actor.conversationId, role: meta.seat.role },
        actor: seatActorFor(caller, meta.seat.role),
        relatedTo: meta.jobId,
    };
}

function storeRefusal(error: unknown): unknown {
    if (error instanceof JobRefusedError) return new ServiceError(error.code, error.message);
    if (error instanceof JobNotFoundError) return new ServiceError("not_found", error.message);
    return error;
}

/** The lead conversation of a job: the one whose `intern.conversation` document names the job with `isLead`. */
export async function leadConversationOf(host: HarnessHost, jobId: string): Promise<string | undefined> {
    for (const { id } of await host.listConversations()) {
        const meta = await readConversationMeta(host, id);
        if (meta?.jobId === jobId && meta.isLead) return id;
    }
    return undefined;
}

function leadOrigin(origin: JobOrigin): Origin {
    if (origin.kind === "request") return { kind: "request", wayIn: origin.wayIn };
    if (origin.kind === "follow_up") return { kind: "follow_up", conversationId: origin.conversationId };
    return origin;
}

type StoredLeadStart = { role?: string; overrides: Overrides; actor: SeatActor };

/** Builds the lead's start from the job and what `createJob` stored with it. Repair uses it too. */
export async function leadStartFor(ctx: ServiceContext, job: Job): Promise<LeadStart> {
    const stored = (await ctx.jobStore.leadStartOf(job.id)) as StoredLeadStart;
    return {
        jobId: job.id,
        firstInput: `${job.number}\n\n${job.request.text}`,
        origin: leadOrigin(job.request.origin),
        ...(stored.role !== undefined && { role: stored.role }),
        overrides: stored.overrides,
        actor: stored.actor,
    };
}

function viewOf(job: Job, leadConversation: string | undefined): JobView {
    return leadConversation === undefined ? job : { ...job, leadConversation };
}

// Everything that can be refused is refused here, before the first write.
function checkBeforeWrite(
    options: JobsComponentOptions,
    request: CreateJobRequest,
    origin: JobOrigin,
): { letter: NonNullable<ReturnType<typeof letterFor>>; overrides: Overrides } {
    const letter = letterFor(origin);
    if (letter === undefined) {
        throw new ServiceError(
            "invalid_input",
            "A job needs a way in with a letter: command line, web interface or email",
        );
    }
    if (request.idempotencyKey !== undefined && request.idempotencyKey.length > MAX_KEY_LENGTH) {
        throw new ServiceError("invalid_input", `idempotencyKey must have 1 to ${MAX_KEY_LENGTH} characters`);
    }
    const overrides: Overrides = {};
    for (const field of OVERRIDE_FIELDS) {
        if (request[field] !== undefined) overrides[field] = request[field];
    }
    if (origin.kind !== "request" && Object.keys(overrides).length > 0) {
        throw new ServiceError(
            "invalid_input",
            `A ${origin.kind} job source cannot name a model, thinking level or workspace`,
        );
    }
    try {
        options.agents.runtime().catalog.seatFor(request.role ?? DEFAULT_LEAD_ROLE, overrides);
    } catch (error) {
        // S-004 REQ-007: an unknown role or an unresolvable override is invalid input, whatever the catalog calls it.
        if (error instanceof RoleRefusedError) throw new ServiceError("invalid_input", error.message);
        throw error;
    }
    return { letter, overrides };
}

/**
 * Creates a job and starts its lead (S-004 REQ-002, REQ-003, REQ-007). The role and overrides are checked before any
 * write, so a refused call leaves no job and uses no number. A lead that cannot start after the write cancels the job.
 */
export async function createJob(
    ctx: ServiceContext,
    options: JobsComponentOptions,
    request: CreateJobRequest,
    caller: Caller,
): Promise<JobView> {
    const { host, jobStore } = ctx;
    const { origin, author, actor, relatedTo } = await describeCaller(host, request, caller);
    const { letter, overrides } = checkBeforeWrite(options, request, origin);
    const leadStart: StoredLeadStart = { ...(request.role !== undefined && { role: request.role }), overrides, actor };
    let inserted: { job: Job; created: boolean };
    try {
        inserted = await jobStore.insertJob({
            letter,
            requestText: request.text,
            origin,
            ...(request.title !== undefined && { title: request.title }),
            ...(request.statedBy !== undefined && { statedBy: request.statedBy }),
            ...(request.idempotencyKey !== undefined && { idempotencyKey: request.idempotencyKey }),
            ...(relatedTo !== undefined && { relatedTo, author }),
            leadStart,
        });
    } catch (error) {
        throw storeRefusal(error);
    }
    const { job, created } = inserted;
    // A repeat of a Done job returns it unchanged; a repeat of a live one finishes a creation cut short in-process.
    if (job.status === "done") return viewOf(job, await leadConversationOf(host, job.id));
    if (created) await options.afterWrite?.("job-created", job.id);
    try {
        const { conversationId } = await startLeadConversation(ctx, options.agents, await leadStartFor(ctx, job));
        return viewOf(await jobStore.getJob(job.id), conversationId);
    } catch (error) {
        if (!(error instanceof ServiceError)) throw error;
        const justification = `The lead could not be started: ${error.message}`;
        try {
            return await jobStore.applyAction(job.id, "cancel", { justification }, { kind: "daemon" });
        } catch (cancelError) {
            throw storeRefusal(cancelError);
        }
    }
}

export function createJobOperation(options: JobsComponentOptions) {
    return defineOperation<ServiceContext, CreateJobRequest, JobView>({
        name: "jobs.create",
        kind: "control",
        parse: parseCreateJob,
        run: (ctx, request, caller) => createJob(ctx, options, request, caller),
    });
}
