/**
 * The front desk's daemon component (S-001 REQ-021): at startup step 6 it makes sure the instance has its front desk,
 * and it holds the `desk.get` operation.
 */
import type { AgentsComponent } from "../agents/agents_component.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import type { SeatSummary } from "../host/seating.ts";
import type { JobsComponent } from "../jobs/jobs_component.ts";
import { defineOperation, type Operation, ServiceError } from "../service/operations.ts";
import { ensureFrontDesk, readFrontDeskId } from "./front_desk.ts";

export type DeskComponent = {
    component: DaemonComponent;
    // biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
    operations: Operation<ServiceContext, any, any>[];
};

type DeskView = { conversationId: string; seat: SeatSummary };

export async function createDeskComponent(options: {
    agents: AgentsComponent;
    jobs: JobsComponent;
    logger: Logger;
}): Promise<DeskComponent> {
    const component: DaemonComponent = {
        name: "desk",
        async ensureWorkspaces(ctx) {
            await ensureFrontDesk(ctx.host, options.agents.runtime().catalog);
        },
    };

    const getOperation = defineOperation<ServiceContext, Record<string, never>, DeskView>({
        name: "desk.get",
        kind: "read",
        parse: () => ({}),
        async run(ctx, _input, caller) {
            const conversationId = await readFrontDeskId(ctx.host);
            if (conversationId === undefined) throw new ServiceError("not_found", "The instance has no front desk");
            // The seat is read the way `conversations.get` reads it, so the two cannot differ.
            const listing = (await ctx.catalogue.invoke("conversations.get", { conversationId }, caller)) as {
                seat: SeatSummary;
            };
            return { conversationId, seat: listing.seat };
        },
    });
    return { component, operations: [getOperation] };
}
