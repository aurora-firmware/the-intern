---
title: Vendor-neutral skills package and bob-side skill loading
version: '0.1'
status: approved  # draft | review | approved | superseded
created: '2026-08-06'
author: planner
id: S-011
---

# Vendor-neutral skills package and bob-side skill loading

## Purpose

A session's skills currently depend entirely on the directory it happens to run
in: a scheduled job has skills only if its per-entry working directory holds a
full deployed copy of the skill package, and an interactive chat session started
anywhere else has none at all. That forces the package to be duplicated into
every working directory that needs it, multiplies the authorization rules
admitting skill reference reads by one set per deployment, and makes the diary
discipline that gives scheduled work continuity available only to the one job
whose directory contains it. The pi-agent line now in use can load a skill from
an explicit path, so this constraint is no longer necessary. When this work is
done, every session bob spawns carries the same skills regardless of working
directory; the daily worklog is a skill in its own right rather than a section
of the email-triage skill; and the skill content is packaged so a second agent
vendor can consume it without a second copy of the content existing.

Success is confirmed when a session started from a directory containing no
skill files can still perform a skilled task, when the canonical source carries
no vendor-specific layout so a second vendor target can be added whenever a
consumer for one exists, and when a scheduled run and an interactive session
both journal through the same worklog skill.

## Exclusions

What this specification explicitly does NOT cover:

- **Email triage policy content.** The triage loop, category taxonomy,
  escalation rules, and their corrections are `S-010`'s and `CR-006`'s scope.
  This specification moves and restructures skill content; it does not decide
  what the email skills say.
- **Changes to the Claude Code companion plugin.** That plugin is developer
  tooling for operating the service, with a different audience and release
  cadence from the Intern's runtime skills. This specification introduces a
  separate packaging target for the same vendor; it does not modify or absorb
  the companion plugin.
- **Duplicated per-vendor skill products.** Shipping one copy of the content
  per vendor was considered and rejected: the content is validated policy
  prose, and a second copy would drift and would require re-validating the
  authorization rules against it.
- **Two skill sets split by delivery kind.** A configuration separating
  always-on skills from scheduled-only skills was considered and rejected in
  favour of a single always-active set; see `ADR-014` Alternative C.
- **Runtime delivery-kind detection inside a skill.** A skill does not inspect
  its environment to decide whether it is running under a scheduled firing. What
  a session was given is decided at spawn time.
- **Installing skills into a vendor's own global discovery directory.**
  Rejected in `ADR-014` Alternative B: it gives the Intern's operating
  instructions to every session of that vendor on the machine, including
  sessions the service neither supervises nor authorizes.
- **Moving worklog storage out of the working directory.** Considered and
  rejected: continuity must stay reconstructable from the job's own working
  directory. Only skill discovery moves.
- **A bob-side reader or parser of skill content.** bob supplies a path. It does
  not read, validate, or understand skill files.
- **Supplying skills as command-line arguments to the agent process.**
  Considered and rejected in `ADR-014` Alternative A: it adds a second delivery
  mechanism alongside the one the service already owns for its extension,
  requires the same logic on three spawn paths, and carries more version
  exposure than the extension event this specification uses.
- **Relaxing the action-authorization gate.** Every tool call a skill makes
  still passes the existing gate. This specification grants no new authority.

## Architecture

### Design Principles

- **A session's skills must not depend on its working directory.** Two sessions
  spawned by the service with different working directories must be given the
  same skills.
- **Skill content must exist exactly once in the repository.** Any per-vendor
  packaging must carry manifests and layout only, never a second copy of the
  content, so a correction applies everywhere by construction.
- **Continuity must remain reconstructable from the job's own working
  directory.** No service-side session or queue state may be relied on to
  remember what a previous scheduled firing did.
- **The diary mechanism must carry no domain knowledge.** Whatever owns the
  worklog must be usable by work that has nothing to do with email.
- **Missing skills must degrade a session, not prevent it.** Skills are
  instructional content, not the authorization membrane, so their absence must
  not stop a session from starting.
- **The skill install path is a trusted, un-checked input.** The design must
  state this exposure explicitly rather than implying a check the service does
  not perform (`ADR-014` §7).
- **Skill content must not reference this project's internal artifacts.**
  Consumers have no access to its specifications, decision records, tasks, or
  bugs, so skill text must be intelligible without them.
- **Every tool call a skill makes remains subject to the existing action gate.**

### System Diagram

```
       repository (single source of truth)
       skills/  ──┬── himalaya      (CLI reference)
                  ├── email-triage  (triage policy)
                  ├── worklog       (diary discipline, domain-free)
                  └── tasks         (task board discipline, domain-free)
                        │
         ┌──────────────┴──────────────┐
         │ packaging (manifests only)  │
         │          pi target          │
         └──────────────┬──────────────┘
                        │ install
                        v
            skill install path (XDG data bucket)
                        │
                        │ bob resolves path → environment
                        v
    ┌───────────────────┴───────────────────┐
    │            bob spawn paths            │
    │  RPC worker   interactive chat   scheduled job
    │   (all three already carry the extension)
    └───────────────────┬───────────────────┘
                        v
                 pi-agent session
                        │
                        │ pi fires resources_discover at session init
                        v
              bob extension answers with the skill path
                        │
                        │ pi extends resources, rebuilds system prompt
                        v
                 skills in effect before the first turn
                   (regardless of cwd)
                        │
                        │ writes, relative to its own cwd
                        v
        <cwd>/worklog/<date>.md   +   <cwd> skill-local config
```

### Responsibility Separation

| Component | Responsibility | Notes |
|---|---|---|
| Canonical skill source | Holds every skill's content exactly once, vendor-neutral | Consumed by all packaging targets; carries no vendor-specific layout |
| Packaging target | Present the canonical content in the supported vendor's expected layout | Manifests and layout only; must contain no content of its own. One target exists today; the requirement applies to any target added later |
| Skill install path | The deployed, read-only location bob resolves and makes available to its extension | A trusted, un-checked input; operator-protected by filesystem permissions |
| bob service | Resolve the install path and make it available to the extension on every session spawned | Uses the existing per-session environment contract; bob never reads skill content |
| bob extension | Answer pi's resource-discovery event with the resolved skill path | Already supplied on all three spawn paths and already subscribed to the event; governed by `ADR-014` |
| `worklog` skill | Owns when and how a session uses the diary, and the item-identifier convention | Domain-free; defers to the `bob worklog` command for entry format, first-run detection, and reconciliation rather than restating them (S-015) |
| `email-triage` skill | Owns detection, classification, and the act-or-escalate decision | Delegates all diary mechanics to `worklog`; retains retry of a carried-forward blocked action |
| `himalaya` skill | Owns CLI reference knowledge | Carries no triage policy; unchanged in role |
| `tasks` skill | Owns the task-board discipline: when work belongs on a board, how to describe it so a later run can pick it up cold, and what each status commits to | Domain-free; defers to the `bob task` command for the file format rather than restating it (S-014) |
| Action-authorization gate (existing) | Gates every tool call a skill makes | Unmodified; admitting rules are an operator deployment concern |

## Components

### Component 1: Canonical skill source

**Purpose:** Hold the content of every shipped skill exactly once, in a layout
that belongs to no particular agent vendor.
**Estimated size:** Medium — largely relocation of existing content, plus the
removal of the one frontmatter field whose format differs between vendors.
**Interfaces:** Exposes skill content as instruction documents with relative
references; consumed by every packaging target and, once installed, by the
sessions bob spawns.

### Component 2: Packaging target

**Purpose:** Present the canonical content in the layout and with the manifest
the supported vendor expects.
**Estimated size:** Small — one manifest plus the linkage to the canonical
source, per target.
**Interfaces:** Exposes a vendor-installable package; consumes the canonical
skill source. Must be verifiable as containing no independent copy of the
content. One target exists; the canonical source stays free of vendor-specific
layout so a second can be added when a consumer for one exists.

### Component 3: bob-side skill supply

**Purpose:** Resolve the configured skill install path, make it available to
the extension on every session the service spawns, and have the extension
answer pi's resource-discovery event with it.
**Estimated size:** Small — one configuration key with its absence behaviour,
one addition to the existing per-session environment contract, and answering an
event the extension already subscribes to.
**Interfaces:** Consumes service configuration and the installed skill path;
exposes no new external interface. Governed by `ADR-014`.

### Component 4: `worklog` skill

**Purpose:** Teach a session when and how to use the `bob worklog` command —
the item-identifier convention and when a run should call `append` vs
`list` — with no reference to email or any other domain. Entry format,
first-run detection, and reconciliation are owned by the command itself
(S-015), not restated here.
**Estimated size:** Medium — extraction of existing validated content, with its
domain-specific parts left behind.
**Interfaces:** Exposes usage guidance to any consuming skill; consumes the
`bob worklog` command. Its only state is files under the session's own
working directory, owned by the command.

### Component 5: `email-triage` skill, reduced

**Purpose:** Retain detection, classification, and the act-or-escalate decision
while delegating all diary mechanics to the `worklog` skill.
**Estimated size:** Small — removal and delegation, not new behaviour.
**Interfaces:** Consumes the `worklog` skill's discipline, the `himalaya`
skill's CLI knowledge, and its own skill-local configuration.

## Workflow

```
Operator installs the skill package to the skill install path
  ↓
★ Operator configures the install path, or accepts the default
  ↓
★ Operator adds action rules admitting the skills' tool calls
  ↓
bob starts and resolves the skill install path
  → path missing or empty: log a warning and continue without skills
  ↓
A session is requested — scheduled firing, interactive chat, or queued work
  ↓
bob spawns pi with its extension, whatever the session's cwd
  ↓
pi fires resource discovery; the extension answers with the skill path
  → path missing or empty: contribute nothing, session continues without skills
  ↓
pi extends its resources and rebuilds the system prompt before the first turn
  ↓
Session has himalaya, email-triage, and worklog available regardless of cwd
  ↓
Work is performed; every tool call passes the action-authorization gate
  → a call is denied: the outcome is recorded, never worked around
  ↓
Work actually performed is journaled per the worklog skill,
  into the session's own working directory
  ↓
A later session reconciles carried-forward open items from that same directory
```

## Configuration Requirements

**Skill install path**

- **What must exist:** a single setting naming the directory from which the
  service supplies skills to every session it spawns. Without it the service
  cannot give a session skills independently of that session's working
  directory, which is this specification's core requirement.
- **Where it lives:** the service's existing configuration file, as a flat
  top-level key consistent with the project's established configuration
  convention (`ADR-002`) — not a new subsystem table. The resolved value
  reaches the extension through the existing per-session environment contract,
  alongside the session identifier and extension socket path already supplied
  there.
- **Constraints:** must be an absolute path when set, consistent with how the
  service's other path settings are constrained. Its contents are loaded into
  every session the service spawns, so it is security-relevant: it must be
  under the same owner-only protection the working directory already requires,
  enforced by filesystem permissions rather than a service-side check
  (`ADR-014` §7).
- **Missing-value behaviour:** unset falls back to a default location in the
  read-only application-asset area of the service's filesystem layout
  (`ADR-009`), alongside the extension. A set-but-missing or empty path is
  **fail-open** (`ADR-014` §4): the extension contributes no skill paths and
  warns. It must not prevent the session from starting, and it must not fail
  service startup.

**Action rules admitting skill tool calls**

- **What must exist:** rules admitting the tool calls the shipped skills make —
  reads of skill reference content at the install path, and the worklog's
  `bob worklog append`/`list` invocations (S-015).
- **Where it lives:** the existing action ruleset, as ordinary operator
  configuration.
- **Constraints:** rules admitting reads of skill reference content are scoped
  to the single install path and are therefore stable across deployments,
  replacing today's per-working-directory rules. **Formerly accepted risk,
  retired by S-015 for worklog writes:** because the skill set is always
  active, an interactive session journals into whatever directory it was
  started from; before S-015 this meant the rule admitting worklog writes
  had to be broad enough to cover arbitrary working directories, a
  deliberate departure from the narrowly-matched rule shape the action
  model otherwise favours. S-015's `bob worklog` command never places the
  working directory in its own invocation text, so the admitting rule is
  now narrowly matched on the command's fixed prefix instead — see S-015
  Configuration Requirements.
- **Bootstrap profile exception:** CR-007 permits `bob init` to generate
  no-matcher rules for exactly `bash`, `read`, `write`, and `edit` as a
  deliberately broad first-run profile. This is an operator-usability
  exception, not a replacement for the normal install-path-scoped reference
  reads and worklog guidance above; the generated config must disclose the
  authority and direct later narrowing.
- **Missing-value behaviour:** absent rules deny, as the action model already
  requires. A denied call is recorded by the skill and never worked around.

**Skill-local configuration and worklog storage**

- **What must exist:** unchanged from today — the skill-local configuration
  file and the daily worklog remain relative to the session's own working
  directory.
- **Where it lives:** the session's working directory.
- **Constraints:** both remain owner-only. The skill package itself no longer
  needs to be a mutable per-job copy, so only these two remain
  permission-sensitive per deployment.
- **Missing-value behaviour:** governed by `S-010` and `CR-006`, not by this
  specification.

**pi-agent version**

- **What must exist:** a recorded, validated pi-agent version providing the
  extension resource-discovery capability this specification depends on, and a
  reconciled record of the versions actually in use.
- **Where it lives:** the repository README's compatibility section, which is
  the project's canonical version record. Specifications and decision records
  deliberately do not pin versions. The extension's own automated compatibility
  test enforces the pinned extension API version independently.
- **Constraints:** three version records currently disagree — the pinned and
  test-enforced extension API version, the installed agent CLI version, and the
  older version recorded as validated for the scheduled invocation path. The
  capability is present in both the pinned extension API version and the
  installed CLI, so the requirement is reconciliation and revalidation rather
  than an upgrade blocker.
- **Missing-value behaviour:** if the version actually in use does not provide
  the capability, this specification's core requirement cannot be met and the
  work is blocked rather than worked around.

## Implementation Order

| Phase | What | Depends On |
|---|---|---|
| 1 | Reconcile the three disagreeing pi-agent version records and update the README compatibility section. Confirm the extension resource-discovery event fires and its contributed skills reach the system prompt on all three spawn paths, including the non-interactive scheduled path. | Nothing |
| 2 | Restructure the package into a canonical vendor-neutral source with per-vendor packaging targets carrying no duplicated content. Includes removing the one frontmatter field whose format differs between vendors. | Nothing |
| 3 | Extract the `worklog` skill as a domain-free skill and reduce `email-triage` to delegate its diary mechanics. | Phase 2 |
| 4 | Add the service-side skill install path setting with its resolution and fail-open absence behaviour, extend the per-session environment contract with the resolved path, and answer the resource-discovery event in the extension. | Phase 1 |
| 5 | Update the operator-facing deployment procedure and the action-rule guidance to the install-path model, and re-validate the previously live-validated paths against the new deployment shape. | Phases 3, 4 |

## Amendment Log

| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| 2026-08-12 | Added the CR-007 `bob init` bootstrap exception allowing no-matcher rules for four named standard pi tools. | A fresh operator installation must work without manually discovering tool-call argument shapes; normal install-path-scoped and worklog guidance remains the recommended steady state. | S-012 tasks TBD |
| 2026-08-23 | The canonical skill set gains a fourth skill, `tasks`, in the System Diagram and the Responsibility Separation table. No principle, packaging target, install path, or delivery mechanism changes. | CR-009 / S-014. The command's operating instructions ship with the skills bob supplies through its extension rather than with operator tooling, so the set this specification defines grows by one. | Tasks TBD |
| 2026-08-23 | The Claude packaging target is removed, leaving the pi target as the only one. The Purpose's success criterion no longer requires the content to be loadable by two vendors, and now requires the canonical source to stay free of vendor-specific layout so a second target can be added when a consumer exists. Diagram, Component 2, and the packaging responsibility row follow. | CR-011. The Claude target demonstrated the two-vendor principle rather than serving a consumer, and carrying it through CR-010's rename and S-014's fourth skill would cost work on output nobody installs. The canonical-source layer is deliberately kept so re-adding a vendor stays cheap. | Tasks TBD |
| 2026-08-27 | The `worklog` skill row and Component 4 no longer claim the skill itself owns entry format, first-run detection, or reconciliation — it now defers to the `bob worklog` command for those, the same way this table already describes `tasks` deferring to `bob task`. The "Action rules admitting skill tool calls" section's worklog line now names `bob worklog append`/`list` invocations instead of raw "directory checks, reads, and appends", and its accepted risk that the admitting rule "must be broad enough to cover arbitrary working directories" is marked retired for worklog writes, since the command's invocation text never carries the working directory. | S-015 approval. The worklog mechanics move from skill prose into a real command, mirroring S-014's earlier move for the task board; the working directory dropping out of the command's own text is what lets the admitting rule narrow. | S-015 breakdown tasks (Gate 2 pending). |
