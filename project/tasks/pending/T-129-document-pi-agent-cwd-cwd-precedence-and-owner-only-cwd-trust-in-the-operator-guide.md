---
id: T-129
title: Document pi_agent_cwd, --cwd, precedence, and owner-only cwd trust in the
  operator guide
status: pending
priority: medium
assigned-role: developer
created: '2026-07-05'
spec: S-007
---

# Document pi_agent_cwd, --cwd, precedence, and owner-only cwd trust in the operator guide

## Description

Document the CR-005 working-directory feature in the operator guide
(`the-intern/docs/src/operator-guide/index.md`). Cover: the service-wide
`pi_agent_cwd` config key (absolute-only, default = inherit launch cwd); the
per-entry `--cwd` flag on `bob schedule add` and its appearance in `bob schedule
list`; the precedence rule (per-entry `cwd` → `pi_agent_cwd` → inherited); that
`bob chat` uses its invocation cwd and ignores `pi_agent_cwd`; and the trust
guidance — the scheduled cwd is trusted and un-checked, pi auto-loads
`AGENTS.md`/`CLAUDE.md` and skills from it, so operators must keep it owner-only
like `schedules.json` (filesystem permissions are the gate). The mdBook must
build cleanly.

## Acceptance Criteria

AC-1: The operator guide shall document the `pi_agent_cwd` config key, the `--cwd`
      schedule flag, and the per-entry → service-wide → inherited precedence rule.
AC-2: The operator guide shall state that the scheduled working directory is
      trusted and un-checked and that operators must keep it owner-only because pi
      loads context files and skills from it.
AC-3: WHEN the user-docs mdBook is built THE SYSTEM SHALL build without errors
      including the new content.

## Dependencies

- `T-119` — `pi_agent_cwd` config key (behaviour to document)
- `T-125` — `--cwd` CLI flag and list rendering (behaviour to document)

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — schedule + configuration + trust
  guidance for the working-directory feature

## Verification

```bash
mdbook build the-intern/docs
```

## Work Log

## Review
