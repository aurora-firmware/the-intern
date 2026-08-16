---
id: T-171
title: Write README.txt for the bob install bundle
status: completed
priority: medium
assigned-role: unassigned
created: '2026-08-15'
---

# Write README.txt for the bob install bundle

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

Implement `docs/ai-team/specs/S-013-cross-platform-bob-install-bundle-release-packaging.md`
Component 4. Create `the-intern/install-bundle/README.txt`, a plain-text readme shipped
inside every per-platform install-bundle zip alongside the `bob` binary, `bob.ts`, and
`install.sh`. It orients a first-time operator who has just unzipped the bundle: what the
four files are, that running `./install.sh` is the only required step, and what to do
immediately after (`bob init <workspace>`, pointing at the online quickstart for detail).
Keep it short — this is a landing note, not a substitute for the mdBook docs.

## Acceptance Criteria

AC-1: THE SYSTEM SHALL provide `the-intern/install-bundle/README.txt` describing the
      bundle's four contents (the `bob` binary, `bob.ts`, `install.sh`, and the readme
      itself).
AC-2: THE SYSTEM SHALL instruct the reader to run `./install.sh` as the only required
      installation step.
AC-3: THE SYSTEM SHALL point the reader to `bob init <workspace>` as the next step after
      install, with a reference to the online quickstart for full detail.

## Dependencies

- None

## Files to Touch

- `the-intern/install-bundle/README.txt` — new file, the plain-text readme described above

## Verification

```bash
test -f the-intern/install-bundle/README.txt
grep -qi "install.sh" the-intern/install-bundle/README.txt
grep -qi "bob init" the-intern/install-bundle/README.txt
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-08-15

Created the short plain-text install-bundle landing readme. It lists `bob`, `bob.ts`, `install.sh`, and `README.txt`; identifies `./install.sh` as the only required installation step; and points the operator to `bob init <workspace>` and the online quickstart. The task verification and stricter content checks passed. Implementation commit: `167ec8f`. No remaining work.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->

### Review Verdict — 2026-08-15
PASS

Stage 1 passed. `the-intern/install-bundle/README.txt` at implementation commit `167ec8f` satisfies all three acceptance criteria: it enumerates the bundle contents, identifies `./install.sh` as the only required install step, and points the reader to `bob init <workspace>` plus the online quickstart. No unspecified behavior was added, and the implementation diff only adds the new readme.

Stage 2 passed. The change is minimal, readable, and appropriate for a plain-text bundle note. Task verification checks were re-run against the implementation content and passed.
