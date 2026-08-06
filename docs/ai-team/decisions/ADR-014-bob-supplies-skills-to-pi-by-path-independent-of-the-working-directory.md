---
id: ADR-014
title: bob supplies skills to pi by path independent of the working directory
status: proposed
created: '2026-08-06'
---

# ADR-014: bob supplies skills to pi by path independent of the working directory

## Context

Skills reach pi-agent today only through pi's own working-directory-relative
auto-discovery. `S-001`, `S-003`, and `S-004` each record this as the
mechanism, and `ADR-012` §7 records the resulting trust relaxation: because pi
auto-loads context files and skills from the working directory, that directory
is a trusted, un-checked input whose protection is the operator's filesystem
permissions.

Three forces make that mechanism insufficient:

1. **A session's capabilities depend on where it happens to run.** A scheduled
   job only has skills if its per-entry working directory contains a full
   deployed copy of the skill package. An interactive chat session started from
   any other directory has none. The same service therefore behaves differently
   depending on an operator's directory choice.
2. **The package must be duplicated per job.** Every working directory that
   needs skills needs its own copy, so a skill correction must be redeployed to
   each one, and each copy is separately subject to the ownership requirements
   `ADR-012` §7 imposes.
3. **The authorization rules admitting skill reference reads are
   working-directory-scoped**, so they multiply with deployments rather than
   being written once.

The enabling change is that the pi-agent line now in use exposes an explicit
flag that loads a skill from a given path, so skill availability no longer has
to be a property of the working directory. bob already constructs process
arguments separately on each of its three spawn paths — pooled RPC workers,
interactive chat, and scheduled periodic jobs — so it can supply skills
uniformly across all three.

`CR-003` already decided this exact shape for the other artifact bob hands to
pi: bob supplies its extension by path, defaulting to a location in the XDG
data bucket per `ADR-009`, overridable by configuration. This decision extends
that established pattern from the extension to skills.

## Decision

**bob supplies skills to pi by path on every session it spawns, independent of
that session's working directory.**

1. **Uniform across all three spawn paths.** Pooled RPC workers, interactive
   chat, and scheduled periodic jobs all receive the same skills. A session
   either has a skill or it does not, decided by bob at spawn time; there is no
   runtime delivery-kind detection inside a skill.

2. **Default installation location.** Skills default to a directory in the XDG
   `data` bucket alongside the extension, per `ADR-009`, which is the bucket for
   read-only architecture-independent application assets — which is what skill
   content is. The location is overridable by a `config.toml` key, expressed as
   a flat `snake_case` key per `ADR-002`.

3. **Absence is fail-open with a warning.** If the resolved skill path is
   missing or empty, bob logs a warning and launches the session without
   skills. This deliberately differs from the extension's fail-closed behaviour
   under `CR-003`: the extension is the monitoring and authorization membrane,
   so a session must never run without it, whereas skills are instructional
   content. A session without them is degraded but still useful, and a missing
   skills directory must not take down interactive chat.

4. **Working-directory-relative state is unchanged.** Only skill *discovery*
   moves. Skill-local configuration and the daily worklog remain relative to
   the session's own working directory, so a scheduled job's continuity is
   still reconstructable entirely from its own working directory.

5. **`ADR-012` §7 is amended, not superseded.** Its requirement stands: the
   prompt file and the working directory remain trusted, un-checked inputs that
   operators MUST keep owner-only, because pi still auto-loads `AGENTS.md` /
   `CLAUDE.md` from the working directory and still reads the prompt file
   verbatim. Only its "and skills" clause ceases to apply to bob-spawned
   sessions.

6. **The skill install path is itself a trusted, un-checked input.** bob
   performs no ownership or permission check on it before passing it to pi.
   Content at that path is loaded into every session bob spawns, so it carries
   the same injection exposure that `ADR-012` §7 records for the working
   directory, with wider blast radius because it is not scoped to one job.
   Operators MUST keep it under the same owner-only protection. Filesystem
   permissions, not a bob-side check, are the gate.

7. **Authorization is unchanged.** Every tool call a skill makes still passes
   through the existing action-authorization gate. This decision grants
   nothing; it changes only where skill content is read from.

## Consequences

### Positive

- Session capability stops depending on the working directory. The same skills
  are present whether a session was started by the scheduler or by a human.
- One installation instead of one per working directory. A skill correction is
  deployed once.
- The rules admitting skill reference reads collapse to a single stable path
  set instead of multiplying per deployment.
- The deployment permission model narrows. Only skill-local configuration and
  the worklog still require owner-only per-job directories; skill content
  itself can be a shared read-only install.
- Consistent with `CR-003`: bob owns the location of both artifacts it hands to
  pi, rather than owning one and leaving the other to the working directory.

### Negative

- **bob gains responsibility it did not have.** `S-010` states as a design
  principle that skills require no bob-core or bob-service changes. That
  principle does not survive this decision.
- **Existing deployments break.** Any scheduled job relying on
  working-directory discovery stops finding its skills until the install
  location is configured, and its authorization rules must be rescoped.
- **A new trusted input with wider blast radius.** The install path is loaded
  into *every* session rather than one job's, so a compromise of it is
  correspondingly broader than the working-directory exposure `ADR-012` §7
  already accepts.
- **Fail-open can run a session that silently does less than intended.** A
  scheduled job whose skills are missing will still run, take no skilled
  action, and produce no failure — only a warning in bob's log.

### Neutral

- pi-agent version compatibility becomes load-bearing. The flag this decision
  depends on is not present across all versions the project has used, so the
  README's compatibility record — the project's canonical version record, since
  specs and ADRs deliberately do not pin versions — must be updated and
  revalidated.
- Skills become loadable by agent vendors other than pi-agent, since content is
  no longer tied to pi's discovery layout. This decision does not require that,
  but it does not obstruct it.

## Alternatives Considered

### Alternative A: Install skills into the vendor's own global discovery directory

**Description:** Deploy skill content into pi's per-user global skills
directory, so every pi session on the machine discovers it regardless of
working directory, with no bob change at all.

**Rejected because:** it gives skills to every pi session on the machine, not
just the ones bob supervises, which puts the-intern's operational instructions
into unrelated sessions the service does not monitor or authorize. It also
makes the install location a vendor convention rather than bob configuration,
so bob cannot state what a session it spawned was given — which matters because
every tool call those skills provoke is attributed to bob's authorization gate
and audit trail.

### Alternative B: Two skill sets, one always-on and one scheduled-only

**Description:** Configure a set loaded on every session and a second set
appended only on the periodic path, so journaling skills load only for
scheduled work.

**Rejected because:** the operator chose a single always-active set. The split
buys precision only for the worklog skill, and it introduces a second
configuration concept whose correctness is invisible until a session runs.
Recorded because the consequence is real: with one always-active set, an
interactive chat session journals into the directory it was invoked from, and
the rule admitting those writes must be correspondingly broad — see the
accepted risk recorded in the specification this decision supports.

### Alternative C: Keep working-directory discovery and require a deployed copy per job

**Description:** Change nothing structural; continue requiring each working
directory to contain a deployed copy of the package.

**Rejected because:** it is the status quo whose costs motivated this decision
— per-job duplication, per-deployment authorization rules, and capability that
varies by directory. It also cannot give interactive chat sessions skills
without the human first choosing the right directory to start from.
