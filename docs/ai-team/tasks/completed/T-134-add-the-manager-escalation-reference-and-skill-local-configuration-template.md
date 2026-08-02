---
id: T-134
title: Add the manager-escalation reference and skill-local configuration template
status: completed  # pending | in-progress | completed | blocked
priority: medium  # critical | high | medium | low
assigned-role: developer
created: '2026-08-01'
spec: S-010
---

# Add the manager-escalation reference and skill-local configuration template

## Description

S-010's escalation path: a `periodic` request has no caller to answer it
(ADR-004), so "ask for guidance" must produce an addressable artifact — an email
to a configured manager address — never a blocking wait. This task writes that
reference and the skill-local configuration template it reads.

Two files, under the `email-triage` skill directory and the package root (paths
rooted at the layout T-131 verified):
- `references/escalation.md` — when and how to escalate, what the escalation
  email must contain, and the hard-stop rules.
- `config/email-triage.example.toml` — the shipped template for the skill-local
  configuration, with `manager_address` documented and no real address. The real
  file (`config/email-triage.toml`) exists only in the owner-only deployed
  workspace, not in the repository.

Configuration lives in the job's own working directory, not bob's TOML config,
per S-010's Configuration Requirements and ADR-008 §5 ("actions use their own
configuration"). Manager-address provisioning itself is out of scope.

Hard rules from S-010 that this reference must carry: the escalation send is a
`bash` call and is therefore gated by S-004 like every other call; if it is
blocked, or the address is missing or malformed, the message is a hard stop
recorded as an open worklog item — never a licence to act autonomously instead.
The worklog entry format is defined by T-133's `references/worklog.md`; refer to
it rather than restating it.

## Acceptance Criteria

AC-1: The system shall define the skill-local configuration file
      `config/email-triage.toml` in the job's working directory with a required
      `manager_address` key holding a single well-formed email address, and ship
      an example file documenting that key with no real address.
AC-2: WHEN a message's classification is not confident THE SYSTEM SHALL send one
      escalation email to `manager_address` describing the message, the
      uncertainty, and the question asked, and take no further action on that
      message in that run.
AC-3: IF the escalation send is blocked by bob's S-004 action gate THEN THE
      SYSTEM SHALL record the block as an open worklog item and SHALL NOT act on
      the message autonomously as a fallback.
AC-4: IF `manager_address` is missing or is not a well-formed address THEN THE
      SYSTEM SHALL treat the message as a hard stop recorded in the worklog, with
      no autonomous action.
AC-5: The system shall state that no synchronous reply is expected within the
      run, because scheduled firings are fire-and-forget periodic requests
      (ADR-004), and that the manager's reply returns as ordinary unseen mail.

## Dependencies

- `T-131` — verified skill-discovery path and package layout
- `T-133` — worklog entry format and open-item lifecycle referenced here

## Files to Touch

- `the-intern/email-skills/.pi/skills/email-triage/references/escalation.md` —
  new: escalation trigger, email content, S-004-block and missing-address stops
- `the-intern/email-skills/config/email-triage.example.toml` — new: documented
  `manager_address` template with a placeholder value

## Verification

```bash
# The template ships a documented key and no real address.
cat the-intern/email-skills/config/email-triage.example.toml

# The reference carries all four hard rules and defers the entry format.
rg -n "manager_address|blocked|hard stop|worklog.md|periodic" \
  the-intern/email-skills/.pi/skills/email-triage/references/escalation.md

# Behavioural check (read-only, no mail sent): in a copy of the package with
# config/email-triage.toml absent, ask what it would do with a message it cannot
# classify confidently. The answer must be "record a hard stop as an open
# worklog item", never "act on it anyway".
#
# The email-triage SKILL.md that loads this reference does not exist until
# T-135, so name the file in the prompt. Use the non-interactive invocation form
# T-131 recorded; pi's default mode is a TTY TUI.
cd /tmp/email-skills-probe && pi -p "Read .pi/skills/email-triage/references/escalation.md. Following only its rules, and given config/email-triage.toml does not exist, what do you do with a message you cannot classify confidently? Send no mail."
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-02

Read the Work Log first (empty — first session on this task) and the full task file, then, per the task's context note, T-131's `the-intern/email-skills/README.md` (verified skill-discovery path, package layout, `pi -p -a` invocation form) and T-133's `references/worklog.md` (diary format and skip-tolerant reconciliation), plus S-010 (Design Principles, Workflow, Configuration Requirements, Exclusions), ADR-004 (periodic delivery kind — no caller, fire-and-forget), ADR-008 §5 (actions use their own configuration; no secrets custodied by bob), and S-004 (default-deny action gate, allow-only rules) before writing anything, so the escalation reference would use consistent terminology and correctly defer to `worklog.md` rather than restating its entry format.

Implemented the two `Files to Touch` in seven small red→green→refactor cycles, each checked with `rg` before (confirming absence/failure) and after (confirming presence) writing content, committed individually:

1. `config/email-triage.example.toml` — the shipped template with a commented `manager_address` key and a placeholder using the RFC 2606 `.invalid` TLD (`manager@example.invalid`) so it reads unambiguously as a non-real address; verified as parseable TOML with `python3 -c "import tomllib; ..."` in addition to the `rg` check.
2. `escalation.md` "Configuration" section — location `config/email-triage.toml` under the job's `--cwd`, the single required `manager_address` key, and a note that the real file is deployed-workspace-only per the README (AC-1's reference-side half).
3. "When to escalate" — confidence-gated escalation trigger (not action-reversibility or an allowlist, per S-010 Design Principles), "send one email then take no further action this run," and the three required email contents: what the message is, why it's uncertain, and the concrete question (AC-2).
4. "If the escalation send is blocked (S-004)" — ties the escalation send to the same S-004 `bash` gate as every other call, records the block as a worklog open item, and explicitly forbids falling back to autonomous action (AC-3).
5. "If `manager_address` is missing or malformed" — same hard-stop/worklog-open-item/no-autonomous-fallback treatment for a missing file, missing key, or malformed address (AC-4).
6. "No synchronous reply is expected" — `periodic`/ADR-004 fire-and-forget framing, and the manager's reply returning only as ordinary unseen mail that re-enters triage on a later run, with the open item staying open until "the reply's own per-message entry marks the matter handled" — deferring to `worklog.md` for the actual entry format rather than restating it, per the task description's explicit instruction (AC-5).
7. Refactor: added a short orienting paragraph under the H1 (mirroring `worklog.md`'s own opening-paragraph style) restating the escalation path's purpose and the ADR-004 no-synchronous-reply framing up front; re-ran every prior `rg` check afterward to confirm nothing regressed before committing the refactor separately.

Ran the task's full Verification block end-to-end as a final check: `cat` on the example TOML confirmed the documented key and placeholder address; the task's own combined `rg` pattern (`manager_address|blocked|hard stop|worklog.md|periodic`) matched throughout `escalation.md`; and the behavioral check was run in a fresh `/tmp/email-skills-probe` scratch copy of the whole package (mirroring T-131/T-132/T-133's setup) with `config/email-triage.toml` deliberately absent. Ran the exact prompt from the Verification block three times — twice with bare `pi -p` as literally specified, once more with `pi -p -a` as a cross-check — and all three responses correctly and consistently answered "hard stop, record an open worklog item, send no mail, do not act autonomously," with no variation in the substantive answer. Removed the scratch copy afterward.

Considered whether to fold "Configuration" and the missing/malformed-address section into one combined cycle (they're related) but kept them as separate AC-1/AC-4 cycles instead, since they correspond to distinct acceptance criteria with distinct verification patterns, matching T-133's one-cycle-per-AC precedent. Also considered writing a longer, single monolithic "Escalation" section rather than five headed subsections, but split them to keep each testable in isolation and to mirror `worklog.md`'s section-per-concern structure for consistency across the two reference files.

Nothing remains for this task as scoped: both `Files to Touch` entries exist, all five acceptance criteria have supporting `rg`/`cat`/TOML-parse/behavioral-probe evidence above, and the working tree is clean with seven commits on the task branch, none touching the canonical task file. `escalation.md` is self-contained reference content only — like `worklog.md`, it isn't wired into an `email-triage/SKILL.md` yet, since that skill file is T-135's job per this task's own description.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-02

PASS

**Stage 1 — Acceptance Criteria:**

- AC-1 (config template + `manager_address` key, no real address): met. `config/email-triage.example.toml` documents the single required `manager_address` key with placeholder `manager@example.invalid` (RFC 2606 `.invalid` TLD, unambiguously non-real). `escalation.md`'s "Configuration" section names the runtime path (`<workspace>/config/email-triage.toml`) and states the real file is deployed-workspace-only, never committed. Verified TOML parses via `tomllib` and the task's `cat` verification.
- AC-2 (escalate on low confidence, one email, no further action, required content): met. "When to escalate" ties escalation to classification confidence per S-010 Design Principles (not reversibility/allowlist), requires exactly one escalation email then no further action, explicitly rules out also acting "just in case," and lists all three required email contents (what the message is, why it's uncertain, the concrete question).
- AC-3 (S-004 block → worklog open item, never autonomous fallback): met. "If the escalation send is blocked (S-004)" records the block as an open worklog item and states in bold "do **not** fall back to acting on the message autonomously because the escalation didn't go through."
- AC-4 (missing/malformed `manager_address` → hard stop, no autonomous action): met. "If `manager_address` is missing or malformed" covers all three failure shapes (key missing, file missing, value not well-formed) and states in bold "do **not** attempt to guess, fabricate, or otherwise proceed... and do **not** fall back to acting on the message autonomously instead."
- AC-5 (no synchronous reply expected; manager's reply returns as ordinary unseen mail): met. "No synchronous reply is expected" states the ADR-004 fire-and-forget framing and that the reply arrives as ordinary unseen mail that re-enters triage on a later run, deferring to `worklog.md` for how the open item closes rather than restating its entry format (per the task's explicit instruction).

No unspecified behavior added; only the two `Files to Touch` were modified (`git diff --stat` against `dev-agent`: 2 files, 132 insertions, 0 deletions). No canonical task file or unrelated files touched on the task branch.

**Independent verification performed (not just re-reading claimed evidence):**

- Ran the task's own `rg` pattern against `escalation.md` — all five terms (`manager_address`, `blocked`, `hard stop`, `worklog.md`, `periodic`) present in context.
- Parsed the example TOML with `tomllib` — valid, single key, placeholder value.
- Checked both relative-path references resolve correctly: `escalation.md`'s `../../../../README.md` → package-root `README.md`; the example TOML's `../.pi/skills/email-triage/references/escalation.md` → the reference file. Both confirmed via `realpath -m`.
- Rebuilt the task's exact behavioral probe in a fresh scratch copy (`config/email-triage.toml` absent) and ran the literal Verification-block prompt against `pi -p` (v0.80.3): response was "Hard stop: record an open item in the day's worklog entry for that message. Do not send mail, do not guess an address, and do not act on the message autonomously." — matches the Work Log's claimed evidence.
- Ran an additional probe not in the task's own Verification block, specifically targeting this review's escalation-failure-ambiguity concern: with a valid `manager_address` present but the escalation send itself blocked by S-004, asked what happens to the original message. Response: "Record the S-004 block as an open item... do not send mail, act on the original message autonomously, or fall back to another category workflow. A blocked escalation is a hard stop for that message." No ambiguity found — the "never fall back to autonomous action" language holds independently for all three paths the reference distinguishes (normal escalation completing, S-004 block, missing/malformed address), each with its own explicit bolded "do **not** ... autonomously" statement rather than one hedged general rule that a reader could construe as conditional.

**Stage 2 — Code Quality:**

- Correctness: content is consistent with S-010 (Design Principles, Configuration Requirements, Exclusions), ADR-004 (periodic/fire-and-forget, no caller), and ADR-008 §5 (actions use their own configuration; no secrets custodied by bob) — checked each citation against the source documents, no misstatement found.
- Readability: five clearly headed, single-concern sections; consistent with `worklog.md`'s section-per-concern style noted in the Work Log.
- No dead content, no scope creep, no restating of `worklog.md`'s entry format (correctly deferred by reference per the task description's explicit instruction).
- Security: no real address or secret committed; example value uses the RFC 2606 reserved `.invalid` TLD.
- Commits: seven commits on the task branch, each `docs(email-triage): ...` — type/scope/imperative/lowercase/no-period/length all conform to `git-conventions`; no task/bug ID repeated in the subject.

Both stages pass. No blocking issues found.

Next owner: active Development Loop.
