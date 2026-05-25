---
id: T-078
title: Write end-user CLI guide content with worked examples
status: pending
priority: medium
assigned-role: developer
created: '2026-05-25'
spec: S-007
---

# Write end-user CLI guide content with worked examples

## Description

Replace the stub created by T-077 for the End-User Guide chapter with
hand-written user-facing content. The audience is someone who has `bob` on
their machine and wants to drive it — not someone who is building it.

The chapter must cover the CLI subcommands documented in the project
README: `bob serve`, `bob status`, `bob sessions`, `bob audit`, `bob
policy`, `bob chat`. For each subcommand provide:
- A one-line plain-language description of what it does.
- When you would use it (one or two sentences).
- At least one worked example with a sample invocation and a description
  of what the user should see.

Explain socket paths and `BOB_*` env vars only at the depth a user needs
to run the binary against an isolated runtime dir (the operator guide owns
deeper coverage). Cross-link to the Operator & Deployer Guide for
installation and to the CLI Reference part for exhaustive flag listings.

Do not duplicate the auto-generated `--help` output — this is narrative,
not reference. Keep the chapter focused on user intent and outcomes.

## Acceptance Criteria

AC-1: The system shall provide a populated End-User Guide chapter at
`the-intern/docs/src/user-guide.md` whose rendered HTML contains at least
one named section per CLI subcommand listed above.

AC-2: The system shall include at least one worked example (sample
invocation plus described outcome) in every per-subcommand section.

AC-3: WHEN `mdbook build` runs from `the-intern/docs/`, THE SYSTEM SHALL
produce the End-User Guide chapter without warnings or broken internal
links.

AC-4: WHERE the chapter references installation or deeper runtime
configuration, THE SYSTEM SHALL link to the Operator & Deployer Guide
rather than restating that material.

## Dependencies

- `T-077` — provides the mdBook scaffold and the stub file this task
  replaces.

## Files to Touch

- `the-intern/docs/src/user-guide.md` — replace stub with full content.

## Verification

```bash
cd the-intern/docs && mdbook build
test -s src/user-guide.md
grep -rq "bob chat" book/
```

## Work Log

### Session 1 — 2026-05-26

Read all source references before writing: the CLI source in
`the-intern/service/crates/bob/src/cli/` (mod.rs plus each per-command
file), the README "Run and use" section, and ADR-005. The SUMMARY.md
confirmed the single-page structure (`end-user-guide/index.md`).

Wrote the guide as a single file with H2 sections per subcommand. Each
section has a plain-language description, a "when to use it" paragraph,
and at least one worked example with both the invocation and the
described output. The `bob status` and `bob sessions` sections include
both human and `--json` variants because the source code clearly
distinguishes the two output modes. The `bob audit` section explains
the `--filter` flag with three examples since filter composition is the
only non-obvious part.

For `bob chat`, the implementation reads stdin line-by-line and sends
each as `chat.send` — this is surfaced as "type a message and press
Enter" in the narrative, and a non-interactive pipe example shows the
stdin-close-to-exit behaviour. ADR-005's self-asserted identity is
mentioned in one short paragraph without reproducing the architectural
detail.

Cross-links to `../operator-guide/index.md` and
`../cli-reference/index.md` are placed at the guide introduction and
where relevant (installation, policy file location). These link to the
stubs that T-077 created; T-079 and T-082 will fill them in later.

**Note for the Reviewer / Planner:** The task file's `Files to Touch`
lists `the-intern/docs/src/user-guide.md` — that path does not exist in
the scaffold. The actual file is
`the-intern/docs/src/end-user-guide/index.md`. The task assignment text
and SUMMARY.md both agree on the correct path; the `Files to Touch`
entry is stale. Content was written to the correct file per the
scaffold. The same path mismatch likely affects T-079..T-081 (the other
content tasks).

## Review
