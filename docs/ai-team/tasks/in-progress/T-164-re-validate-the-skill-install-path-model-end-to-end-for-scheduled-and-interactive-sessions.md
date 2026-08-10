---
id: T-164
title: Re-validate the skill install-path model end to end for scheduled and 
  interactive sessions
status: pending
priority: high
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Re-validate the skill install-path model end to end for scheduled and interactive sessions

## Description

S-011 Implementation Order Phase 5. Every earlier task builds a piece of the
install-path model in isolation; none of them proves the finished model
actually works end to end. S-011's Purpose states success is confirmed when
"a session started from a directory containing no skill files can still
perform a skilled task" and "a scheduled run and an interactive session both
journal through the same worklog skill." Run the same kind of live
validation T-139/T-140 ran for the old per-workspace model, against the new
one: install the packaged skill content once at the resolved
`skill_install_path`, then exercise both a scheduled job and an interactive
`bob chat` session from working directories that hold no skill files of
their own, confirming both actually use the installed skills. Record the
result in `the-intern/email-skills/README.md`'s validation section (the
T-139/T-140 precedent for where this evidence lives), correcting anything
T-161/T-162 documented that this live run contradicts.

## Acceptance Criteria

AC-1: The system shall confirm skills are installed once at the resolved
      `skill_install_path` (default or configured), with no per-workspace
      copy present anywhere in the validation run.
AC-2: WHEN a scheduled job whose `--cwd` contains no skill files fires THE
      SYSTEM SHALL still let the pi-agent session perform a skilled
      email-triage action (classify and act on a real test message) and
      journal that action through the `worklog` skill into the job's own
      working directory, proving skill delivery is independent of the job's
      working directory while diary state stays correctly `--cwd`-scoped.
AC-3: WHEN an interactive `bob chat` session is started from a working
      directory unrelated to any skill deployment THE SYSTEM SHALL let that
      session journal a worklog entry through the `worklog` skill.
AC-4: The system shall confirm a single stable action-rule set scoped to the
      install path (not per-workspace) admits every tool call exercised by
      both validation runs above, with no denied call worked around.

## Dependencies

- `T-161` — operator guide/quickstart already updated to the model being
  validated
- `T-162` — email-skills README already updated to the model being
  validated

## Files to Touch

- `the-intern/email-skills/README.md` — record the live validation result;
  correct anything T-162 documented that this run contradicts
- `the-intern/docs/src/operator-guide/index.md` — correction only, and only
  where the live run contradicts what T-161 documented (Gate 2 correction,
  2026-08-09: the Description requires correcting T-161's output, which
  lives in these files, so omitting them forces a Files-to-Touch boundary
  escalation)
- `the-intern/docs/src/quickstart/index.md` — same, correction only
- `the-intern/docs/test_operator_guide_email_triage_trust.sh` — same,
  correction only, if a corrected deployment section changes its assertions

## Verification

Manual live validation (no automated command; matches the T-139/T-140
precedent):

```
1. Confirm skill_install_path resolves and contains himalaya/email-triage/worklog.
2. Fire a scheduled job with --cwd containing no skill files; confirm the
   triage action succeeds and is admitted by the install-path-scoped rules.
3. Start `bob chat` from an unrelated directory; confirm a worklog entry is
   written through the worklog skill.
4. Record the exact rule set and commands exercised in README.md.
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-10

Read the (empty) Work Log, then the T-139/T-140 precedent this task explicitly follows, plus T-161/T-162's completed rewrites of the operator guide and package README to the install-path model. Confirmed the whole install-path chain (T-150, T-157–T-160) is live: `BobConfig.skill_install_path` resolves and threads through to `BOB_SKILL_INSTALL_PATH` on every spawn path, and `bob.ts` answers `resources_discover` with it.

Set up an isolated validation environment entirely outside the repo (a dedicated `skill_install_path`, an isolated `bob` runtime, a job workspace holding only `config/`+`worklog/`, and a separate interactive-chat cwd — none ever held any skill file), installed `.pi/skills/` there once, and loaded the README's own S-004 rule set. Hit the Unix socket path length limit against the scratchpad's deep path and moved the runtime-socket directory to a short `/tmp` path to work around it (documented as an obstacle, not a scope change).

**AC-3 (interactive `bob chat`).** Since `bob chat` forwards the client's own stdin/stdout/stderr straight through to pi's interactive TUI (which needs a real TTY), wrote a small Python pty-driving harness to script it non-interactively. First run hit 4 real denials; correlating bob's audit trail against pi's own local session JSONL transcripts (`~/.pi/agent/sessions/...`, needed because a follow-up hardening commit, `851166c`, deliberately stopped logging raw tool-call arguments at debug level for secret-safety) showed the existing `*ls worklog*` pattern missed flag variants (`ls -ld worklog`) and no rule admitted a standalone `date +%H:%M` lookup for the entry's `<HH:MM>` header. Broadened the ls pattern to `*ls *worklog*` and added a `date +%H:%M*` rule; re-ran clean with zero denials, worklog entry correctly written into the chat session's own (skill-file-free) cwd.

**AC-2 (scheduled job, live mailbox).** The `daneel` test mailbox held 12 genuine unrelated unseen GitHub-notification messages (real project correspondence), which would have been picked up and acted on by `email-triage`'s unscoped `not flag seen` scan alongside any test fixture. Snapshotted their IDs, temporarily marked them seen, restored the historical `automated-notification` fixture T-139 used ("Holded" invite) to `INBOX`/unseen, fired a `check-email` job against a `--cwd` holding no skill files, confirmed it correctly classified and filed the message and journaled into the job's own cwd — then fully restored the 12 real messages to unseen and confirmed no outbound mail was sent as a side effect. This run hit 3 more denials (a `find` over the install-path categories directory, and an `edit` plus an ad hoc Python-script `bash` call both trying to fix a worklog entry that had been written with a `00:00` placeholder instead of the real time); diagnosed these as *not* rule-set gaps — the `find` wasn't needed for correct completion, and admitting `edit`/arbitrary scripts would reopen exactly the broad tool surface this package's design deliberately excludes (the skill's own "Tool usage" sections). Filed `B-039` for the underlying wrong-timestamp skill-behavior defect rather than fixing it, since it requires editing skill/reference files outside T-164's Files-to-Touch scope.

Updated `the-intern/email-skills/README.md` and `the-intern/docs/src/operator-guide/index.md` in lockstep: the two rule-set fixes, rewrote the "not yet independently live-validated" `worklog`-rules callout to record it as now live-validated (citing T-164 and B-039), added a cross-reference in the T-139/T-140 summary sentence, and added a new "T-164 — skill install-path model, end to end" subsection under README's Validation outcomes recording the full setup, both runs, and the AC-4 gap analysis. Left `quickstart/index.md` and `test_operator_guide_email_triage_trust.sh` untouched — no contradiction was found in either (quickstart never repeats the detailed rule set; the trust-step script's assertions are unaffected by this section's body changes) and re-ran the trust-step script (9/9 pass) plus a full `mdbook build` after every edit to confirm no structural breakage. Confirmed via `git diff --stat dev-agent...task/T-164-...` that only the two intended files changed. Nothing remains for T-164's four acceptance criteria; `B-039` is now the tracked, separate follow-up (filed and committed to `dev-agent` by the loop: `095236d chore(bugs): file B-039 — worklog entry timestamp defaults to wrong placeholder`).

Evidence:
- `bash the-intern/docs/test_operator_guide_email_triage_trust.sh` → 9/9 PASS, before and after the edits.
- `BOB_BIN=<debug binary> mdbook build` in `the-intern/docs` → succeeds, only the pre-existing unrelated `mdbook-mermaid` version-mismatch warning.
- Literal T-161/T-162 verification-block greps re-run and still pass (`skill_install_path` present in both docs, no `cp -r the-intern/email-skills/.` in operator-guide, retired README headings absent, `claude/` present).
- Live filesystem evidence: `find` over the job workspace, the interactive-chat cwd, and the skill install path before/after both runs, confirming zero per-workspace skill copies and the skill content living only at the install path.
- Live worklog files: job workspace `worklog/2026-08-10.md` (automated-notification entry, `00:00` placeholder timestamp — the B-039 evidence) and chat-cwd `worklog/2026-08-10.md` (correct `22:18` timestamp after the rule-set fix).
- `bob`'s `audit.jsonl` verdict records and pi's own local session JSONL transcripts (`~/.pi/agent/sessions/...`) correlating each denial to its exact tool name and arguments.
- Live mailbox state verified restored: `himalaya envelope list ... "not flag seen"` returns exactly the original 12 IDs (`123`–`134`) both before and after the validation run; no new message in any Sent folder.
- `git diff --stat dev-agent...task/T-164-revalidate-skill-install-path-e2e` → only the two intended files changed.

Obstacles Encountered:
- Unix domain socket path length limit: the scratchpad's deeply-nested path exceeded `SUN_LEN` for `admin.sock`/`extension.sock`; worked around by pointing `BOB_TEST_RUNTIME_DIR` at a short `/tmp` path while keeping all other state under the scratchpad.
- `bob chat` needs a real TTY (pi's ink UI); no existing test/tooling in this repo drives it non-interactively, so a small Python pty harness was written for this session (not committed — validation tooling only).
- A follow-up hardening commit (`851166c`, after B-032) intentionally stopped logging raw tool-call arguments at `debug` level to avoid leaking secrets, so denied-call arguments had to be recovered from pi's own local per-cwd session JSONL transcripts (`~/.pi/agent/sessions/...`) instead of `bob`'s logs/audit trail.
- The live `daneel` test mailbox is also the account's real, actively-used inbox (12 genuine unrelated unseen GitHub-notification messages present at validation time); handled by temporarily neutralizing them (reversible `seen`-flag add/remove, fully restored and independently re-verified afterward) rather than risking autonomous action on real correspondence.
- Found a genuine skill-behavior defect (wrong `00:00` placeholder worklog timestamp on a scheduled run) that falls outside T-164's Files-to-Touch scope to fix; filed `B-039` via the `new-bug` skill instead of fixing it in place.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-10

PASS

**Stage 1 — Acceptance criteria.** All four criteria are met, independently
re-verified beyond the diff and beyond re-running the literal grep/script
checks — the actual ephemeral validation environment (`skill-install-path/`,
`job-workspace/`, `chat-cwd/`, `chat-cwd-2/`, `bob-dev/`) and the real `pi`
session transcripts and `bob` audit trail it produced were still present on
disk and were inspected directly:

- **AC-1** (single install-path copy, no per-workspace copy): confirmed by
  direct filesystem inspection — `job-workspace/` holds only
  `worklog/2026-08-10.md` and `config/email-triage.toml`; `chat-cwd/` and
  `chat-cwd-2/` hold only their own `worklog/2026-08-10.md`; the shared
  `skill-install-path/` holds exactly `himalaya/`, `email-triage/`,
  `worklog/` (26 `[[policy.action_rules]]` blocks in the live
  `bob-dev/config/bob/config.toml`, an exact match to the 26 blocks in the
  task-branch README) — no skill file anywhere outside the install path.
- **AC-2** (scheduled job, `--cwd` with no skill files, real triage +
  worklog journal): confirmed via the real pi session transcript
  (`.../t164/job-workspace`, `2026-08-10T20-24-00-685Z_...jsonl`) — the
  session read skills only from the install path, classified the "Holded"
  fixture, moved it to `INBOX.Notifications` via `himalaya`, and appended a
  worklog entry into the job's own `--cwd`. Independently confirmed against
  the live mailbox itself: `INBOX.Notifications` holds exactly the one
  Holded message, and no new message exists in either Sent folder — no test
  mail was sent.
- **AC-3** (interactive `bob chat`, unrelated cwd, worklog journal via the
  worklog skill): confirmed via two real pty-driven session transcripts
  (`chat-cwd` at 22:13, `chat-cwd-2` at 22:18) — both loaded
  `worklog/SKILL.md` + `references/*.md` from the install path and wrote a
  correctly-timed entry (`## 22:13 —`, `## 22:18 —`) into their own cwd.
- **AC-4** (single stable rule set admits every genuine call, no denied
  call worked around): confirmed against `bob-dev/state/bob/audit.jsonl` —
  exactly 7 recorded denials (4 at 20:13, matching the claimed compound
  if/then, `ls -ld worklog`, standalone `date +%H:%M`, and `printf`
  denials in the first `chat-cwd` run; 1 at 20:24 and 2 at 20:25, matching
  the claimed `find`, `edit`, and ad hoc Python `bash` denials in the
  `job-workspace` run). The final `config.toml` contains no `edit`-tool
  rule and no rule admitting the denied `find`/Python-script shapes — the
  three non-rule-set denials were genuinely left denied, not worked around.
  The two rule-set gaps really were gaps, and really are closed: the
  broadened `*ls *worklog*` pattern is exercised successfully later in the
  `job-workspace` run (`ls -1 worklog ...`, which the old `*ls worklog*`
  pattern would not have matched), and the new `date +%H:%M*` rule is
  exercised successfully by the same run's standalone `date +%H:%M` call
  (returns `22:25`, immediately after the entry was mis-written with a
  `00:00` placeholder — this is the exact B-039 evidence).

**Documentation accuracy checks (per the review request):**

1. The two rule-set fixes in `email-skills/README.md` and
   `docs/src/operator-guide/index.md` are identical in substance (same old
   pattern → same new pattern, same new rule, same task/bug citations) and
   both are real, verified gaps per the audit-trail/transcript evidence
   above — not just asserted.
2. B-039 read directly: title, summary, evidence (session JSONL path,
   audit-trail denial reasons/timestamps, final worklog file content), and
   suspected area (`entry-format.md` + `email-triage/references/worklog.md`)
   are a faithful, accurate description of what the Work Log and the raw
   transcripts show. Independently confirmed `entry-format.md`'s own
   append-command template only computes `TODAY=$(date +%F)` for the
   filename and never instructs a `date +%H:%M` lookup for the `<HH:MM>`
   header — B-039's root-cause claim is correct, not inferred.
3. No live mailbox side effects: `INBOX.Notifications` holds exactly the
   one historical fixture message; neither Sent folder has any new message.
   The claimed "12 IDs restored" is independently corroborated by the
   validation session's own `real-unseen-ids.txt` snapshot (`123 124 125
   ... 134`). A live re-check right now shows only 10 of those 12 IDs
   still unseen (123 and 124 are now Seen) — but no `pi`/`bob` session
   transcript exists after the T-164 validation run that touched the
   mailbox, so this is external drift on what the Developer's own Work Log
   already flags as "the account's real, actively-used inbox," not a T-164
   side effect.
4. AC-4 is genuinely addressed (see above), not just asserted — the
   distinction the README/operator-guide draws between "real rule-set
   gaps" (closed) and "correctly-denied calls that weren't rule-set gaps"
   (left denied) matches the audit trail and the final live policy config
   exactly.

**Stage 2 — Code quality (documentation).** Correctness and consistency
verified: the two touched files agree with each other and with the live
evidence; `quickstart/index.md` and the trust-step script were correctly
left untouched (`git diff --stat` confirms only the two intended files
changed); the trust-step script re-run here still passes 9/9 on the
task-branch version of the file it wasn't required to touch. `T-154`/`T-155`
citations check out against the actual completed task files. No unrelated
edits, no scope creep, Files-to-Touch respected (including the Gate-2
sanctioned operator-guide/quickstart correction-only touches).

**Minor, non-blocking observation:** the sentence "re-running the
interactive session with the fixed rule set produced zero denials" (both
files) is literally true but slightly overstates what that specific
re-run exercised — neither new rule was actually hit in `chat-cwd-2`
(the model used a `find worklog` compound check and a combined command
that both happened to already match pre-existing, unrelated catch-all
rules). The two new rules are still genuinely validated, just by the
`job-workspace` run's standalone calls rather than by that cited re-run.
Not worth a FAIL cycle; flagging for awareness only.

Next owner: Development Loop.
