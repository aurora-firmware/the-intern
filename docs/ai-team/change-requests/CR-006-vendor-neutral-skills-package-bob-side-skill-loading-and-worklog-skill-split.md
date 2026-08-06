---
id: CR-006
title: Vendor-neutral skills package, bob-side skill loading, and worklog skill 
  split
status: pending
created: '2026-08-06'
---

# Vendor-neutral skills package, bob-side skill loading, and worklog skill split

## Desired Changes

### 1. Skills load from bob, not from the working directory

Every pi-agent session bob spawns must have the shipped skills available
regardless of that session's working directory. bob gains a configuration key
naming the skill install location(s) and passes each to pi as `--skill` on all
three spawn paths — pooled RPC workers, interactive chat, and scheduled
periodic jobs.

Today skills reach pi-agent only through cwd-relative auto-discovery, so a
session's skills depend entirely on where it happens to run, and a scheduled
job's per-entry working directory must contain a full deployed copy of the
package.

`[TODO: confirm whether pi's --skill accepts a directory containing multiple
skills or requires one path per skill. A probe against pi 0.80.3 was started
but killed before returning; this must be verified during task work, not
assumed.]`

### 2. One skill set, always active

All shipped skills load on every session bob spawns, including interactive
chat. There is no separate scheduled-only skill set and no runtime
delivery-kind detection: a session either has a skill or it does not, decided
by bob at spawn time.

### 3. Worklog becomes its own skill

Extract a new `worklog` skill that is generic and carries no email-specific
content. It owns the entire diary mechanic:

- diary location, which remains the running session's own working directory
  (`<cwd>/worklog/<YYYY-MM-DD>.md`) — unchanged from today;
- the per-entry format (`Done` / `Left` / `Next`);
- creating the directory and the day's file when either is missing;
- detecting a calendar day's first executed run;
- reconciliation: walking back to the most recent diary file that still holds
  open items, and carrying those items forward;
- how an open item closes.

The skill's own policy is to journal work actually performed. A session in
which nothing was done writes no entry.

`email-triage` keeps only the email-specific half: detect unseen mail,
classify, act or escalate, and retry an action that reconciliation carried
forward as blocked. Its current first-run/reconcile step and its record-an-entry
step reduce to delegation to the `worklog` skill.

### 4. One canonical skill source, thin per-vendor packaging

The package is restructured so the skill content exists exactly once and is
usable by more than one agent vendor:

```
the-intern/skills/
├── README.md                    # repo/operator-facing package documentation
├── skills/                      # canonical, vendor-neutral skill content
│   ├── himalaya/
│   ├── email-triage/
│   └── worklog/
├── packaging/
│   ├── claude/                  # Claude Code plugin manifest + link to ../../skills
│   └── pi/                      # pi package manifest + link to ../../skills
└── config/
```

Per-vendor directories carry manifests only and never duplicate content; they
reference the canonical tree. The package is renamed from
`the-intern/email-skills/` because it no longer ships only email skills.

Vendor neutrality requires dropping the optional `allowed-tools` frontmatter
key, whose separator differs between the two vendors. The tool discipline it
expressed is already stated in prose in `email-triage`'s "Tool usage" section,
which is also what the action-gate rules are written against.

`[TODO: confirm allowed-tools is genuinely optional in pi as well as in Claude
Code, and confirm the pi package manifest format — pi exposes package install
and a packages list in its settings, but the manifest schema is unverified.]`

### 5. Escalation survives a missing skill-local configuration

When the skill-local configuration file holding the manager escalation address
is missing, or its address is absent or malformed, the run must still escalate
rather than hard-stopping the message. The escalation is sent to the mail
account's own address, so it surfaces in the mailbox the human already reads.

The escalation email must additionally state that the configuration file was
missing and the directory where it was expected.

No diary requirement is stated in either skill for this case: the `worklog`
skill's general journaling discipline already records it.

This replaces the current behaviour, which treats a missing or malformed
address as a hard stop for every message needing escalation in that run.

`[TODO: confirm how the account's own address is obtained from the himalaya
CLI without new configuration.]`

### 6. Self-escalation must not loop

Because an escalation addressed to the account's own address arrives back in
the same mailbox as unseen mail, it re-enters triage on a later run. The
taxonomy needs a terminal category recognising the skill's own escalation
mail, which files it and never re-escalates it.

### 7. Content corrections from the PR #42 review

Five review comments on the current package, all of which survive the rework:

- **Remove every ai-team artifact identifier from skill content.** Skill
  consumers have no access to this project's specs, ADRs, tasks, or bugs. 91
  such references exist package-wide, 49 of them in skill files. The action-gate
  spec identifier alone appears 32 times and is behaviourally load-bearing, so
  these are rewrites into behavioural language, not deletions — the rules about
  what to do when a tool call is denied must survive intact.
- **Remove the spec identifier from the configuration template.**
- **Remove the "Adding a category" section.** Categories ship with the-intern's
  releases; a user's local edits to skill text would be overwritten on upgrade,
  so inviting them is misleading.
- **Remove the repository-packaging paragraph from the escalation reference.**
  What is committed versus templated is not actionable by the consuming agent.
- **Missing-configuration escalation**, covered in item 5 above.

The package README keeps its validation-provenance references: it is maintainer
and operator documentation, not skill content the agent consumes.

### 8. pi-agent version compatibility must be re-validated and recorded

The root README currently records the scheduled/periodic pi invocation as last
validated against pi **0.65.2**, while **0.80.3** is installed and the `--skill`
flag this change depends on comes from the newer line. Task work must validate
the affected pi-agent behaviour against the version actually in use and update
the README's compatibility section, which is the project's canonical record.
Per project convention, specs and ADRs must not pin pi-agent versions.

## Context

Two inputs drive this change.

**Operator requirements.** Skills must be available to bob's sessions
independently of the working directory; the worklog must be a separate skill
rather than a section of the triage skill, so that journaling applies to
scheduled work generally; and the skills must be usable from agent vendors
other than pi-agent, Claude Code in particular.

**PR #42 review.** Five inline review comments on the current package identified
content that must not ship to a skill consumer, a section that invites
user edits that upgrades would overwrite, and a failure path that hard-stops
where it should degrade.

The enabling capability is that the installed pi-agent exposes an explicit
`--skill` flag taking a path, so skill availability no longer has to be a
property of the session's working directory. bob already constructs process
arguments separately on each of its three spawn paths, so it can supply this
uniformly.

A packaging investigation found the two vendors' skill formats to be nearly
identical — same frontmatter keys, same relative-reference progressive
disclosure — differing only in discovery location, package manifest, and the
separator of the optional `allowed-tools` key. This is why a single canonical
source with thin per-vendor manifests is proposed over either duplicated
per-vendor products or folding the skills into the existing Claude Code
companion plugin. That companion plugin is developer tooling for operating
bob, with a different audience and release cadence from the Intern's own
runtime skills, and the current spec deliberately excludes changing it.

## Potential Impact

**Affected artifacts:**

- `S-010` — the primary spec amended by this change; see "Possible Spec
  Amendments" below.
- `the-intern/email-skills/` — renamed and restructured in full.
- `the-intern/service/` — bob configuration and all three pi spawn paths.
- Root `README.md` — pi-agent compatibility record.
- `docs/ai-team/docs/system_overview.md` and `the-intern-architecture.md` —
  `[TODO: confirm whether either describes cwd-relative skill discovery and
  needs correcting.]`
- The mdBook user manual at `the-intern/docs/` — operator deployment procedure
  changes materially.

**Risks and migration considerations:**

- **Existing deployments break.** The deployed-workspace procedure changes:
  skills move out of the per-job working directory. Any configured scheduled
  job depending on cwd-relative discovery stops finding its skills until the
  new install location is configured.
- **Action-gate rules must be rescoped.** The read rules admitting skill
  reference files currently name per-workspace paths; they must be rewritten
  against the single shared install path. This reduces and stabilises the rule
  set, but every existing deployment's rules need editing. Rules covering the
  diary and the skill-local configuration stay working-directory-relative.
- **The deployment permissions model relaxes.** Only the skill-local
  configuration file and the diary directory still require owner-only
  permissions; the skills themselves can be a read-only shared install rather
  than a mutable per-job copy.
- **Live re-validation is required.** The current package's happy path,
  escalation, denied-action, and skipped-tick continuity behaviours were
  validated live against a deployment whose shape this change alters. Task work
  must re-run that validation.
- **Interactive chat now journals.** With one always-active skill set, an
  interactive session creates a diary directory in the directory it was invoked
  from whenever work is actually performed there. This is intended, but it is a
  visible behaviour change for chat users.
- **A previously validated reply path remains unvalidated.** The package README
  already records that the direct-request and meeting-scheduling reply shapes
  are statically verified but not live-validated. This change does not close
  that gap and must not be read as doing so.

## Possible Spec Amendments

> **Architecture Consistency Review (2026-08-06): FAIL.** The binding set (13
> accepted ADRs, 9 approved specs) was checked and the blast radius is wider
> than this change request initially assumed: `S-001`, `S-002`, `S-003`, and
> `S-004` are directly contradicted, not only `S-010`. `ADR-012` §7 drifts.
> Two gaps were found that no binding artifact resolves. Findings are recorded
> in the subsections below.

### S-001, S-002, S-003, S-004 — cwd-relative discovery is asserted in four approved specs

Four approved specs, not just `S-010`, record cwd-relative auto-discovery as
*the* mechanism by which skills reach pi-agent:

- **`S-001` Component 3, third bullet** — "Skills reach pi-agent by its own
  cwd-relative auto-discovery — `AGENTS.md`/`CLAUDE.md` and skill files found
  in the process working directory". The bullet's other claim, that skills do
  not arrive through the extension, remains true under this change.
- **`S-003` Exclusions, "Agent skills"** — same mechanism claim. The exclusion
  itself, that skills are out of scope for the extension spec, is unaffected.
- **`S-004` Exclusions, "Agent skills"** — same mechanism claim. Its companion
  assertion, that every `bash` call a skill makes still passes through the
  action gate, is preserved by this change and needs no amendment.
- **`S-002` Configuration** — advises operators to set an explicit workspace so
  that pi's context files, skills, and relative-path resolution are
  predictable. Skills stop being a function of the workspace. `S-002` also owns
  bob's configuration surface, so the new skill-path key must be admitted
  there, as a flat `snake_case` key per `ADR-002` rather than a subsystem table.

**Note for the human:** `S-001`, `S-003`, and `S-004` were amended on
2026-08-01 in a coordinated correction that established precisely the
cwd-relative wording this change reverses. Re-reversing a five-day-old
correction across three specs warrants explicit sign-off rather than routine
in-place amendment.

### ADR-012 §7 — trust rationale drifts

`ADR-012` §7 justifies treating the working directory as a trusted, un-checked
input partly "because pi auto-loads `AGENTS.md`/`CLAUDE.md` and skills from the
working directory". The decision itself still stands on the context-file and
prompt-file grounds, and operators must still keep both owner-only. Only the
"and skills" clause becomes stale for bob-spawned sessions. This is drift
rather than reversal, and is the Architect's to amend or supersede.

### Gap 1 — the skill install path is a new trusted input that nothing governs

This change introduces a shared skill install path that bob reads and passes to
every session. No binding artifact defines its ownership or permission
requirements, its default location, or what bob does when it is absent.

`CR-003` is a direct structural precedent and should be mirrored: bob supplies
the pi extension by path, defaulting to the XDG data bucket per `ADR-009`,
overridable by a `config.toml` key, and **fail-closed** when absent because the
extension is the security membrane.

Skills are *not* a security membrane, so the absence behaviour should likely
differ — a session with no skills is degraded but still useful, arguing for
fail-open with a warning rather than refusing to launch.
`[TODO: confirm the absence behaviour and the default install location; this
change request does not decide either.]`

### Gap 2 — always-active journaling widens the action-rule surface

`ADR-010` exempts interactive chat from pre-flight admission but records that
the action gate "remains fully in force" for those sessions. With one
always-active skill set, a chat session's diary writes are therefore gated in
whatever directory chat was invoked from. Admitting them needs a rule broad
enough to cover arbitrary working directories, which sits against `S-004`'s
allow-only, narrowly-matched rule model.

No binding artifact resolves this. `[TODO: decide whether chat-session
journaling is admitted by a broad rule, confined to configured directories, or
whether the always-active decision should be revisited for the chat path only.]`

### Checked and consistent

`ADR-004`, `ADR-006`, `ADR-008` §4 and §5, and `S-009` were checked and are not
contradicted. Polling-driven email via a scheduler-driven skill, fire-and-forget
periodic semantics, the skipped-tick reasoning the diary reconciliation depends
on, and actions using the user's own credential stores — which is exactly what
the account's-own-address fallback relies on — are all preserved.

### S-010 amendments

`S-010` requires amendment in at least these places, all of which the current
text states explicitly and this change contradicts:

- **Design Principles — "No bob-core or bob-service changes."** This change
  adds bob configuration and modifies all three pi spawn paths. This is the
  most significant departure and the reason this change request exists.
- **Design Principles / Architecture — cwd-relative skill discovery.** Skills
  are loaded explicitly by bob; only the diary and the skill-local
  configuration remain working-directory-relative.
- **Component 3 — category extensibility.** The spec presents adding a category
  as a supported extension point; the review requires that categories ship with
  releases instead.
- **Components — a fourth skill.** The worklog is currently spec'd as a data
  artifact of the triage skill, not as a skill in its own right.
- **Escalation behaviour on missing configuration** — currently a hard stop,
  now a degraded escalation to the account's own address.
- **Exclusions — the Claude Code companion plugin.** The exclusion should be
  restated: this change still does not modify the companion plugin, but it does
  introduce a separate Claude Code packaging target, which the current wording
  could be read as forbidding.

**Whether a separate new spec is also warranted is an open question for the
Architect.** Bob-side skill loading is arguably a new capability rather than an
amendment to a skills-content spec, and this change request deliberately does
not decide that. `[TODO: Architect to determine whether the bob-side loading
mechanism and multi-vendor packaging belong in a new spec, with this change
request reduced to the S-010 content amendments.]`

One further `S-010` note: the skipped-tick reasoning the diary reconciliation
depends on (`ADR-006`, `S-002`, `S-009`) is unchanged by this request, but the
reconciliation text moves into a new skill and must not lose it in transit.

### Corrections routed

| Artifact | Owner | Action |
|---|---|---|
| `S-001` | Planner | Approved-spec amendment — Component 3 third bullet; Amendment Log entry |
| `S-002` | Planner | Approved-spec amendment — Configuration section, plus the new config key |
| `S-003` | Planner | Approved-spec amendment — Exclusions mechanism clause |
| `S-004` | Planner | Approved-spec amendment — Exclusions mechanism clause |
| `S-010` | Planner | Approved-spec amendment — the sections listed above |
| `ADR-012` | Architect | Amend §7's rationale, or supersede with a new ADR |
| Skill-loading mechanism | Architect | Decide whether a new ADR is warranted, mirroring `CR-003`/`ADR-009` |
| Gap 1 and Gap 2 | Architect / Human | Decide install path, absence behaviour, and the chat-journaling rule surface |

**Whether a separate new spec is also warranted is an open question for the
Architect.** Bob-side skill loading is arguably a new capability rather than an
amendment to a skills-content spec, and this change request deliberately does
not decide that. `[TODO: Architect to determine whether the bob-side loading
mechanism and multi-vendor packaging belong in a new spec, with this change
request reduced to the S-010 content amendments.]`
