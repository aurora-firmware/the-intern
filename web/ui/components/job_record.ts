/**
 * The Job page's record (S-006 REQ-003): its types and the drawing of the job's fields, worklog and history.
 */
import { type ComponentChildren, h } from "preact";
import { useEffect, useState } from "preact/hooks";
import { pageClient } from "../feed_connection.ts";

export type Observed = { remoteAddress?: string; remotePort?: number };
export type Author =
    | { kind: "agent"; conversationId: string; role: string }
    | { kind: "team_member"; wayIn: string; observed?: Observed }
    | { kind: "daemon" };
export type Origin =
    | { kind: "request"; wayIn: string; observed?: Observed; frontDesk?: string }
    | { kind: "schedule"; entry: string }
    | { kind: "trigger"; trigger: string }
    | { kind: "follow_up"; jobId: string };
export type JobRecord = {
    id: string;
    leadConversation?: string;
    number: string;
    title: string;
    description: string;
    definitionOfDone: string;
    status: string;
    blockedReason?: string;
    request: { origin: Origin };
    resolution?: { kind: string; justification: string };
    related?: string[];
};
export type WorklogEntry = { at: string; author: Author; text: string };
export type HistoryEntry = { at: string; author: Author; field: string; old: unknown; new: unknown };

const STATUS_LABELS: Record<string, string> = {
    to_do: "To do",
    in_progress: "In progress",
    blocked: "Blocked",
    done: "Done",
};
const TEXT_STYLE = "margin: 0; overflow-wrap: anywhere; white-space: pre-wrap;";
const LIST_STYLE = "display: flex; flex-direction: column; gap: 0.5rem; margin: 0; padding: 0; list-style: none;";

const addressOf = (observed?: Observed): string =>
    observed?.remoteAddress === undefined
        ? ""
        : ` from ${observed.remoteAddress}${observed.remotePort === undefined ? "" : `:${observed.remotePort}`}`;

/** The short number of the job a follow-up came from, or `undefined` until it is read and when the read fails. */
const useJobNumber = (jobId: string | undefined): string | undefined => {
    const [read, setRead] = useState<{ jobId: string; number: string }>();
    useEffect(() => {
        if (jobId === undefined) return;
        let isCurrent = true;
        pageClient()
            .invoke("jobs.get", { job: jobId })
            .then((job) => {
                if (isCurrent) setRead({ jobId, number: (job as JobRecord).number });
            })
            .catch(() => undefined);
        return () => {
            isCurrent = false;
        };
    }, [jobId]);
    return read?.jobId === jobId ? read?.number : undefined;
};

const originText = (origin: Origin, sourceNumber: string | undefined): string => {
    switch (origin.kind) {
        case "request":
            return origin.frontDesk === undefined
                ? `Request by ${origin.wayIn}${addressOf(origin.observed)}`
                : `Request by ${origin.wayIn} through the front desk`;
        case "schedule":
            return `Schedule ${origin.entry}`;
        case "trigger":
            return `Trigger ${origin.trigger}`;
        case "follow_up":
            return sourceNumber === undefined ? "Follow-up of another job" : `Follow-up of job ${sourceNumber}`;
    }
};

const authorText = (author: Author): ComponentChildren => {
    switch (author.kind) {
        case "agent":
            return [h("span", { "data-verbatim": "" }, author.role), " agent"];
        case "team_member":
            return `Team member by ${author.wayIn}${addressOf(author.observed)}`;
        case "daemon":
            return "The daemon";
    }
};

export const valueText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value));
export const historyText = (entry: HistoryEntry): string =>
    `${entry.field}: ${valueText(entry.old)} → ${valueText(entry.new)}`;

export const Field = ({ name, label, value }: { name: string; label: string; value: string }) =>
    h(
        "div",
        { class: "job-field", "data-field": name },
        h("h3", null, label),
        h("p", { class: "job-value", style: TEXT_STYLE }, value),
    );

export const JobFields = ({ record }: { record: JobRecord }) => {
    const { resolution } = record;
    const { origin } = record.request;
    const sourceNumber = useJobNumber(origin.kind === "follow_up" ? origin.jobId : undefined);
    return h(
        "section",
        { class: "job-record" },
        h("h3", { class: "job-number" }, record.number),
        h(Field, { name: "title", label: "Title", value: record.title }),
        h(Field, { name: "description", label: "Description", value: record.description }),
        h(Field, { name: "definition-of-done", label: "Definition of done", value: record.definitionOfDone }),
        h(Field, { name: "status", label: "Status", value: STATUS_LABELS[record.status] ?? record.status }),
        record.status === "blocked"
            ? h(Field, { name: "blocked-reason", label: "Blocked reason", value: record.blockedReason ?? "" })
            : null,
        h(Field, { name: "origin", label: "Origin", value: originText(origin, sourceNumber) }),
        record.status === "done" && resolution !== undefined
            ? [
                  h(Field, { name: "resolution", label: "Resolution", value: resolution.kind }),
                  h(Field, { name: "justification", label: "Justification", value: resolution.justification }),
              ]
            : null,
    );
};

/** The jobs related to this one, each a link to its page. `action` draws what the page offers next to a related job. */
export const RelatedJobs = ({
    numbers,
    action,
}: {
    numbers: readonly string[];
    action?: (number: string) => ReturnType<typeof h>;
}) =>
    numbers.length === 0
        ? null
        : h(
              "section",
              { class: "job-related", "data-section": "related" },
              h("h3", null, "Related jobs"),
              h(
                  "ul",
                  { style: LIST_STYLE },
                  ...numbers.map((number) =>
                      h("li", { key: number }, h("a", { href: `#/jobs/${number}` }, number), action?.(number) ?? null),
                  ),
              ),
          );

export const Entries = ({ name, title, items }: { name: string; title: string; items: ReturnType<typeof h>[] }) =>
    h(
        "section",
        { class: `job-${name}`, "data-section": name },
        h("h3", null, title),
        h("ul", { style: LIST_STYLE }, ...items),
    );

export const EntryItem = ({ entry, text }: { entry: WorklogEntry | HistoryEntry; text: string }) =>
    h(
        "li",
        { class: "card job-entry" },
        h("span", { class: "caption" }, `${entry.at} `, authorText(entry.author)),
        h("p", { style: TEXT_STYLE, "data-verbatim": "" }, text),
    );

export const Missing = ({ number }: { number: string }) =>
    h("p", { class: "job-missing" }, `The job ${number} doesn't exist. `, h("a", { href: "#/" }, "Back to the Board"));
