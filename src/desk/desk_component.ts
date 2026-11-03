/**
 * The front desk's daemon component (S-001 REQ-021): at startup step 6 it makes sure the instance has its front desk,
 * and it holds the `desk.get` operation.
 */
import type { AgentsComponent } from "../agents/agents_component.ts";
import type { DaemonComponent, ServiceContext } from "../daemon/daemon.ts";
import type { Logger } from "../daemon/logger.ts";
import type { SeatSummary } from "../host/seating.ts";
import type { JobsComponent } from "../jobs/jobs_component.ts";
import { createJob } from "../service/job_operations.ts";
import { defineOperation, type Operation, ServiceError } from "../service/operations.ts";
import { createDeskToolsExtension } from "./desk_tools_extension.ts";
import { ensureFrontDesk, readFrontDeskId } from "./front_desk.ts";

export type DeskComponent = {
    component: DaemonComponent;
    // biome-ignore lint/suspicious/noExplicitAny: the operations have differing input and output types
    operations: Operation<ServiceContext, any, any>[];
};

type DeskView = { conversationId: string; seat: SeatSummary };

/** Where `afterCreate` is called: just before the front desk's creation commit is made, and just after it returned. */
export type DeskCreatePoint = "before-commit" | "after-commit";

export async function createDeskComponent(options: {
    agents: AgentsComponent;
    jobs: JobsComponent;
    logger: Logger;
    /** Test-only: called around the creation of the front desk, so a test can kill the process there. */
    afterCreate?: (point: DeskCreatePoint) => void | Promise<void>;
}): Promise<DeskComponent> {
    let context: ServiceContext | undefined;
    // The tools are built before the host opens, so they reach the service context once startup has bound it.
    const requireContext = (): ServiceContext => {
        if (context === undefined) throw new Error("The service context exists only after startup step 4");
        return context;
    };
    const deskTools = createDeskToolsExtension({
        host: () => requireContext().host,
        jobStore: () => requireContext().jobStore,
        catalogue: () => requireContext().catalogue,
        createJob: (request, caller) => createJob(requireContext(), options.jobs.options, request, caller),
    });
    const component: DaemonComponent = {
        name: "desk",
        optInExtensions: [deskTools],
        async ensureWorkspaces(ctx) {
            context = ctx;
            await options.afterCreate?.("before-commit");
            await ensureFrontDesk(ctx.host, options.agents.runtime().catalog);
            await options.afterCreate?.("after-commit");
        },
        async stop() {
            context = undefined;
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
