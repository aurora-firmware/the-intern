---
id: T-229
title: Document pi_agent_model in the user manual
status: completed
priority: medium
assigned-role: developer
created: '2026-09-29'
---

# Document pi_agent_model in the user manual

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Document `pi_agent_model` in the user manual (CR-015 item 6 and Potential
Impact; S-002 v0.2 "Operator documentation"). Operators need to know the model
is now set in bob's config, not in pi's saved settings.

- `the-intern/docs/src/operator-guide/index.md`: a new section near "Working
  directory for pi-agent sessions" introducing the pi-agent process settings
  with one compact table mirroring S-002's (which keys reach pool workers and
  which reach `bob chat`), including `pi_agent_command` (default `pi`) and
  `pi_agent_args` (pool workers only, default `--mode rpc`, never applied to
  `bob chat`, model flags rejected), neither documented in the manual today.
  Then explain `pi_agent_model` — a top-level
  key passed verbatim as `--model` to every pi bob starts (pool workers and
  `bob chat`); why to set it (pi's saved choice changes whenever a model is
  picked in any session, and silently falls back when stale); unset →
  one startup warning; invalid → pi's error in the service log (or the
  `bob chat` terminal) and the job does not run until fixed; and how to
  confirm a value by hand with `pi --list-models <search>` and
  `pi auth check --provider <p> --json`, with their observed limits
  (fuzzy matching and exit 0 on no match; provider credentials only).
  Add a migration note under "Upgrading a running install": configs with
  `--model`, `--models`, or `--provider` in `pi_agent_args` now fail to load —
  move the value to `pi_agent_model`. Under "Observability for scheduled
  jobs", note that a fire whose worker never accepts the prompt appears in the
  service log only, not in `bob audit tail`.
- `the-intern/docs/src/quickstart/index.md` (~line 167): recommend setting
  `pi_agent_model` alongside `pi_agent_cwd`, and say that changing it needs a
  restart of `bob serve` (config is read and warm workers start at service
  start) — the nearby text (~line 172) says `bob policy reload` applies config
  edits, which is not true for this key.

Follow `docs/ai-team/docs/coding-guidelines-skills.md` §1–2: placeholder model
and provider names only, no internal task/bug/spec/ADR/issue IDs, no pi
version. Match the warning and error wording implemented in T-226/T-227.

## Acceptance Criteria

AC-1: The operator guide shall document the pi-agent process settings —
      a table of `pi_agent_command`, `pi_agent_args`, `pi_agent_model`, and
      the related keys by process kind — and `pi_agent_model`'s unset and
      invalid behaviour.
AC-2: The operator guide shall carry a migration note for configurations that
      put `--model`, `--models`, or `--provider` in `pi_agent_args`.
AC-3: The operator guide shall describe confirming a model with both pi
      commands, including their observed limits.
AC-4: The quickstart shall recommend setting `pi_agent_model` and state that
      changing it requires restarting `bob serve`.
AC-5: IF the added text names a model or provider THEN THE SYSTEM SHALL use a
      clearly placeholder value, and the text shall contain no internal IDs
      and no pi version.

## Dependencies

- `T-226` — final warning wording and spawn behaviour
- `T-227` — stderr forwarding the guide describes

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — new section, migration note,
  observability note
- `the-intern/docs/src/quickstart/index.md` — recommendation

## Verification

```bash
mdbook build the-intern/docs
grep -n "pi_agent_model" the-intern/docs/src/operator-guide/index.md the-intern/docs/src/quickstart/index.md
# only the lines this task adds must be free of internal IDs and versions
! git diff -U0 "$(git merge-base dev-agent HEAD)" -- the-intern/docs/src/operator-guide/index.md the-intern/docs/src/quickstart/index.md | grep '^+[^+]' | grep -nE "\b(T|B|S|CR)-[0-9]{3}\b|ADR-[0-9]{3}|#[0-9]{2,}|\b[0-9]+\.[0-9]+\.[0-9]+\b"
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-09-29

Documented `pi_agent_model` (and its two under-documented siblings, `pi_agent_command` and `pi_agent_args`) in the user manual, per the task description and CR-015/S-002 "pi-agent process settings". Read the actual T-226/T-227 implementation (`serve.rs`'s `warn_if_pi_agent_model_unset`, `config.rs`'s `validate()` and `pi_agent_shared_args()`, `pi-agent-supervisor/src/process.rs`'s `spawn_stderr_forwarder`) and quoted their exact wording verbatim rather than paraphrasing, cross-checked against the T-228 Work Log's live transcripts and CR-015's "How pi chooses a model" section (which held the exact `pi --list-models`/`pi auth check` observed-limits wording the task asked for — fuzzy matching, exit 0 on no match, JSON-only auth check, provider-credentials-only scope — since T-228 itself never exercised those two commands).

`the-intern/docs/src/operator-guide/index.md`: added a new "## pi-agent process settings" section right before the existing "## Working directory for pi-agent sessions", with a compact table mirroring S-002's (which keys reach pool workers vs. `bob chat`), then `pi_agent_command`/`pi_agent_args` (neither documented before), then `pi_agent_model` in full — why to set it, unset/invalid behaviour with the exact log wording, and the two hand-check commands with their observed limits. Added the `pi_agent_args` migration note under "Upgrading a running install" with the exact config-load error string. Added the audit-trail-blind-spot note under "Observability for scheduled jobs".

`the-intern/docs/src/quickstart/index.md` (~line 167): recommend `pi_agent_model` alongside `pi_agent_cwd`, and added a note that unlike the policy edits described nearby, `bob policy reload` does not apply a `pi_agent_model` change — verified against `policy-control`'s `reload_snapshot`, which only re-reads and swaps the `[policy]` table, and against `serve.rs`'s `try_start_subsystems`, which builds the pi-agent supervisor config once at startup — so a restart is genuinely required.

What was tried and rejected: initially considered inlining a full `pi_agent_cwd`/`extension_path`/`skill_install_path` explanation in the new table's surrounding prose to fully "mirror" S-002, but that would duplicate detail already covered in this guide's own dedicated sections for those three keys, so the new section only explains the two keys not documented elsewhere plus `pi_agent_model`, and links to the existing sections for the rest. Considered a realistic-looking model name for the TOML examples, but the task's hard placeholder constraint (AC-5) made an explicit `<provider>/<model-id>` angle-bracket placeholder the safer, unambiguous choice, consistent with `coding-guidelines-skills.md` §2's placeholder convention.

Verification: built `mdbook build the-intern/docs` clean; confirmed every new cross-reference anchor resolves against the actual generated HTML `id` attributes, not just assumed slugification; ran the task's exact three verification commands, including the ID/version grep gate, which produced no output as required. Nothing remains outstanding for this task.

### Session 2 — 2026-09-29

Addressed the Reviewer's FAIL finding (Stage 2, `quickstart/index.md`, ~line 180): the "`pi_agent_model` is the exception" sentence falsely implied `pi_agent_model` was uniquely exempt from `bob policy reload`'s restart-not-required framing, when in fact `pi_agent_cwd` (recommended in the bullet directly above) and `skill_install_path` (documented in the operator guide's pre-existing, unchanged "Fixed at startup, like `pi_agent_cwd`" text) share the exact same startup-only, restart-required behavior — confirmed against `policy_control::reload_snapshot`, which only ever re-reads and swaps the `[policy]` table for any key.

Reworded the paragraph to: state that `bob policy reload` only applies the policy-rule bullet above it in that list; keep the `[policy]`-table-only mechanism and the "bob reads the whole config once at `bob serve` startup" explanation exactly as the reviewer confirmed accurate; and explicitly cross-reference the existing `pi_agent_cwd` (`#pi_agent_cwd-service-wide`) and `skill_install_path` (`#install-the-skill-package`) operator-guide sections so the reader sees `pi_agent_model` shares this behavior rather than standing alone. Single-paragraph wording change, nothing else touched this session.

Verified both new cross-reference anchors resolve by building the book and grepping the generated HTML `id` attributes directly, rather than assuming slugification. Reran all three of the task's Verification commands from scratch: `mdbook build the-intern/docs` clean, both `grep -n "pi_agent_model"` invocations showing the expected lines in both files, and the ID/version grep gate producing no output against the actual `git merge-base dev-agent HEAD`. Nothing remains outstanding for this task.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-09-29

FAIL

Stage 1 (acceptance criteria) — checked the diff on
`task/T-229-document-pi-agent-model-manual` against `the-intern/docs/src/operator-guide/index.md`
and `the-intern/docs/src/quickstart/index.md`, cross-checked against
`crates/bob/src/serve.rs` (`warn_if_pi_agent_model_unset`, `try_start_subsystems`),
`crates/bob/src/config.rs` (`validate()`, `pi_agent_shared_args()`,
`model_selecting_flag_in`), `crates/pi-agent-supervisor/src/process.rs`
(`spawn_stderr_forwarder`, interactive-session cwd handling), and
`crates/policy-control/src/lib.rs` (`reload_snapshot`):

- AC-1 (process-settings table + unset/invalid behaviour): met. The new
  "pi-agent process settings" table's per-key pool-worker/interactive-session
  columns match `build_pi_agent_supervisor_config`/`build_interactive_session_config`
  exactly (`pi_agent_command` and `pi_agent_model` reach both; `pi_agent_args`
  reaches pool workers only; `pi_agent_cwd` reaches pool workers only, matching
  the pre-existing "Interactive `bob chat` uses the caller's working directory"
  section). The unset warning and the `pi_agent_args` rejection error are
  quoted verbatim from `warn_if_pi_agent_model_unset` and `validate()`. The
  invalid-value section's stderr-forwarding and audit-blind-spot claims match
  `spawn_stderr_forwarder` (warn-level, session-id-tagged, pool-worker-only)
  and the periodic dispatcher's `send_prompt_and_drain` error branch (no
  `record_periodic_fire_dispatched` or any other audit call on failure) — also
  consistent with T-228's live verification transcript.
- AC-2 (migration note): met. Placed under "Upgrading a running install",
  matches `model_selecting_flag_in`'s three flags and the exact
  `validate()` error string, with correct `{flag}` placeholder framing.
- AC-3 (confirming a model by hand): met. `pi --list-models`/`pi auth check`
  observed limits (fuzzy matching, no JSON mode, exit 0 on no match; provider
  credentials only, unknown model under a valid provider still reports ready,
  provider-less value misread as a provider name) match CR-015's "Verification
  commands" section verbatim in substance.
- AC-4 (quickstart recommendation + restart note) — **not met as written.**
  See Stage 2 finding below; the restart requirement itself is correct, but
  the surrounding claim overstates `pi_agent_model`'s uniqueness in a way that
  is inaccurate against this same guide's own documented behavior for the
  other two settings on that page.
- AC-5 (placeholders, no internal IDs/pi version): met. Reran the task's own
  verification commands (not just trusted the Work Log's "no output" claim):
  `mdbook build the-intern/docs` is clean, both `grep -n "pi_agent_model"`
  invocations show only the expected new lines, and the ID/version grep gate
  (`git diff -U0 "$(git merge-base dev-agent ...)" ... | grep '^+[^+]' | grep -nE
  "..."`) produced no output (exit 1) against the actual merge-base
  (`d5d7afd`). No real provider/model name leaked into any added line
  (checked separately with a `claude|anthropic|openai|gpt|opus|sonnet|gemini|llama`
  grep over the added lines).

Stage 2 (code quality, applied to docs — accuracy, clarity,
`coding-guidelines-skills.md` §1–2):

- **File and location:** `the-intern/docs/src/quickstart/index.md`, the new
  "**`pi_agent_model` is the exception.**" sentence (added right after the
  `bob policy reload` code block, ~line 180).
- **What is wrong:** This claims `pi_agent_model` is uniquely exceptional in
  not being covered by `bob policy reload`. It is not unique. The same
  quickstart bullet list recommends editing `pi_agent_cwd` immediately above
  it, and `skill_install_path` above that — and the operator guide's own
  `skill_install_path` section (pre-existing, unchanged by this diff) states
  "**Fixed at startup, like `pi_agent_cwd`.** ... Changing the
  `skill_install_path` config value itself requires restarting `bob serve`."
  I confirmed directly against `policy_control::reload_snapshot` (`the-intern/service/crates/policy-control/src/lib.rs`)
  that `bob policy reload` re-reads and swaps only the `[policy]` table —
  nothing else, for any key. So among the three settings this quickstart
  section tells the reader to edit before running `bob policy reload`
  (`skill_install_path`, `pi_agent_cwd`, `pi_agent_model`), *none* actually
  takes effect via that command; only a `[[policy.action_rules]]` edit does.
  Framing `pi_agent_model` as "the exception" strongly implies, to a reader
  who just set `pi_agent_cwd` per the bullet directly above, that their
  `pi_agent_cwd` edit *was* applied by the `bob policy reload` they just ran
  — which contradicts the operator guide's own documented behavior for that
  key.
- **What should change:** Rephrase to avoid the false-uniqueness implication.
  For example, note that `bob policy reload` only touches the `[policy]`
  table, so — like `pi_agent_cwd` and `skill_install_path` (cross-reference
  their existing operator-guide sections) — a `pi_agent_model` edit also
  needs a `bob serve` restart to take effect; reserve "applies without a
  restart" specifically for the policy-rule bullet in that list. The rest of
  the paragraph (the `[policy]`-table-only mechanism, the "reads the whole
  config once at startup" explanation, the restart requirement itself) is
  accurate and can stay as-is.

Everything else reviewed is accurate and well-written; this is a single,
narrow, actionable wording fix — no other Stage 1 or Stage 2 issues found.

### Review Verdict — 2026-09-29

PASS

Re-review (cycle 2), full Stage 1 + Stage 2 pass on
`task/T-229-document-pi-agent-model-manual` at `2b9578c` (on top of
`23e526f`; merge-base `d5d7afd`), using an isolated `git worktree` so this
`dev-agent` checkout stayed clean throughout.

**Fix scope.** `git diff 23e526f..2b9578c` touches only
`the-intern/docs/src/quickstart/index.md` (8 insertions, 6 deletions, one
paragraph) — exactly the cycle-1 finding's scope, no drive-by changes.
`git diff "$(git merge-base dev-agent HEAD)" HEAD --stat` for the whole
branch still touches only the two files listed under "Files to Touch."

**The reworded paragraph (cycle-1 finding).** Read the new paragraph in
context (the "Review the generated config" bullet list plus the `bob policy
reload` block, `the-intern/docs/src/quickstart/index.md` ~167-186). It now
reads: "`bob policy reload` only applies the policy-rule bullet above" (the
third bullet, "Replace the bootstrap-wide ... rules"), then explains that
`pi_agent_model` is mapped into the supervisor config once at `bob serve`
startup "like `pi_agent_cwd` ... and `skill_install_path`," so it also needs
a restart. This matches the reviewer's requested rewording exactly and
removes the false-uniqueness claim without introducing a new one. Verified
independently against the actual mechanism, not just re-trusting the Work
Log:
- `crates/policy-control/src/lib.rs`'s `reload_snapshot` reads the config
  file, extracts only the `[policy]` section via
  `load_policy_config_from_toml_str`, and swaps the `RulesetSnapshot` — it
  never touches `pi_agent_model`, `pi_agent_cwd`, or any other top-level key.
- `crates/admin-rpc/src/dispatch.rs` confirms `policy.reload` dispatches to
  `policy_control::Handle::reload`, i.e. `reload_snapshot` above — no other
  handler runs on that command.
- `crates/bob/src/serve.rs`'s `try_start_subsystems` calls
  `build_pi_agent_supervisor_config(cfg)` once, at startup, which is where
  `pi_agent_model` is mapped into the supervisor config (`pi_agent_shared_args`)
  — there is no re-invocation of this path from the policy-reload command.
  This corroborates "mapped ... once, at `bob serve` startup" precisely.
- The paragraph no longer singles out `pi_agent_model` as exceptional; it
  correctly groups it with `pi_agent_cwd` and `skill_install_path`, both of
  which share the identical startup-only behavior per the operator guide's
  own (unchanged) sections for those keys.

**Cross-reference links (verified by build, not by inspection).** Built the
book with `mdbook build the-intern/docs` (using the repo's existing debug
`bob` binary via `BOB_BIN` for the `cli-reference` preprocessor — same clean
build modulo the pre-existing, environment-level `mdbook-mermaid` version
warning that also reproduces on unmodified `dev-agent`, so it is unrelated to
this diff) and grepped the generated HTML directly:
- `the-intern/docs/book/operator-guide/index.html` contains
  `<h3 id="pi_agent_cwd-service-wide">` and
  `<h3 id="install-the-skill-package">` — exact matches for the two new
  anchors.
- `the-intern/docs/book/quickstart/index.html` renders the two links as
  `<a href="../operator-guide/index.html#pi_agent_cwd-service-wide">` and
  `<a href="../operator-guide/index.html#install-the-skill-package">` —
  both resolve to the anchors above. Neither link is dangling.

**Stage 1 (acceptance criteria), full pass:**
- AC-1 (process-settings table + unset/invalid behaviour): met, unchanged
  since cycle 1. Re-spot-checked the exact warning string in
  `warn_if_pi_agent_model_unset` (`crates/bob/src/serve.rs`) and the
  `model_selecting_flag_in` rejection string (`crates/bob/src/config.rs`)
  against the operator-guide prose — both quoted verbatim.
- AC-2 (migration note): met, unchanged since cycle 1. Confirmed the note
  under "Upgrading a running install" still carries the exact `validate()`
  error string and references `pi_agent_model`.
- AC-3 (confirming a model by hand): met, unchanged since cycle 1 — the
  `pi --list-models`/`pi auth check` observed-limits prose is untouched by
  this cycle's fix.
- AC-4 (quickstart recommendation + restart note): **now met.** The
  recommendation to set `pi_agent_model` alongside `pi_agent_cwd` is
  unchanged; the restart-required claim is intact; the false-uniqueness
  framing flagged in cycle 1 is gone and the replacement text is verified
  accurate against the actual code paths above.
- AC-5 (placeholders, no internal IDs/pi version): met. Reran the task's own
  ID/version grep gate against the actual `git merge-base dev-agent HEAD`
  (`d5d7afd`) on the branch tip (`2b9578c`) — no output (grep exit 1, so the
  `!`-negated gate passes). Also reran a
  `claude|anthropic|openai|gpt-|opus|sonnet|gemini|llama` sweep over every
  added line in both files — no output; only the `<provider>/<model-id>`
  placeholder appears.

**Stage 2 (code quality, applied to docs):** the new wording is accurate,
unambiguous, and consistent with the rest of the guide's terminology
(`[policy]` table, "reads the whole config once at startup"). No new
readability, correctness, or guideline issues found. No unrelated changes
bundled with the fix.

**Full Verification section, rerun from scratch on the branch tip:**
- `mdbook build the-intern/docs` — clean (see build note above).
- `grep -n "pi_agent_model" the-intern/docs/src/operator-guide/index.md the-intern/docs/src/quickstart/index.md` — all expected lines present in both files.
- `! git diff -U0 "$(git merge-base dev-agent HEAD)" -- the-intern/docs/src/operator-guide/index.md the-intern/docs/src/quickstart/index.md | grep '^+[^+]' | grep -nE "\b(T|B|S|CR)-[0-9]{3}\b|ADR-[0-9]{3}|#[0-9]{2,}|\b[0-9]+\.[0-9]+\.[0-9]+\b"` — no output, gate passes.

No further issues found. This task is complete.
