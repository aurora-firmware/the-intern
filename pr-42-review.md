# PR Review: aurora-firmware/the-intern#42 — docs(email): add validated email triage workflow

## Summary

This PR ships the `email-skills` package (S-010): an `email-triage` pi-agent
skill plus its `himalaya` CLI-reference skill, the specs/tasks (S-010,
T-131–T-141) that designed and validated it, and a new operator-guide section
documenting deployment. It's a large, almost entirely documentation/config
change (32 files, +4764/-23, no Rust source touched) that represents genuinely
careful, iteratively live-validated work — the T-139/T-140 work logs show real
debugging against a live mailbox and a live `bob` policy engine, not just
prose. That said, review surfaced **2 critical** findings (one a real command-
injection path, one a shipped-but-non-functional feature), **2 warning**, and
**2 suggestion**-level findings, all confirmed by direct inspection of the
repo (not just the diff).

**Status as of this update:** 4 of 6 findings closed with a direct fix
(#3, #4, #6) or mitigated pending a real fix (#2). 1 finding (#1, the
command-injection path) is still open with no fix applied. 1 finding (#5,
the stale-path suggestion) is still open, not yet addressed.

| # | Finding | Status |
|---|---|---|
| 1 | [critical/security] Unescaped shell interpolation in escalation send | **Open** — not addressed |
| 2 | [critical/docs] Missing S-004 rule for `direct-request`/`meeting-scheduling` replies | **Mitigated + tracked** — caveats added to operator-guide and README; real fix (rule + live validation) filed as `B-029` |
| 3 | [warning] `read` vs `read_file` inconsistency | **Fixed** — stale `read_file` example corrected to `read` |
| 4 | [warning] Unreconciled pi-agent version numbers | **Fixed** — root README's canonical compatibility section now has a third entry (0.65.2, scheduled/periodic invocation); package README defers to it |
| 5 | [suggestion] Stale `project/specs/` path | **Open** — not addressed |
| 6 | [suggestion] Non-verbatim ADR-008 §5 quote | **Fixed** — quotation marks removed in S-010 and T-134 |

| Scope | Files | Lines changed | Tier | Findings |
|---|---|---|---|---|
| Documentation | 30 | ~4,767 | full | 5 |
| Security (cross-cutting, subset of the above) | 14 | ~1,743 | full | 1 |
| Source | 2 | 20 | lite | 0 |

## Findings

### Security

#### [critical] Untrusted email content is interpolated unescaped into a shell command string, admitted by a permissive glob allow-rule — `the-intern/email-skills/.pi/skills/email-triage/SKILL.md:155`

**Status: Open.** Not addressed in this pass — fixing this properly means
either adding a documented shell-escaping step or restructuring the send
path to avoid hand-built shell strings, which touches the skill's core
send/escalate behavior and its live-validated command shapes. That's
implementation work, not a documentation correction, and needs its own
task through the normal process rather than an ad hoc edit.

`SKILL.md` (step 3.3) and `references/escalation.md` (lines 52–56, 63–65)
require every escalation to run a literal shell pipeline built by splicing
the original message's **subject** and a **summary/excerpt of its body** —
both attacker-controlled, since low-confidence classification is exactly the
path a hostile or ambiguous email reaches — into single-quoted arguments:

```
himalaya template write -H 'To:<manager_address>' -H 'Subject:Escalation: <subject>' '<body>' | himalaya template send
```

No file in the package documents any shell-escaping/quoting rule for content
interpolated this way (grepped the whole package for `escap|quot|sanitiz`;
the only hits are unrelated "quoted original body" email-quoting prose). The
same unescaped-interpolation pattern is documented again in
`himalaya/references/command-reference.md:166-224` for `template reply`/
`template forward`/`template write`, using `"$(himalaya template reply 42
'...')"` shaped examples.

This is reachable in the exact configuration this PR ships, not theoretical:
the S-004 allow-rule the operator-guide instructs operators to add
(`the-intern/docs/src/operator-guide/index.md:892`) is

```
pattern = "himalaya template write -H *To:* -H *Subject:Escalation:* *| himalaya template send*"
```

I read `service/crates/policy-control/src/matcher.rs` directly: `ArgMatcher`
does a plain `WildMatch` glob (`*` = any run of characters) over the entire
`command` string field — there is no structural argument parsing or
escaping-awareness. `*` matches shell metacharacters (`;`, `` ` ``, `$()`,
quotes) just as readily as ordinary text, so the rule constrains only the
literal substrings around the wildcards, not what an attacker can place
between them. A subject/body containing `'; curl ... ; echo '`-style content
would satisfy the glob and, once the outer shell interprets the assembled
command string, execute arbitrary commands as the scheduled job's OS user.

One caveat, noted for completeness: I could not confirm from this repo
whether pi's `bash` tool literally invokes `sh -c` on the string (the `pi`
binary is external to this repo) — but that is the standard implementation
for a tool named `bash`, and the `ArgMatcher` design (glob over an opaque
command string) only makes sense under that model.

**Suggested direction:** document a required shell-escaping step (e.g.
`'` → `'\''`) for any email-derived text before it is interpolated into a
`bash` command, or restructure the sink to avoid hand-built shell strings for
untrusted content entirely (e.g. write the body to a temp file and reference
it by path, or use `himalaya`'s templating without shell reassembly).

### Documentation

#### [critical] `direct-request` and `meeting-scheduling` replies have no matching S-004 allow-rule anywhere in the shipped configuration, and were explicitly skipped during live validation — `the-intern/docs/src/operator-guide/index.md:892`

**Status: Mitigated, real fix tracked as `B-029`.** A genuine fix requires
adding the missing allow-rule and live-validating `direct-request`/
`meeting-scheduling` against a real mailbox the way T-139/T-140 did — not
something achievable from a documentation pass. In the meantime, both
`the-intern/docs/src/operator-guide/index.md` and
`the-intern/email-skills/README.md` now carry an explicit warning right
after their rule lists stating these two categories are not covered and
will be silently blocked until `B-029` is resolved, so operators aren't
misled by the existing "verified"/"validated" framing.

Two of the five documented starter categories — `direct-request.md` and
`meeting-scheduling.md` — require sending a reply built via `himalaya
template reply` → `himalaya template send` (see `direct-request.md:12-16`,
`meeting-scheduling.md:31-42`). But neither the operator-guide's "Add scoped
S-004 action rules" section (lines 806-935) nor `email-skills/README.md`'s
"Verified S-004 action rules for the happy path" (lines 128-230) include an
allow-rule matching that command shape — the only `template`-related rule
either document ships is the escalation-send rule
(`operator-guide/index.md:892`, quoted above). An operator who deploys
exactly per this guide gets a scheduled job where `direct-request` and
`meeting-scheduling` replies are permanently denied by S-004's default-deny,
silently diverging from what `SKILL.md` and the category docs describe.

This isn't a hypothetical gap: `T-139`'s own Work Log (Session 2) says so
directly — *"The direct-request route was rejected because it required
recurring outbound mail authorization. A safe automated-notification route
[was used instead]"* — and the team never circled back to add the rule or
validate the reply categories in T-140 either (which covered escalation,
block, and continuity only). Neither `README.md`'s "Validation outcomes"
section nor `T-141` (whose whole purpose is documenting operator setup)
flags that 2 of 5 documented categories are unvalidated and unconfigured.

**Suggested fix:** add the missing `bash` allow-rule for the reply-send
command shape to both the operator-guide and README rule lists, live-validate
`direct-request` and/or `meeting-scheduling` the way T-139/T-140 validated
the other paths, and until then explicitly flag in the docs that these two
categories require additional operator configuration beyond what's given.

#### [warning] The operator guide gives two contradictory tool names for the same S-004 read rule — `the-intern/docs/src/operator-guide/index.md:812`

**Status: Fixed.** The line-429 example in "Tool-call authorization gate"
now reads `tool = "read"`, matching the live-validated rules elsewhere on
the page. (Note: an unrelated pre-existing `tool = "read_file"` example was
also found in `the-intern/docs/src/quickstart/index.md:154`, outside this
PR's diff — left untouched since it's out of scope for this PR, but it has
the same staleness and is worth a follow-up.)

The new "Deploying the email-triage scheduled job" section uses `tool =
"read"` for every read allow-rule (lines 812, 818, 824, 830, 836, 842, 848),
matching `email-skills/README.md` throughout. But the page's pre-existing
"Tool-call authorization gate" section (line 429, untouched by this PR) uses
`tool = "read_file"` for the identical concept, and the new section points
readers back to it ("It assumes the general policy model ... already
described in Policy basics"). I checked the Rust source
(`policy-control/src/{ruleset,engine}.rs`) and found `"read_file"` only in
unit-test literals — the engine treats tool names as opaque strings with no
fixed registry, so the source doesn't resolve the discrepancy either.
Given this PR's rules are backed by literal live-audit evidence (T-139/T-140
against a real `bob` instance), `read` looks correct and `read_file` looks
stale, but the page never says so — a reader who notices both will not know
which to trust.

**Suggested fix:** update the line-429 example to `read`, or add a note
explaining the discrepancy if `read_file` is intentionally different.

#### [warning] Three unreconciled pi-agent version numbers across the docs — `the-intern/email-skills/README.md:25`

**Status: Fixed.** The root `README.md`'s canonical "pi-agent Version
Compatibility" section now has a third entry — "Scheduled/periodic `pi`
binary" at **0.65.2**, citing T-139 — alongside the existing Extension API
(0.75.3) and Interactive `pi` binary (0.79.10) entries. The package README
no longer claims to be "the repository's current recorded pi version";
it now points readers to the root README's canonical section instead.
The 0.80.3 references in T-131–T-138's work logs are left as-is (accurate
historical record of the dev-environment version at the time).

This line declares pi **0.65.2** "now the repository's current recorded pi
version for this package." The root `README.md`'s "pi-agent Version
Compatibility" section — which both it and `CLAUDE.md` call the project's
*canonical* version record ("update this section" whenever the version
changes) — separately records **0.75.3** (extension API) and **0.79.10**
(interactive chat), untouched by this PR. T-131 through T-138's work logs
elsewhere reference **0.80.3**. Three numbers, no cross-reference reconciling
them, leaves an operator unable to tell which version applies to what.

**Suggested fix:** either fold the email-skills-specific finding into the
root README's canonical compatibility section with a note on scope, or
explicitly state why this package tracks a separate version.

#### [suggestion] Stale `project/specs/` path in a brand-new log entry — `ai-process-cli-reported-issues.md:11`

**Status: Open.** Not addressed — out of the set of findings the author
asked to fix in this pass.

The new entry (dated 2026-08-01) says affected specs are "present in
`project/specs/`," but that directory was renamed to `docs/ai-team/specs/`
on 2026-07-20 (commit `558458b`) — eleven days before this entry's date. This
PR's own `CLAUDE.md` diff fixes exactly this class of stale path elsewhere,
which makes this instance look like it was copy-pasted from an older entry
rather than written fresh against the current layout.

#### [suggestion] Quotation marks around a non-verbatim paraphrase of ADR-008 §5 — `docs/ai-team/specs/S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md:278`

**Status: Fixed.** Quotation marks removed in both places that presented
the paraphrase as a verbatim quote (S-010 spec and T-134); the text now
reads as plain paraphrase, consistent with how `escalation.md` and T-134's
other two mentions already phrased it. `S-010:288`'s separate, genuinely
verbatim quote of ADR-008 §5 was left untouched (it's accurate).

"ADR-008 §5's *'actions use their own configuration'* precedent" presents
this as a quote, but ADR-008 item 5 actually reads: *"Secrets. bob custodies
no secrets. Actions use the user's own existing credential stores under the
same uid..."* — the quoted phrase doesn't appear there verbatim; it's a
paraphrase. The same fabricated-looking quote is repeated in `T-134`'s
Description and in `escalation.md`, propagating it across three files. The
underlying point (action/channel config stays out of bob-core) is accurate —
only the quotation marks are misleading.

## Skipped files

None. No lock files, vendored code, minified/generated assets, or binaries
were present in this diff — all 32 changed files were reviewed.

## Review notes

- Documentation and security scopes were reviewed at **full tier**: agents
  read surrounding repo context (specs, ADRs, git history, and — for
  security — the actual Rust policy-control matcher source), not just the
  diff in isolation. The working tree was already checked out at the PR's
  exact head commit, so all context was read live rather than fetched.
- Source scope (`​.gitignore`, the example TOML) was reviewed at **lite
  tier** — diff only — but I additionally hand-verified the gitignore
  pattern's anchoring behavior and parsed the TOML directly; no issues.
- I (as coordinator) independently re-verified the security agent's finding
  by reading `matcher.rs` and the shipped policy rule myself before keeping
  it, and verified all four documentation findings by reading the cited
  files and git history directly. One additional finding (the missing
  `direct-request`/`meeting-scheduling` S-004 rule) was found during that
  verification pass and isn't in either sub-agent's original output.
- No patches were truncated; nothing in existing PR review comments (there
  were none) overlapped with anything reported here.
