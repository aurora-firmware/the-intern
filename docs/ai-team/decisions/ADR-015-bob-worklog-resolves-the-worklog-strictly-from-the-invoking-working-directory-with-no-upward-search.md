---
id: ADR-015
title: bob worklog resolves the worklog strictly from the invoking working 
  directory with no upward search
status: accepted
created: '2026-08-30'
---

# ADR-015: bob worklog resolves the worklog strictly from the invoking working directory with no upward search

## Context

S-015 introduces `bob worklog append` and `bob worklog list`, which read and
write a daily markdown worklog. A resolver must decide where that worklog
directory is.

The obvious move is to mirror `bob task` (S-014), whose board resolver
searches **upward** from the working directory for an existing `board/` so a
human can run `bob task` from anywhere inside a workspace. Nothing in the
binding set literally forbids reusing that resolver for the worklog:

- `S-011` §"Skill-local configuration and worklog storage" requires the
  skill-local configuration file and the daily worklog to "remain relative
  to the session's own working directory".
- `ADR-014` §5 requires that "a scheduled job's continuity is still
  reconstructable entirely from its own working directory".

Both phrase the requirement as *relative to* the working directory; neither
states an explicit isolation guarantee against a directory-searching
resolver. So mirroring `bob task` would not be a direct contradiction — it
would be a silent weakening.

Forces:

- A task board is legitimately one-per-workspace; a worklog is a **per-session
  continuity record**. Two scheduled jobs in different directories, or a
  scheduled job and an interactive `bob chat` sharing an ancestor directory,
  must never converge on one diary.
- The upward search that makes `bob task` convenient is a hazard for the
  worklog: it lets an invocation in a subdirectory silently adopt a diary
  that is not its own.
- The human confirmed cwd-strict resolution **with no exception** during
  brainstorming; no operator-convenience override was raised as a
  requirement.
- Fixing one filesystem-only subcommand's resolution convention risks a
  future subcommand assuming the same convention — or the `bob task`
  convention — applies universally. The divergence needs to be recorded, not
  left as an unexplained spec bullet.

## Decision

`bob worklog append` and `bob worklog list` resolve the worklog to exactly
`<cwd>/worklog/<date>.md`, relative to the invoking process's working
directory. There is **no upward directory search**, and **no override** by
flag, environment variable, or configuration key.

- `list`, being a read, fails and names the directory it looked for when
  `<cwd>/worklog/` does not exist. It never invents one, so a wrong working
  directory surfaces as an error rather than as a silently empty day.
- `append`, being a write, may create `<cwd>/worklog/` and the day's file
  when they are absent.

This diverges deliberately from `bob task`'s board resolver (S-014), which
does search upward. The divergence is recorded here so that a future
filesystem-only subcommand does not assume either convention applies
universally: a shared, one-per-workspace artifact may search upward; a
per-session record resolves strictly from the invoking directory.

Accepted by the Architect on 2026-08-30 at S-015's Gate 1 approval, together
with the S-002 / S-010 / S-011 / ADR-014 amendments S-015 forces, after an
architecture-consistency review against `S-011` §"Skill-local configuration
and worklog storage", `ADR-014` §5, `S-014`'s board resolver, and `ADR-008`'s
single-operator scope found no contradiction.

## Consequences

### Positive

- Two sessions with different working directories can never see or extend the
  same diary. `S-011`'s and `ADR-014`'s working-directory-relative continuity
  becomes an absolute property rather than a best-effort one.
- Removes "the resolver walked up into the wrong workspace" as a failure
  mode entirely.
- A wrong working directory is reported (`list` fails naming the missing
  `worklog/`) instead of being concealed as an empty result.
- The admitting action rule needs no working-directory breadth: the working
  directory never appears in the command text, which retires, for worklog
  writes, `S-011`'s accepted risk that the rule "must be broad enough to
  cover arbitrary working directories".

### Negative

- No walk-up convenience: a human who runs `bob worklog list` from a
  subdirectory of a workspace whose `worklog/` sits at the root gets a
  failure, not the root's worklog. Operators and humans must `cd` to the
  exact session directory.
- Two subcommands in one binary now resolve their storage differently —
  `bob task` searches upward, `bob worklog` does not. The inconsistency is
  intentional but must be carried in the operator documentation so it is not
  read as a bug.

### Neutral

- `bob init` / `S-012` still scaffolds `<workspace>/worklog/` as a
  convenience; it is not a dependency, since `append` creates the directory
  itself in any location.
- No configuration surface is added or reserved for a future override; one
  can be introduced later under its own decision if a concrete need appears.

## Alternatives Considered

### Alternative A: Mirror `bob task`'s upward-searching board resolver

**Description:** Walk up from the working directory to the nearest existing
`worklog/` (or workspace marker), so `bob worklog` and `bob task` behave
identically.
**Rejected because:** a task board is legitimately one-per-workspace, but a
worklog is a per-session continuity record. An upward search lets a scheduled
job invoked in a subdirectory, or an interactive `bob chat` sharing an
ancestor directory, converge on a diary that is not its own — precisely the
cross-session bleed `S-011` §"Skill-local configuration and worklog storage"
and `ADR-014` §5 require be impossible. The convenience that justifies the
board's search is a hazard for the worklog.

### Alternative B: cwd-strict by default, with an explicit override

**Description:** Resolve to `<cwd>/worklog/` unless an override (a flag, a
`BOB_WORKLOG_DIR` environment variable, or a config key) names another
location, for operator convenience.
**Rejected because:** no operator-convenience override was raised as a
requirement, and the human confirmed during brainstorming that cwd-strict
with no exception was the intended shape. Any override reintroduces the
possibility of two sessions pointed at one diary — the exact property this
decision exists to guarantee — in exchange for a benefit nobody asked for. It
can be added later under its own decision if a concrete need is demonstrated.
