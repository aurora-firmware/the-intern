/**
 * The instance's one front desk (S-001 REQ-021): a conversation seated as `desk` that has no job, no lead flag and no
 * first input. Its id is recorded under `FRONT_DESK_CREATION`, in the commit that creates it.
 */
import type { HarnessHost } from "../host/harness_host.ts";
import { findCreatedConversation } from "../host/idempotency.ts";
import { createSeatedConversation } from "../host/seating.ts";
import type { RoleCatalog } from "../roles/role_catalog.ts";
import { FRONT_DESK_CREATION } from "./desk_model.ts";

const FRONT_DESK_ROLE = "desk";

/**
 * Returns the front desk's conversation id, creating the conversation when the instance has none. The seat is resolved
 * only for a creation: an instance that has its front desk restarts without a model to seat it. A crash between the
 * lookup and the creation repeats both, and the keyed creation makes it happen once.
 */
export async function ensureFrontDesk(host: HarnessHost, catalog: RoleCatalog): Promise<string> {
    const existing = await readFrontDeskId(host);
    if (existing !== undefined) return existing;
    const { conversationId } = await createSeatedConversation(host, {
        ...FRONT_DESK_CREATION,
        job: { jobId: null, isLead: false, origin: { kind: "front_desk" }, depth: 0 },
        seat: catalog.seatFor(FRONT_DESK_ROLE, {}, "front_desk"),
        actor: { kind: "daemon" },
    });
    return conversationId;
}

export function readFrontDeskId(host: HarnessHost): Promise<string | undefined> {
    return findCreatedConversation(host, FRONT_DESK_CREATION);
}
