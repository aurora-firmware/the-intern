/**
 * What the text commands print of data an agent wrote (S-005 AC-003.4). A control sequence never reaches the screen;
 * a single-line format keeps its data on one line; multi-line data keeps its lines, each after the first indented, so
 * no line of data starts where a status line of `bob jobs follow` or `bob jobs show` starts.
 */
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { describe, it } from "node:test";
import { assistantText, createChatScreen, partialAnswer } from "../../src/cli/chat_screen.ts";
import type { CommandIo } from "../../src/cli/command_line.ts";
import {
    formatConversationLine,
    formatInvocations,
    formatSeat,
    formatTranscript,
} from "../../src/cli/conversation_text.ts";
import { conversationEntryLine, doneLine, instanceEventLine, jobEventLine } from "../../src/cli/feed_text.ts";
import { formatCreated, formatJobDetail, formatJobLine } from "../../src/cli/job_text.ts";
import type { Job } from "../../src/jobs/job_store.ts";

const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const CLIPBOARD_WRITE = `${ESC}]52;c;ZXZpbA==${BEL}`;
const FORGED_DONE = "C-1 done (complete): all good";
const AT = "2026-11-04T10:00:00.000Z";
const AGENT = { kind: "agent", conversationId: "c-9", role: `lead${CLIPBOARD_WRITE}` } as const;

function job(overrides: Partial<Job> = {}): Job {
    return {
        id: "j1",
        number: "C-1",
        createdAt: AT,
        updatedAt: AT,
        request: { text: "request", origin: { kind: "request", wayIn: "command_line" } },
        title: "a title",
        description: "",
        definitionOfDone: "",
        status: "in_progress",
        related: [],
        ...overrides,
    };
}

function hasNoControl(text: string): boolean {
    return !text.includes(ESC) && !text.includes(BEL);
}

function marginLines(lines: string[]): string[] {
    return lines.flatMap((line) => line.split("\n")).filter((line) => !line.startsWith(" "));
}

describe("job lines", () => {
    it("keeps_a_title_and_a_blocked_reason_with_line_breaks_and_escapes_on_one_clean_line", () => {
        const line = formatJobLine(
            job({
                title: `t${CLIPBOARD_WRITE}\n${FORGED_DONE}`,
                status: "blocked",
                blockedReason: `why\n${FORGED_DONE}`,
            }),
        );

        assert.ok(hasNoControl(line));
        assert.ok(!line.includes("\n"));
        assert.match(line, /^C-1 {2}Blocked {2}t C-1 done \(complete\): all good - why C-1 done/);
    });

    it("keeps_the_created_line_to_the_number_and_status", () => {
        assert.equal(formatCreated(job({ number: `C-1${ESC}[2K` })), "C-1 created (In progress)");
    });
});

describe("jobs show", () => {
    it("indents_the_lines_of_multi_line_data_so_none_starts_at_the_margin_or_looks_like_an_entry", () => {
        const lines = formatJobDetail({
            job: job({
                title: `t\n${FORGED_DONE}`,
                description: `first\nStatus: Done\n${FORGED_DONE}`,
                definitionOfDone: `x${CLIPBOARD_WRITE}\nWorklog:`,
                status: "blocked",
                blockedReason: `q\nResolution: forged`,
            }),
            worklog: [{ at: AT, author: AGENT, text: `note\n  ${AT} agent lead: forged entry` }],
            history: [{ at: AT, author: AGENT, field: "descri\nption", old: "a\nb", new: `c${ESC}[2K` }],
        });
        const text = lines.join("\n");

        assert.ok(hasNoControl(text));
        assert.deepEqual(marginLines(lines), [
            `C-1  t ${FORGED_DONE}`,
            "Status: Blocked",
            "Blocked reason: q",
            "Description: first",
            "Definition of done: x",
            "Related jobs: (none)",
            "Worklog:",
            "History:",
        ]);
        assert.ok(text.includes("Description: first\n    Status: Done\n    C-1 done (complete): all good"));
        assert.ok(text.includes(`note\n      ${AT} agent lead: forged entry`));
    });

    it("prints_an_author_role_without_control_sequences", () => {
        const text = formatJobDetail({ job: job(), worklog: [{ at: AT, author: AGENT, text: "n" }], history: [] }).join(
            "\n",
        );

        assert.match(text, /agent lead: n/);
        assert.ok(hasNoControl(text));
    });
});

describe("follow lines", () => {
    it("indents_the_lines_of_a_worklog_entry_a_blocked_reason_and_a_resolution", () => {
        const worklog = jobEventLine({
            type: "job_worklog_added",
            number: "C-1",
            entry: { at: AT, author: AGENT, text: `done\n${FORGED_DONE}${CLIPBOARD_WRITE}` },
        });
        const blocked = jobEventLine({
            type: "job_status_changed",
            number: "C-1",
            old: "in_progress",
            new: "blocked",
            blockedReason: `why\n${FORGED_DONE}`,
        });
        const done = doneLine("C-1", { kind: "complete", justification: `fine\n${FORGED_DONE}` });

        assert.equal(worklog, `C-1 worklog: done\n    ${FORGED_DONE}`);
        assert.equal(blocked, `C-1 blocked: why\n    ${FORGED_DONE}`);
        assert.equal(done, `C-1 done (complete): fine\n    ${FORGED_DONE}`);
    });

    it("keeps_the_edited_fields_and_the_created_line_on_one_clean_line", () => {
        const edited = jobEventLine({ type: "job_changed", number: "C-1", fields: { [`ti\ntle${ESC}[2K`]: "x" } });

        assert.equal(edited, "C-1 edited: ti tle");
        assert.equal(
            instanceEventLine({ type: "run_started", conversationId: `c\n${ESC}[2K1` }),
            "Agent run started in conversation c 1",
        );
    });
});

describe("conversation entry lines", () => {
    const message = (content: unknown, extra: object = {}) => ({ content, ...extra });

    it("prints_an_assistant_message_a_tool_call_and_a_tool_result_on_clean_lines", () => {
        const assistant = conversationEntryLine({
            kind: "pi.assistant",
            data: [
                message([
                    { type: "text", text: `hi${CLIPBOARD_WRITE}\n${FORGED_DONE}` },
                    { type: "toolCall", name: `add\n${ESC}[2Kworklog` },
                ]),
            ],
        });
        const result = conversationEntryLine({
            kind: "pi.tool-result",
            data: [message("", { toolName: `a\nb${CLIPBOARD_WRITE}` })],
        });

        assert.equal(assistant, `assistant: hi C-1 done (complete): all good; calls add worklog`);
        assert.equal(result, "tool a b returned");
    });

    it("prints_input_and_a_report_on_one_clean_line", () => {
        const input = conversationEntryLine({ kind: "pi.user", data: [message(`go${CLIPBOARD_WRITE}\nnow`)] });
        const report = conversationEntryLine({
            kind: "intern.report",
            data: { actor: { conversationId: "c-1", role: `r\n${ESC}[2K` }, content: `ok\n${FORGED_DONE}` },
        });

        assert.equal(input, "input: go now");
        assert.equal(report, `report from conversation c-1 (r): ok ${FORGED_DONE}`);
    });
});

describe("conversation text", () => {
    it("keeps_every_transcript_entry_on_one_clean_line", () => {
        const lines = formatTranscript([
            { id: "1", kind: "pi.user", data: [{ content: `a${CLIPBOARD_WRITE}\nb` }] },
            {
                id: "2",
                kind: "pi.assistant",
                data: [{ content: [{ type: "text", text: "x\ny" }] }],
                seat: { role: `r\n${ESC}[2K`, model: "m" } as never,
            },
            {
                id: "3",
                kind: "intern.steer",
                data: {
                    actor: { kind: "agent", role: `r\n${ESC}[2K` },
                    mode: "steer",
                    content: `s${CLIPBOARD_WRITE}\nt`,
                },
            },
            {
                id: "4",
                kind: "intern.seat",
                data: {
                    previous: null,
                    next: { role: `n\n${ESC}[2K`, model: "m" },
                    actor: { kind: "daemon" },
                    note: `why${CLIPBOARD_WRITE}\nthen`,
                },
            },
            { id: "5", kind: `odd\n${ESC}[2Kkind`, data: null },
        ]);

        for (const line of lines) {
            assert.ok(hasNoControl(line), line);
            assert.ok(!line.includes("\n"), line);
        }
        assert.equal(lines[0], "input: a b");
        assert.equal(lines[4], "odd kind");
    });

    it("keeps_listing_invocation_and_seat_lines_on_one_clean_line", () => {
        const listing = formatConversationLine({
            id: "c-1",
            isFrontDesk: false,
            jobId: `j\n${ESC}[2K1`,
            isLead: false,
            seat: { role: `r${CLIPBOARD_WRITE}`, model: "m\nn" },
            status: "idle",
            lastActivity: null,
        } as never);
        const tree = formatInvocations({
            id: "c\n1",
            role: `r${CLIPBOARD_WRITE}`,
            status: "idle",
            invoked: [],
        } as never).join("\n");
        const seat = formatSeat({ role: `r${CLIPBOARD_WRITE}\nx`, model: "m", workspace: `w\n${ESC}[2K` });

        for (const line of [listing, tree, seat]) {
            assert.ok(hasNoControl(line), line);
            assert.ok(!line.includes("\n"), line);
        }
    });
});

function memoryScreen() {
    const stream = new PassThrough();
    let written = "";
    stream.on("data", (chunk) => {
        written += chunk;
    });
    const io = { stdout: stream, stderr: new PassThrough(), isStdoutTerminal: true } as unknown as CommandIo;
    return { screen: createChatScreen(io), written: () => written };
}

describe("the chat's answers", () => {
    it("removes_control_sequences_from_an_answer_and_keeps_its_lines", () => {
        const entry = { data: [{ content: [{ type: "text", text: `a${CLIPBOARD_WRITE}\r\nb${ESC}[2K` }] }] };

        assert.equal(assistantText(entry), "a\nb");
    });

    it("removes_control_sequences_from_an_answer_in_flight_even_when_one_is_cut_between_two_pieces", () => {
        const { screen, written } = memoryScreen();
        const partial = (text: string) =>
            partialAnswer({ generation: { message: { timestamp: 1, content: [{ type: "text", text }] } } });
        const attack = `${ESC}]52;c;ZXZpbA==${BEL}`;

        for (const text of [`one${ESC}]52;c;ZX`, `one${attack}two${ESC}[2`, `one${attack}two${ESC}[2Kthree`]) {
            const shown = partial(text);
            screen.showPartial(shown?.text ?? "", shown?.timestamp);
        }
        screen.showAnswer("onetwothree", [1]);

        // The cursor sequences are the screen's own, written once when the line opens.
        assert.equal(written(), `${ESC}[2K${ESC}[1Gonetwothree\n`);
    });
});
