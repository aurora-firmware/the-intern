---
id: T-150
title: Reconcile pi-agent version records and confirm resources_discover fires 
  on all spawn paths
status: pending
priority: high
assigned-role: developer
created: '2026-08-09'
spec: S-011
---

# Reconcile pi-agent version records and confirm resources_discover fires on all spawn paths

## Description

S-011 Implementation Order Phase 1. Three pi-agent version records currently
disagree: the extension API version pinned and tested by
`the-intern/pi-extension/pi-agent-compat.test.ts` (0.75.3), the interactive
`pi` binary version verified for `bob chat` (0.79.10, T-103), and the
scheduled/periodic invocation path's verified version (0.65.2, T-139),
recorded in the root README's "pi-agent Version Compatibility" section.
Reconcile those three into one accurate record, and confirm against the
installed `pi` version that the extension's `resources_discover` event
actually fires during session initialisation on all three of bob's spawn
paths — pooled RPC worker, interactive chat (`bob chat`), and scheduled
periodic job — and that a path an extension contributes through it reaches
pi's system prompt before the first turn (per ADR-014). This is a
prerequisite for T-157–T-160, which build code against this event: if it
doesn't fire on one of the three paths today, that gap must be known before
those tasks start.

Critically, the scheduled-periodic probe must run from a working directory
that is **not** present in `~/.pi/agent/trust.json`. B-035 (resolved)
recorded that pi's non-interactive modes (`-p`, `--mode json`, `--mode rpc`)
silently ignore project-local resources from an untrusted cwd with no error
surfaced — if that same trust gate also applies to extension-contributed
`resources_discover` paths, S-011's core requirement fails on exactly the
scheduled path it depends on most, and this is the task that must catch it
before T-157–T-160 build against an assumption that doesn't hold.

Use a throwaway probe extension outside this repository's tree (the T-131
precedent, recorded in `the-intern/email-skills/README.md`) rather than
committing probe code. When rewriting the README compatibility section,
retain the literals `0.75.3` and `unsupported`/`compatibility error`
language that `the-intern/pi-extension/pi-agent-compat.test.ts` asserts
against — this task's own `npm test` verification will fail if that wording
regresses. No skill content changes; this is verification plus a README
update.

## Acceptance Criteria

AC-1: The system shall record, in the root README's "pi-agent Version
      Compatibility" section, a single reconciled pi-agent version (or
      documented per-path versions with a stated reason they still differ)
      that `resources_discover` was verified against.
AC-2: WHEN a probe extension registered for `resources_discover` runs a
      session through each of the three bob spawn paths (pooled RPC worker,
      interactive chat, scheduled periodic), with the scheduled-periodic
      probe run from a working directory absent from
      `~/.pi/agent/trust.json`, THE SYSTEM SHALL confirm the event fires on
      all three and record whether the contributed skill path reaches the
      system prompt under the untrusted-cwd condition, or THE SYSTEM SHALL
      document exactly which path(s) it does not fire on or does not reach
      the prompt from.
AC-3: IF `resources_discover` does not fire, or a contributed path does not
      reach the system prompt, on one or more of the three spawn paths
      (including the untrusted-cwd scheduled case) THEN THE SYSTEM SHALL
      record that gap in the README compatibility section and flag it as a
      blocker for T-157–T-160 before those tasks start.

## Dependencies

- None

## Files to Touch

- `README.md` — reconcile the three pi-agent version records into one, and
  record the resources_discover verification result

## Verification

```bash
grep -q "pi-agent Version Compatibility" README.md
grep -q "resources_discover" README.md
cd the-intern/pi-extension && npm test
```

The two greps are separate on purpose: the compatibility heading already
exists in `README.md` today, so a single alternation pattern
(`"resources_discover\|pi-agent Version Compatibility"`) passes before any
work is done. `resources_discover` appears nowhere in `README.md` today, so
requiring it separately is what actually gates AC-1–AC-3's recorded result
(Gate 2 verification correction, 2026-08-09).

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
