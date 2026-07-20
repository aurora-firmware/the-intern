---
id: T-091
title: Update user documentation for interactive bob chat
status: completed
priority: low
assigned-role: developer
created: '2026-06-11'
spec: S-008
---

# Update user documentation for interactive bob chat

## Description

Bring the user documentation in line with the S-008 chat behaviour. The
mdBook sources live in `the-intern/docs/src/`; the end-user guide
(`end-user-guide/index.md`) covers `bob chat` today.

Document: the `chat.send` params contract (`id`, `text`,
`application_identity`, optional `context_id`) and the `chat.message`
notification shape (`params.subscription`, `params.data` with a `text`
string for human-readable replies); the `--session` flag as selecting the
conversation context (it now maps to `context_id`); the `--json` output
mode for notifications; and an explicit note that replies require the
reply-producing pipeline from roadmap Phase 2 — until it lands, the
service delivers replies only when something injects them at the service
boundary. Remove or correct any text describing chat as send-only or the
old `session` wire field. Match the structure and tone of the surrounding
guide pages.

## Acceptance Criteria

AC-1: The documentation shall state the `chat.send` params contract and
the `chat.message` notification shape exactly as defined in S-008's wire
contract.

AC-2: The documentation shall describe `--session` as selecting the
conversation context (`context_id`) and shall note that reply generation
arrives with the Phase 2 pipeline.

AC-3: WHEN the documentation build runs THE SYSTEM SHALL build cleanly
with no broken links introduced by this change.

## Dependencies

- `T-086` — the documented push behaviour must exist.
- `T-088` — the documented params contract must be what the CLI sends.

## Files to Touch

- `the-intern/docs/src/end-user-guide/index.md` — chat usage, flags,
  output modes, current limitations.
- `the-intern/docs/src/SUMMARY.md` — only if a new page is added.

## Verification

```bash
cd the-intern/docs && mdbook build
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-06-11

Implemented T-091 in a single documentation cycle. The task required updating the `bob chat` section in `the-intern/docs/src/end-user-guide/index.md` to align with the S-008 wire contract as implemented by T-086 and T-088.

**What was done.** Read the existing guide, the S-008 spec wire contract section, and the completed T-086 and T-088 task files to establish the authoritative facts before writing. Verified the baseline `mdbook build` passed cleanly. Then replaced the `bob chat` section with content that:

- Removes the inaccurate example showing a reply from the Intern (since the Phase 2 reply pipeline has not landed, the service never produces one in production).
- Removes the old description of chat as send-only.
- Documents the `chat.send` params contract exactly as in S-008: `id` (subscription id), `text`, `application_identity`, optional `context_id`.
- Documents the `chat.message` notification shape: `params.subscription` (the subscription id) and `params.data.text` (human-readable reply).
- Describes `--session` precisely as setting `context_id` on every `chat.send` request.
- Documents the `--json` flag and shows the notification JSON shape inline.
- Adds an explicit "Current limitation — reply generation requires Phase 2" callout explaining that the push channel exists, messages are accepted, but no reply is produced in production until the Phase 2 pipeline lands.
- Adds a Wire contract table listing all four `chat.send` fields with required/optional and description.

**What was tried and rejected.** Considered adding a separate sub-page for the wire contract and updating `SUMMARY.md`. Rejected because the task spec says to touch `SUMMARY.md` only if a new page is added, and the wire contract fits naturally within the existing `bob chat` section at roughly the same length as comparable sections.

**What remains.** Nothing. All three acceptance criteria are met and `mdbook build` is clean.

Evidence: baseline and post-edit `mdbook build` both clean (INFO only; pre-existing non-fatal mermaid version warning). Commit `06816b1` on `task/T-091-update-user-documentation-for-interactive-bob-chat`.

### Session 2 — 2026-06-11

Addressed the single AC-1 failure identified in the Session 1 review verdict. The Reviewer correctly observed that the `--json` section showed the full JSON-RPC notification frame (`{"jsonrpc":"2.0","method":"chat.message","params":{...}}`), but the CLI actually prints only the `data` payload extracted from the notification.

**What was done.** Switched to the task branch and confirmed the existing state: lines 261–266 of `the-intern/docs/src/end-user-guide/index.md` contained the wrong wire frame example and two sentences about `params.subscription` and `` `params.data.text` `` that described fields the CLI does not output. Cross-checked `admin_rpc.rs` (lines 238–241) and `commands/chat.rs` (lines 217–224 and unit test lines 600–603) to confirm the actual CLI output is the `data` value only — `{"text":"<reply text>"}` — not the full frame.

Wrote a shell-script test with 7 assertions (3 for absent patterns, 4 for present patterns) before touching the file. The test failed on 4 counts: full jsonrpc frame present, two inaccurate sentences present, and the only `{"text":"..."}` occurrence was nested inside the frame. Implemented the fix by replacing the wrong JSON block and the two inaccurate sentences with a correct data-payload example and a cross-reference to the Wire contract section below. All 7 test assertions then passed. `mdbook build` confirmed clean (pre-existing mermaid version warning only).

**What was tried and rejected.** Considered removing the Wire contract section's mention of `params.subscription`/`params.data` to reduce duplication. Rejected: the Wire contract section correctly documents the wire-level frame, which is accurate and precisely what the Reviewer said to keep.

**What remains.** Nothing. All three acceptance criteria are met: AC-1 (correct `--json` output shape), AC-2 (`--session`/`context_id` and Phase 2 note unchanged from Session 1), AC-3 (`mdbook build` clean). Commit `2deb5fc` on the task branch.

### Session 3 — 2026-06-11

Addressed the sole remaining AC-1 failure from the Session 2 review: the Wire contract section documented only the `chat.send` params table but not the `chat.message` notification shape, while the `--json` section cross-referenced it as though it were present.

**What was done.** First confirmed the current state on the task branch: the Wire contract section contained `chat.open` prose, the `chat.send` four-field params table, and the Phase 2 limitation note, but nothing about the `chat.message` frame shape. The cross-reference sentence was a dangling pointer.

Re-read the S-008 wire contract: reply notifications use method `chat.message` with `params.subscription` (the subscription id) and `params.data` (the reply payload object), where `params.data` contains at least a `text` string for human-readable replies.

Wrote a shell-script test with 8 assertions covering: `data.text` present in the file, `params.subscription` and `params.data` and `data.text` each present inside the Wire contract section specifically, and the cross-reference sentence present. The test failed on 3 counts (all inside the Wire contract section). Implemented the fix by inserting a `chat.message` params table (three rows: `params.subscription`, `params.data`, `params.data.text`) between the `chat.send` table and the Phase 2 limitation heading. All 8 test assertions then passed. `mdbook build` confirmed clean.

**What was tried and rejected.** Considered using a nested table with a `data` sub-object row for `params.data.text`. Rejected in favour of a flat three-row table, which is simpler and consistent with the style of the surrounding guide pages.

**What remains.** Nothing. All three acceptance criteria are met: AC-1 (Wire contract section now documents both `chat.send` params and `chat.message` notification shape matching S-008; `--json` cross-reference points to real content), AC-2 (`--session`/`context_id` and Phase 2 note unchanged), AC-3 (`mdbook build` clean). Commit `6a42947` on the task branch.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-06-11

FAIL

**Stage 1 — Acceptance Criteria**

AC-2 and AC-3 pass.

AC-1 fails on one point: the `--json` output example in the documentation shows the full JSON-RPC notification frame, but the CLI actually prints only the `data` payload extracted from it.

- **File:** `the-intern/docs/src/end-user-guide/index.md`, `--json` output section (the paragraph beginning "With `--json`, each notification from the service is printed...")
- **What is wrong:** The documented JSON shape is:
  ```json
  {"jsonrpc":"2.0","method":"chat.message","params":{"subscription":"<sub-id>","data":{"text":"<reply text>"}}}
  ```
  This is the raw wire frame. However, `Subscription::recv()` in `the-intern/service/crates/bob/src/client/admin_rpc.rs` (line 238–241) extracts `params.data` before returning, and `write_chat_notification` in `the-intern/service/crates/bob/src/cli/commands/chat.rs` (line 222–224) calls `write_json_line` on that `data` value directly. The actual `--json` output is the data payload only, e.g. `{"text":"<reply text>"}`. This is confirmed by the unit test at line 600–603 of `commands/chat.rs`, which asserts the output is `{"text":"first"}\n{"text":"second"}\n`, not the full notification frame.
- **What should change:** Replace the JSON shape example and the two sentences below it (`params.subscription is…` and `params.data.text carries…`) with text that correctly describes what `--json` prints. The output is the `data` object from the notification, for example `{"text":"<reply text>"}`. The Wire contract section (which already documents the full `chat.message` notification shape at the wire level) is the right place for `params.subscription` and `params.data` semantics; that section is accurate and should be kept.

**Stage 2 — Code Quality**

Not reached due to Stage 1 failure on AC-1. mdbook build confirmed clean (no broken links, pre-existing mermaid version warning only).

### Review Verdict — 2026-06-11

FAIL

**Stage 1 — Acceptance Criteria**

AC-2 and AC-3 pass.

AC-1 fails. Session 2 correctly fixed the `--json` output example (now shows `{"text":"<reply text>"}` instead of the full JSON-RPC frame). However, the fix introduced a broken cross-reference: the `--json` section now says "The full wire-level notification shape (including `params.subscription` and `params.data`) is documented in the Wire contract section below," but the Wire contract section only documents the `chat.send` params table — it contains no documentation of the `chat.message` notification shape. AC-1 requires the documentation to state the `chat.message` notification shape exactly as defined in S-008's wire contract.

- **File:** `the-intern/docs/src/end-user-guide/index.md`, Wire contract section (lines 269–296 on the task branch)
- **What is wrong:** The Wire contract section documents `chat.send` params but does not document the `chat.message` notification shape at all. The cross-reference sentence in the `--json` section promises it is there, but it is not. S-008's wire contract specifies: reply notifications use method `chat.message` with params `subscription` (the subscription id) and `data` (the reply payload), where `data` contains at least a `text` string. None of this is stated in the Wire contract section.
- **What should change:** Add the `chat.message` notification shape to the Wire contract section. A table or equivalent prose matching S-008's definition is sufficient — for example, a `chat.message` params table listing `subscription` (subscription id, string) and `data` (reply payload object, with `data.text` being a human-readable string). The cross-reference from the `--json` section must then accurately point to real content.

**Stage 2 — Code Quality**

Not reached due to Stage 1 failure on AC-1. AC-3 confirmed: `mdbook build` passes cleanly (pre-existing mermaid version warning only, no broken links).

**Obstacles Encountered**

None. The Session 2 fix to the `--json` example is correct and was verified against `admin_rpc.rs` and `commands/chat.rs` (unit test at lines 600–603 asserts `{"text":"first"}\n{"text":"second"}\n`). The remaining issue is solely the missing `chat.message` notification shape in the Wire contract section.

### Review Verdict — 2026-06-11

PASS

**Stage 1 — Acceptance Criteria**

All three criteria pass.

- AC-1: The `chat.send` params table (lines 277–282) exactly matches S-008: `id`, `text`, `application_identity` (all required), `context_id` (optional). The `chat.message` notification shape table (lines 287–291) matches S-008 exactly: `params.subscription` (subscription id), `params.data` (reply payload object), `params.data.text` (human-readable reply string). The `--json` output example (`{"text":"<reply text>"}`) is correct — `Subscription::recv()` in `admin_rpc.rs` (lines 239–242) extracts `params.data` before returning, so the CLI receives and prints only the data payload, confirmed by the unit test at `commands/chat.rs` lines 600–603. The cross-reference from the `--json` section to the Wire contract section is now valid (Session 3 added the `chat.message` params table). All 8 assertions in `the-intern/docs/test_wire_contract.sh` pass.
- AC-2: `--session` is described as setting `context_id` on every `chat.send` request (line 238). The Phase 2 limitation note (lines 293–304) states that reply generation requires the Phase 2 pipeline, which has not yet landed.
- AC-3: `cd the-intern/docs && mdbook build` passes cleanly — INFO output only, pre-existing mermaid version warning, no broken links.

**Stage 2 — Code Quality**

The only changed source file is `the-intern/docs/src/end-user-guide/index.md` (documentation). Content is accurate, well-structured, and consistent with the style of surrounding guide pages. The developer verification script `the-intern/docs/test_wire_contract.sh` is a straightforward shell assertion helper. No dead code, no hardcoded secrets, no logic errors. No issues.

**Obstacles Encountered**

None.
