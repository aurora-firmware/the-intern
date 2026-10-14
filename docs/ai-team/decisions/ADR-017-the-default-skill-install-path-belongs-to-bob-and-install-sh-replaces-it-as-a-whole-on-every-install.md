---
id: ADR-017
title: the default skill install path belongs to bob and install.sh replaces it 
  as a whole on every install
status: accepted
created: '2026-10-13'
---

# ADR-017: the default skill install path belongs to bob and install.sh replaces it as a whole on every install

## Context

GitHub issue #138: with only bob and its extension installed, a pi session
cannot reliably answer questions about bob or operate its CLI from documented
guidance. `CR-016` answers this with a fifth bob-supplied skill,
`the-intern-docs`, whose reference pages are the user manual of the installed
bob version. A manual is only useful if it describes the bob that is actually
running, and that requirement exposed a gap in how installed skills are kept
in step with the binary at all.

pi itself was studied as prior art. pi ships its manual inside its own install
and points sessions at it by an install-resolved path, read only when the user
asks about pi itself, through a topic map. Because the docs are part of the
install, they always match the installed pi and never depend on the working
directory. `CR-016` keeps that shape — an install-resolved path, read on
demand, with a topic map — but reaches it through the skill mechanism bob
already owns (`ADR-014`) rather than a second, pi-style system-prompt
mechanism. What it borrows is the property that matters here: the docs travel
with the install, so every install must leave them matching the binary.

Today that property does not hold for any skill. Under `CR-012`, `install.sh`
runs the just-installed binary's `bob init --skills-only` without `--force`,
which creates missing skill files and leaves every existing file untouched,
whether or not the release changed it. After the first upgrade, installed
skills silently stop matching the running bob, and a skill or file a release
drops stays on disk where pi can still load it. That had already drifted from
`S-010`, which states that the email-triage taxonomy is fixed at release time
and that installed skill content is replaced on upgrade. The other skills are
validated policy prose tied to the same release's command surface, so a
version mismatch is as wrong for them as for a manual.

Forces:

- **Every skill is embedded in the binary.** After `CR-016`, all five skills —
  `himalaya`, `email-triage`, `worklog`, `tasks`, and `the-intern-docs`, whose
  pages are copied from the manual source when bob is built — are compiled
  into `bob`. A given binary therefore implies exactly one skill set.
- **The default skill install path already reads as bob's own.** `ADR-009`
  places it in the `data` bucket for read-only application assets, `ADR-014`
  §3 says that is what skill content is, and no approved specification or
  operator document sanctions putting anything else there. Operators who want
  a different location already have the `skill_install_path` override.
- **Installed skills can exist without a binary at `~/.local/bin/bob`.** A
  `mise` or Cargo install followed by `bob init` populates the default path
  without `install.sh` ever having run, so a prompt keyed on the binary alone
  would let an install replace skills without asking.
- **`S-013` forbids silently overwriting an existing install**, and excludes
  any unattended route.
- **A skill-step failure must not fail a good binary install** (`CR-012`).

## Decision

**The default skill install path belongs to bob alone. Every install through
`install.sh` empties it and refills it from the binary just installed, which
stands in for the whole release. `install.sh` asks first whenever anything is
already installed, declining changes nothing, and `-y` is the only unattended
route.**

1. **The default skill install path is bob's alone.** The default location
   (`<data dir>/bob/skills`, per `ADR-009` and `ADR-014` §3) holds only the
   skills a bob release installs. It is not a customisation point: anything in
   it that the release being installed does not ship is treated as a leftover
   from an older release, because leaving it would let pi load stale or
   conflicting skills. A location set through the `skill_install_path`
   override is the operator's own, and no install ever empties or refills it.

2. **The binary stands in for the release.** All shipped skills are embedded
   in the `bob` binary, so `install.sh` never compares skill content. It
   compares only the installed binary with the bundled one, byte for byte, and
   a comparison that cannot complete counts as different. A different binary
   produces a warning that a different bob version is installed and that the
   installed skills (the documentation skill included) and the extension will
   be replaced and may differ from what is there now, local edits included.
   Installed skills with no installed binary produce a warning that the
   existing skills will be replaced. Identical binaries produce the prompt
   with no warning.

3. **Every install replaces the skill folder as a whole.** After confirmation,
   or on a fresh install, `install.sh` writes the binary, then the extension,
   then empties the default skill install path and runs the just-installed
   binary's `init --skills-only` into the empty folder. The result holds
   exactly the release's skills: changed files, missing files, files a release
   no longer ships, and whole skills a release no longer ships are all handled
   the same way. This happens on every install, including a same-version
   reinstall. Emptying is bounded: only the resolved default path, only when
   it is a non-empty absolute path ending in `bob/skills`, never following a
   symbolic link out of it, and if `bob/skills` is itself a symbolic link the
   link is removed (or the install refuses) rather than its target emptied.

4. **An existing installation is never overwritten without consent, and
   declining is all-or-nothing.** `install.sh` prompts before writing anything
   whenever a binary exists at `~/.local/bin/bob` or the default skill install
   path holds any entry at all, not only skill-shaped directories. Any answer
   but yes, or no answer available, aborts the whole install with nothing
   written: no binary, extension, or skill. With no binary and an empty or
   absent skill path, the install is fresh and proceeds without a prompt. This
   extends `S-013`'s "never silently overwrite an existing install" to
   installed skills.

5. **`-y` is the only unattended route.** `-y` answers yes to the single
   overwrite prompt for scripted and unattended upgrades; the warnings are
   still printed. No other flag, environment variable, or configuration
   setting bypasses the prompt.

6. **Failures after confirmation do not fail the install.** The
   all-or-nothing guarantee covers declining, not errors after consent. If the
   skill step fails, the binary and extension stay installed, `install.sh`
   warns that skills may be missing, and exits 0. Because the folder was
   emptied first, the skills are missing rather than out of date until the
   operator reruns `install.sh`, which is the recovery.

7. **Scope.** This governs installs through `install.sh` only. A hand-run
   `bob init --skills-only [--force]` and `bob init <path> [--force]` keep
   their per-file semantics, and no `bob init` mode empties a folder. Per-job
   state — the email-triage configuration, `worklog/`, `tasks/` — stays in each
   job's working directory, and `install.sh` neither reads nor writes it or
   bob's configuration.

Accepted by the Architect on 2026-10-13, following the human's approval of
`CR-016` and the architecture consistency reviews of that change-request
against all approved specifications and accepted decision records. `S-011`,
`S-012`, `S-013`, and `S-007` are amended by `CR-016`. `ADR-009` and `ADR-014`
are not amended: this decision makes explicit an ownership both already imply,
and relies on `ADR-014` §4 for the failure case. `CR-012` is superseded in
part (see Neutral).

## Consequences

### Positive

- After any install through `install.sh`, the installed skills — the manual
  included — are exactly the skills of the running binary, so the
  documentation skill always describes the bob in use, and `S-010`'s
  "replaced on upgrade" statement is true again.
- Skills, pages, and files a release drops disappear on the next install
  instead of remaining loadable next to their replacements.
- No skill-content comparison, staging directory, or new `bob init` mode is
  needed: the existing byte comparison of the binary and the existing
  `--skills-only` route are enough.
- An operator who declines gets an unchanged installation, never a partial
  one, and scripted upgrades have one explicit, supported route.

### Negative

- **Local edits to installed skills are lost on every install the operator
  confirms or runs with `-y`.** Installed skills are release-owned content;
  edits survive only by declining the install. Anything else placed in the
  default skill install path, which nothing sanctions, is deleted too. The
  operator guide and the release notes of the release that ships this must
  say so.
- **No supported customisation point exists for skill content.** In
  particular, operator-defined email-triage categories have nowhere to live;
  that is tracked separately as issue #139.
- **A configured `skill_install_path` override is never refreshed by an
  install.** `install.sh` reads no configuration and `--skills-only` resolves
  only the default, so an operator using the override must keep that location
  current by hand. How configuration should work across `bob init` and
  `install.sh` is tracked as issue #140.
- **A failed skill step leaves skills missing, not merely stale.** Sessions
  then start without them under `ADR-014` §4's fail-open rule, and scheduled
  jobs that depend on them — email triage, for example — run and do nothing
  useful until `install.sh` is rerun. The failure warning must say this
  plainly.
- **Same-version reinstalls and installs over skills-only setups now
  prompt.** Every non-fresh install asks once; unattended use must pass `-y`
  instead of piping an answer.
- **Non-zip upgrades do not get the replacement.** A `mise` or Cargo upgrade
  refreshes installed skills only through a hand-run
  `bob init --skills-only --force`, and pages or skills a release drops linger
  until the next `install.sh` run.

### Neutral

- **`ADR-009`** is unchanged: the default path stays in the `data` bucket for
  read-only application assets, which this decision makes explicitly
  bob-owned.
- **`ADR-014`** is unchanged: delivery through `resources_discover`, one
  always-active set (§2), the default location and its override (§3),
  fail-open absence (§4), and the skill path as a trusted, owner-only input
  (§7, kept by `bob init` writing directories 0700 and files 0600) all stand.
  Its Alternative B, installing into pi's global skill directory, stays
  rejected.
- **`CR-012`** is superseded in part. Kept: `bob init --skills-only` as a
  sanctioned mode, `install.sh` invoking it through the binary it just
  installed rather than a `bob` resolved on `PATH`, and a skill-step failure
  never failing the install. Superseded for installs through `install.sh`:
  the per-file "existing files are left untouched" outcome, since the call now
  runs against an empty folder. `CR-012`'s rejection of shipping skills as a
  plain file tree in the install zip holds without exception.
- Release assets and install-bundle contents are unchanged; the
  documentation skill travels inside the binary.

## Alternatives Considered

### Alternative A: Compare skill content, staged through `bob init` into a temporary data directory

**Description:** Before writing anything, run the bundled binary's
`init --skills-only` with a temporary `XDG_DATA_HOME`, compare the staged tree
with the installed one, and prompt only when skill content would change.
**Rejected because:** all skills are embedded in the binary, so a different
binary already signals that skills may differ and an identical binary already
implies identical shipped content; the only extra thing a comparison detects
is local edits, which are not a supported customisation point. The comparison
added a new pre-install use of the bundled binary, a staging directory that
must stay inside the home directory, and a check that can itself fail, for
no decision the binary comparison does not already make.

### Alternative B: Ship the documentation skill as a separate folder in the install bundle

**Description:** Keep `the-intern-docs` out of the binary; ship it as a plain
directory in the install zip, copied into place by `install.sh` and never
touched by `bob init`.
**Rejected because:** once installs replace the whole skill folder, version
matching is guaranteed either way, so the split buys nothing. It costs a
second delivery route beside the embedded one, an exception to `CR-012`'s
rejection of shipping skills as a file tree in the zip, owner-only modes that
zip extraction does not give, and no documentation at all for `mise` and
Cargo installs.

### Alternative C: Replace only the named shipped skills and leave other directories

**Description:** `install.sh` removes and reinstalls each skill the release
ships by name, leaving anything else at the install path alone.
**Rejected because:** a skill a later release drops would linger and stay
loadable by pi next to its replacement, which is the stale-or-conflicting
state this decision exists to prevent. It also makes `install.sh` carry the
release's skill list. Nothing sanctions other content at the default path,
and operators who want their own location already have the override.

### Alternative D: Prompt per skill

**Description:** Ask separately for each installed skill, so an operator can
keep some and replace others.
**Rejected because:** the skills ship and are embedded as one release unit.
Accepting some and keeping others produces a mixed set that no release ships
and that nothing validated together, and it breaks the all-or-nothing outcome
of declining.

### Alternative E: Prompt only when a binary is installed

**Description:** Keep `S-013`'s existing prompt, triggered only by a binary at
`~/.local/bin/bob`, and replace installed skills unprompted, with a printed
note when no binary exists.
**Rejected because:** skills can be installed without that binary — after a
`mise` or Cargo install and `bob init` — and emptying them unprompted is the
silent overwrite `S-013` forbids, destroying any local edits without consent.
