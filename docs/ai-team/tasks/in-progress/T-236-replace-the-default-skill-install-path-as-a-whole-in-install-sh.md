---
id: T-236
title: Replace the default skill install path as a whole in install.sh
status: in-progress
priority: medium
assigned-role: developer
created: '2026-10-13'
---

# Replace the default skill install path as a whole in install.sh

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

After confirmation (or on a fresh install), make `install.sh` replace the
default skill install path as a whole, and update `README.txt` (CR-016 item
4; S-013 v0.4 Component 3, Component 4, Configuration Requirements, Phase 6;
ADR-017 §1, §3, §6).

Write order: binary, extension, then skills. For skills, `install.sh` empties
the default skill install path and runs the just-installed binary's
`init --skills-only` (not a `PATH`-resolved `bob`), which installs all five
skills into the empty folder. This happens on every install, same-version
reinstall included. Replace the current comment and call that "never passes
--force / non-destructive", and rename the test
`test_never_passes_force_to_skills_only_invocation` to reflect the new
contract. Emptying must remove dotfiles too; the simplest safe route is to
remove the checked directory (or the link) and let `init --skills-only`
recreate it owner-only.

Removal safety (binding, ADR-017 §3): empty only the resolved default skill
install path, and only when it is a non-empty absolute path ending in
`bob/skills`; never follow a symbolic link out of it; if `bob/skills` is
itself a symbolic link, remove the link (or refuse to continue) rather than
emptying its target — if it refuses, run that check before any write, or
treat the refusal as a skill-step failure (warn, exit 0) since the binary is
already written. A `skill_install_path` override in `config.toml` is never
read, emptied or refilled.

Tests keep T-235's `XDG_DATA_HOME` isolation. The stub `bob` used by
`test-install.sh` must write placeholder entries into the resolved path on
`init --skills-only`, so replacement can be asserted.

Write-phase failure (ADR-017 §6): if the skill step fails, keep the binary and
extension, print a warning that skills may be missing — sessions start
without them and scheduled jobs that depend on them (email triage) do nothing
useful until repaired — and that the fix is to rerun `install.sh`; exit 0.

Update `README.txt`: the overwrite prompt and when it appears, its warnings,
`-y`, and that the skill folder is replaced on every install (local edits
are not kept). No internal IDs in `README.txt`.

## Acceptance Criteria

<!-- EARS pattern reference. Every criterion must match one pattern:
  1. Ubiquitous            — The system shall [outcome]
  2. Event-driven          — WHEN [trigger] THE SYSTEM SHALL [outcome]
  3. Unwanted-behaviour    — IF [fault] THEN THE SYSTEM SHALL [outcome]
  4. State-driven          — WHILE [state] THE SYSTEM SHALL [outcome]
  5. Optional              — WHERE [feature included] THE SYSTEM SHALL [outcome]

Examples:
  AC-1: WHEN the user submits valid credentials THE SYSTEM SHALL
        redirect to /dashboard within 200ms.
  AC-2: IF the password is incorrect THEN THE SYSTEM SHALL return 401
        and display "Invalid credentials".
  AC-3: The system shall log every authentication attempt with user id
        and outcome.
-->

AC-1: WHEN an install proceeds THE SYSTEM SHALL leave the default skill
      install path holding exactly what the just-installed binary's
      `init --skills-only` wrote — no earlier entry survives, hidden entries
      included.
AC-2: IF the resolved skill path is empty, relative, or does not end in
      `bob/skills` THEN THE SYSTEM SHALL not delete anything there.
AC-3: IF `bob/skills` is a symbolic link, or contains one pointing outside it,
      THEN THE SYSTEM SHALL not delete anything outside the skill install
      path.
AC-4: IF the skill step fails after confirmation THEN THE SYSTEM SHALL keep
      the binary and extension installed, print the missing-skills warning
      with the rerun instruction, and exit 0.
AC-5: The `README.txt` shall describe the prompt, its warnings, `-y`, and the
      skill folder replacement.

## Dependencies

- `T-235` — check-and-prompt phase and `-y` in `install.sh` / `test-install.sh`
- `T-233` — `bob init --skills-only` installs the five-skill set (the tests assert five skills)

## Files to Touch

- `the-intern/install-bundle/install.sh` — empty-and-refill skill step, removal safety, failure contract
- `the-intern/install-bundle/test-install.sh` — replacement, safety (incl. symlink) and failure cases
- `the-intern/install-bundle/README.txt` — prompt, warnings, `-y`, replacement

## Verification

```bash
bash the-intern/install-bundle/test-install.sh
! grep -nE "\b(T|B|S|CR)-[0-9]{3}\b|ADR-[0-9]{3}|#[0-9]{2,}" the-intern/install-bundle/README.txt
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-10-14
Implemented the replace-as-a-whole skill step in `install.sh`. After the binary and extension are written, a new `is_safe_skill_path` guard accepts only a non-empty absolute path ending in `bob/skills`. If the guard passes, the script runs `rm -rf --` on the resolved default skill path, then runs the just-installed `$install_binary_path init --skills-only`. Because the whole directory (or the link itself) is removed, dotfiles go too, and bob recreates the folder owner-only. `rm -rf` does not follow symbolic links, so a `bob/skills` link or an inner link is removed without touching its target. Any failure in the step (refused path, failed removal, non-zero `init`) prints one warning that skills may be missing. The warning says sessions start without them, scheduled jobs such as email triage do nothing useful, and install.sh should be rerun. It then exits 0. The old "never passes --force / non-destructive" comment and call are gone, and the test is renamed `test_skills_only_invocation_carries_no_flags_beyond_skills_only`. The `test-install.sh` stub now writes `stub-skill/SKILL.md` and `.stub-hidden` into `${XDG_DATA_HOME:-$HOME/.local/share}/bob/skills`, so replacement can be asserted. New tests cover exact replacement (stale files, a stale skill and a hidden stale entry removed), same-version reinstall, the outer symlink case, inner symlinks including a hidden one, a relative `HOME` that makes the path relative (the guard refuses and the existing skill survives), and the failure contract. `README.txt` now describes the overwrite prompt and when it appears, both warnings, `-y`, and that the skill folder is replaced on every install with local edits not kept. It also says a `skill_install_path` override is never touched, and it contains no internal IDs. Considered and rejected: refusing the whole install on a `bob/skills` symlink (the task allows removing the link, which is simpler and happens after the binary is written), and deleting by globbing the contents (it would miss dotfiles and is riskier). Not tested: a removal failure such as an unwritable parent directory, because it needs a non-root fixture. The code handles it by warning and exiting 0. Nothing remains for this task. Both verification commands pass.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
