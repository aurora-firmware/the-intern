---
id: CR-016
title: Bob-supplied skill that answers questions about bob from the shipped 
  manual
status: applied
created: '2026-10-13'
---

# Bob-supplied skill that answers questions about bob from the shipped manual

## Desired Changes

Every pi session bob spawns — interactive `bob chat`, pooled RPC workers, and
scheduled jobs — can answer questions about bob and the Intern (what it is, how
to configure, operate, schedule, and troubleshoot it, and how its CLI works)
from the user manual of the installed bob version, whatever directory the
session was started from. Every successful install of a bob release —
upgrade or same-version reinstall — leaves bob's skill folder holding exactly
that release's skills, the manual included; declining the overwrite prompt
leaves the installation unchanged (see item 4 for the failure contract and
limits).

1. **A new skill, `the-intern-docs` (S-011).** The skill set bob supplies to
   pi gains a fifth skill, a self-documentation skill. Its `SKILL.md` carries
   only:
   - a description that triggers when the user asks about bob or the Intern
     itself, and not otherwise;
   - a short index mapping topics to the bundled manual pages (quickstart,
     end-user guide, operator guide, architecture overview, extension-author
     guide), modelled on the topic map pi gives for its own docs;
   - the instruction to answer CLI questions from `bob --help` and
     `bob <subcommand> --help` rather than from prose, because the manual's
     CLI reference is itself generated from `--help` at docs build time
     (S-007) and is a stub in the manual source.

   It contains no operating policy and does not tell the agent to act on bob
   (no setup, no service control). It is read-only reference material.

2. **One skill set, one delivery route (S-011, S-012).** `the-intern-docs` is
   a skill like the other four in every respect after its pages are sourced:
   - Its `SKILL.md` and topic index live in the canonical skill source,
     `the-intern/bob-skills/skills/the-intern-docs/`, and go through the pi
     packaging target like the other skills.
   - It is embedded in the `bob` binary with the other skills and installed
     by every `bob init` mode that installs skills, `--skills-only` included.
     A bob obtained any way — release install, `mise`, or a Cargo build —
     carries the docs of its own version.
   - It reaches pi exactly like the others (item 5).

3. **The manual stays the single hand-edited copy (S-011 Design Principles,
   Components 1–2; S-007).** The skill's reference pages are the hand-written
   manual pages under `the-intern/docs/src/`, copied into the skill when bob
   is built. The copy is generated, never committed and never hand-edited, so
   S-011's "skill content exists exactly once in the repository" holds: the
   manual is the canonical source for those pages, and the skill's own
   canonical source holds only its `SKILL.md` and topic index. The copy is a
   plain file copy, not a docs build, so S-007's "exactly one docs archive,
   one CLI-reference build per release" contract is untouched. The
   CLI-reference stub page and `SUMMARY.md` are not copied, and no copied page
   is named `SKILL.md`. Constraints on how the copy is produced: it is never
   written into a tracked directory (`bob-skills/.pi/skills/` is tracked, so
   the hand-run pi packaging step cannot hold it), and a clean
   `cargo build -p bob` from a fresh checkout either embeds the pages or fails
   with a clear error — never silently embeds a `SKILL.md` whose index points
   at missing pages (mirroring S-007's no-silent-failure rule for generated
   content). In practice this means the binary's build script copies the
   pages from `the-intern/docs/src/` (and rebuilds when they change), or an
   untracked build output the build script regenerates or checks; the exact
   mechanism is a breakdown decision. A test fails if the embedded pages
   drift from the manual source. The docs skill's index therefore points at
   pages that exist only in the build output, not in its canonical source.

4. **`install.sh` replaces bob's skill folder on every install, and asks
   first whenever there is an existing installation (S-013, S-012, S-011;
   CR-012 superseded in part).** All skills are embedded in the `bob` binary,
   so the binary stands in for the whole release: no skill content is
   compared.
   - **The default skill install path is bob's alone.** It lives in bob's own
     data directory (`<data dir>/bob/skills`) and holds only the skills a bob
     release installs; nothing else is expected there. Anything in it that
     the release being installed does not ship is a leftover from an older
     release, and leaving it would let pi load stale or conflicting skills.
   - **Existing installation — prompt.** When a `bob` binary exists at
     `~/.local/bin/bob`, or the default skill install path holds any entry at
     all (not only skill-shaped directories), `install.sh` asks to overwrite
     before writing anything — today's binary prompt, extended to cover
     installed skills. This also applies to a same-version reinstall.
     Answering anything but yes aborts the whole install and leaves the local
     installation exactly as it was: no binary, extension, or skill is
     written. This extends S-013's principle "an install must never silently
     overwrite an existing install" to installed skills, which can exist
     without a binary at `~/.local/bin/bob` (for example after a `mise` or
     Cargo install and a `bob init`).
   - **Warnings before the prompt.** When the installed binary differs from
     the bundled one (byte comparison; a comparison that cannot complete
     counts as different), a warning says a different bob version is
     installed and that the installed skills (the documentation skill
     included) and the extension will be replaced and may differ from what is
     there now (including any local edits). When skills are installed but no
     binary is, a warning says the existing skills will be replaced. When the
     binaries are identical, the prompt is shown without a warning.
   - **Fresh install — no prompt.** With no binary and an empty or absent
     skill install path, `install.sh` installs without asking.
   - **`-y` skips the prompt.** A new `-y` argument answers yes to the
     overwrite prompt, for unattended and scripted upgrades; warnings are
     still printed. Without `-y` and with no input available, `install.sh`
     aborts with no changes, as it already does. This withdraws S-013's
     exclusion of unattended / non-interactive install ("a `--yes`-style flag
     for scripted/CI use is out of scope"); `-y` is the only unattended route.
   - **The skill folder is replaced, not merged.** After confirmation (or on
     a fresh install), `install.sh` writes the binary, then the extension,
     then empties the default skill install path and runs the just-installed
     binary's `init --skills-only` (CR-012's existing route), which installs
     all five skills into the empty folder. The result holds exactly the
     release's skills — changed files, missing files, files a release no
     longer ships, and whole skills a release no longer ships are all handled
     the same way. This happens on every install, the same-version reinstall
     included.
   - **Removal safety (breakdown constraint).** `install.sh` only empties the
     resolved default skill install path, and only when it resolves to a
     non-empty absolute path ending in `bob/skills`; it never follows a
     symbolic link out of that directory, and if `bob/skills` is itself a
     symbolic link it removes the link (or refuses to continue) rather than
     emptying its target. Both cases are covered by tests.
   - **Write-phase failures.** The all-or-nothing guarantee covers declining,
     not errors after confirmation. If the skill step fails, the binary and
     extension stay installed, `install.sh` prints a warning that skills may
     be missing, and exits 0 — keeping CR-012's rule that a skill-refresh
     failure never fails an otherwise-successful binary install. Because the
     folder is emptied before skills are reinstalled, a failure leaves skills
     missing, not merely out of date: sessions then start without them
     (ADR-014's fail-open case), and scheduled jobs that depend on them —
     email triage, for example — do nothing useful until the install is
     repaired. The warning says so. The recovery is to rerun `install.sh`.
   - Installed skills are release-owned content. Local edits are not a
     supported customisation point; they survive only by declining the
     install. Operator-defined email-triage categories are tracked separately
     as issue #139.
   - **Paths and permissions.** `install.sh` empties the same default skill
     install path `bob init --skills-only` resolves from the environment;
     `bob init` keeps writing it owner-only (directories 0700, files 0600)
     per ADR-014 §7 and S-012. A `skill_install_path` override set in
     `config.toml` is not followed — `install.sh` reads no config — so that
     path is never emptied or refilled by an install; this is accepted
     (configuration is issue #140).
   - **What stays from CR-012:** `bob init --skills-only` stays a sanctioned
     mode, `install.sh` still invokes it through the binary it just installed
     (not a `PATH`-resolved `bob`), and a failure stays non-blocking (above).
     Superseded for installs through `install.sh`: the per-file "existing
     files are left untouched" outcome — the folder is emptied first, so the
     call installs into an empty directory. A hand-run
     `bob init --skills-only [--force]` and plain `bob init <path> [--force]`
     keep their current per-file semantics.

5. **Delivery to pi is unchanged (ADR-014, S-011 Component 3).** The docs
   skill sits at the shared skill install path next to the others and reaches
   pi through the extension's resource-discovery answer on all three spawn
   paths. No new environment variable, extension hook, system-prompt section,
   or install location.

6. **Authorization (S-011 "Action rules admitting skill tool calls").** The
   requirement list gains the docs skill's reference-page reads and the
   `bob --help` / `bob <subcommand> --help` invocations it teaches. Under the
   broad first-run ruleset `bob init` generates (S-012 / CR-007, `bash` and
   `read` with no matcher) both are already admitted. Deployments that
   followed the documented narrowed, per-skill rules deny them until rules
   are added, so the two hand-written rule listings (operator guide and
   `bob-skills/README.md`) gain entries for the docs pages and the `--help`
   calls.

7. **Manual content constraints (S-007).** Pages copied into the skill are
   read by an agent as plain markdown and become shipped skill content, so
   S-011's rule against referencing this project's internal artifacts applies
   to them. S-007's allowance for linking out to internal project docs is
   withdrawn. Links to the excluded CLI-reference stub (operator guide,
   quickstart, end-user guide) must still make sense in the copy — for
   example by pointing at `bob --help` — exact handling a breakdown decision.
   mermaid blocks are acceptable.

8. **Operator-facing documentation and skill-set listings are updated:**
   S-011's System Diagram, Responsibility Separation table, and Workflow end
   state ("Session has himalaya, email-triage, worklog, and tasks
   available…"); S-012's account of the four embedded skill trees; the
   operator guide's list of installed skills, its upgrade guidance (the whole
   skill folder is replaced on every install, and a failed skill step can
   leave skills missing until `install.sh` is rerun), and its narrowed rule
   listing; `bob-skills/README.md` and its rule listing; the install bundle's
   `README.txt` (the overwrite prompt, its warnings, and `-y`); the pi
   packaging script (`package-pi-skills.sh`, whose skill list pins four
   names) and its test; the binary's build script; and every test
   expectation that pins the embedded or installed skill set to four skills
   or `install.sh`'s non-destructive refresh. The operator guide's upgrade
   text for non-zip upgrades (`mise`, Cargo) also says that refreshing the
   installed skills, the manual included, needs `bob init --skills-only
   --force`, and that pages or skills a release drops linger until the next
   `install.sh` run.

### Explicitly not changing

- **The `bob-companion` Claude Code plugin** keeps its four skills, its
  audience (a human operating bob from Claude Code), and its release asset.
  Nothing is moved out of it or duplicated from it. S-010's and S-011's
  exclusions about it stand.
- **Release assets and install-bundle contents (S-013).** No asset is added,
  removed, or renamed, and the install-bundle zips keep their current
  contents; the docs skill travels inside the `bob` binary.
- **No installation into pi's own global skill directory** (ADR-014
  Alternative B stays rejected).
- **Configuration.** `install.sh` neither reads nor writes bob's
  configuration, and per-job mutable state (the email-triage configuration,
  `worklog/`, `tasks/`) stays in each job's working directory, untouched. How
  configuration should be handled across `bob init` and `install.sh` is
  tracked separately as issue #140.

## Context

GitHub issue #138: with only bob and its extension installed, a pi session
cannot reliably answer questions about bob or operate its CLI from documented
guidance. The current workaround is to keep the `bob-companion` skills in the
directory a `bob chat` session is started from, so the capability depends on
where the session starts — the same problem ADR-014 solved for the runtime
skills.

The issue suggests bundling `bob-companion` with the extension. That was
rejected during triage: S-010 and S-011 deliberately separate the Claude Code
operator plugin from the runtime skills pi discovers, S-011 rejects
per-vendor duplicate skill products, and the companion's `bob-setup` /
`bob-troubleshooting` guidance would land in unattended scheduled sessions.

pi itself was studied as prior art. pi ships its manual inside its install
(README, `docs/`, `examples/`) and adds a system-prompt section that points
at those files by absolute install-resolved path, says to read them only when
the user asks about pi itself, and maps topics to files. That makes the docs
available regardless of working directory and always matching the installed
version. A literal copy of that mechanism for bob (install the manual to the
XDG data directory and inject a prompt section from the extension's
`before_agent_start` handler) was considered and rejected: it adds a second
delivery mechanism beside ADR-014's, a new install location and read rule,
and a fixed prompt cost on every session. A skill gives the same
"install-resolved path + read on demand + topic map" shape through the
mechanism bob already owns, and pi only loads the skill body when the
description matches.

An earlier draft of this change shipped the docs skill as a separate
directory in the install-bundle zip, copied by `install.sh` and never touched
by `bob init`. Once installs were made to replace the whole skill folder on
every install, that split no longer bought anything — version matching is
guaranteed either way — while it cost a second delivery route, an exception
to CR-012's rejection of shipping skills as a plain file tree in the zip, and
docs missing from `mise` and Cargo installs. It was dropped in favour of
treating the docs skill like every other skill.

Version matching is why the install script now replaces skills. Today
`install.sh` runs `bob init --skills-only` without `--force`, which creates
missing skill files but leaves every existing file untouched whether or not it
changed between releases. After the first upgrade, installed skills therefore
silently stop matching the running bob. That is unacceptable for a manual
that must describe the installed version, and equally for the other skills,
whose content is validated policy prose tied to the bob command surface of
the same release. S-010 already states that the email-triage taxonomy is fixed
at release time and replaced on upgrade; CR-012's non-destructive refresh had
drifted from that, and this change brings them back into agreement.

The confirmation design reuses the existing binary prompt rather than
comparing skill content: all skills are embedded in the binary, so a
different binary is the signal that installed skills may differ, and a
warning says so. The prompt also covers installed skills without a binary,
so no existing installation is overwritten silently. The default skill
install path belongs to bob alone, so it is replaced as a whole: leftovers
from older releases would otherwise remain loadable next to the new skills.
An operator who declines gets an unchanged installation, never a partial
one. After confirmation, a skill write failure is reported but does not undo
the binary and extension (item 4).

## Potential Impact

- **Local edits to installed skills are lost on every install.** S-010
  already treats the category taxonomy as changeable through releases, not by
  operators, but anyone who edited installed skill files in place loses those
  edits on the next install they confirm (or run with `-y`). The whole
  default skill install path is replaced, so anything else placed there —
  which no documentation sanctions — is deleted too. The operator guide's
  upgrade text and the release notes for the release that ships this change
  must say so. A supported customisation point for categories is issue #139.
- **Unattended installs should use `-y`.** There is still a single
  overwrite prompt; `-y` is the supported way to answer it in scripts,
  instead of piping a `y` into `install.sh`.
- **Prompt cost:** one more skill description in every bob-spawned session's
  system prompt, including scheduled email-triage runs. The description must
  be narrow enough not to trigger during unrelated work.
- **Binary size:** the manual source is about 144 KB of markdown, embedded
  once in the `bob` binary.
- **Build input:** building `bob` now reads the manual source under
  `the-intern/docs/src/` as well as the skill package, so a change to the
  manual changes the binary.
- **Tests:** existing tests pin the old behaviour and must change, notably
  `test-install.sh` (non-destructive refresh), `test_package_pi_skills.sh`,
  and the embedding and `bob init` tests that pin four skills. New tests check that the embedded
  docs pages match the manual source, so drift fails CI.
- **In-flight work:** none. The pending and in-progress task folders are
  empty and there are no open bugs; the only ordering spec-breakdown must
  handle is among this CR's own tasks (the operator guide, `install.sh`, and
  `test-install.sh` will each be touched by more than one).

## Possible Spec Amendments

- **S-011** — Design Principles (content exactly once: the manual in
  `the-intern/docs/src/` is the canonical source of the docs skill's pages;
  the skill carries a generated, uncommitted copy), System Diagram,
  Responsibility Separation (new skill row; install path row: the default
  skill install path belongs to bob alone and is replaced as a whole on every
  install), Component 1 (the manual as a second canonical input; the docs
  skill's index points at pages that exist only in the build output),
  Component 2 (the build adds the manual pages; never into a tracked
  directory, and a build that cannot embed them fails loudly), Workflow end state,
  Action rules (docs-page reads and `bob --help` invocations), Amendment Log.
- **S-012** — Principles and the "Embedded pi-package assets" responsibility
  (the embedded set has five skills, one sourcing its pages from the manual
  at build time — never from a tracked copy, and a build that cannot embed
  them fails loudly),
  Files created (five skill trees), Verification (expectations pinning four
  skills), `install.sh`'s use of `--skills-only` (the default skill install
  path is emptied first, so CR-012's non-destructive outcome no longer
  applies to installs through `install.sh`), Amendment Log. No change to the
  command-line rules: no new `bob init` flag or mode.
- **S-013** — Design Principles (the never-silently-overwrite principle
  extended to installed skills; what `install.sh` writes and where);
  Exclusions (the unattended / non-interactive install exclusion and its
  "`--yes`-style flag is out of scope" are withdrawn in favour of `-y`; the
  `bob init` exception's wording about what `--skills-only` touches is
  updated); Responsibility Separation (`install.sh` and `README.txt` rows);
  Component 3 (new `-y` argument; prompt when a binary or installed skills
  exist; binary byte comparison and the warnings; the default skill install
  path emptied and refilled on every install, with its removal-safety rules;
  write-phase failure contract — warn, keep binary and extension, exit 0,
  recover by rerunning; config override not followed); Component 4
  (`README.txt`); Workflow; Configuration Requirements; Amendment Log.
  Bundle contents and release assets are unchanged.
- **S-007** — the manual source gains a second consumer (the docs skill,
  copied at bob build time — a markdown copy, not an mdBook or CLI-reference
  build, so the one-docs-build-per-release contract and S-013's "the macOS
  job does not build docs" hold); withdraw links to internal project docs; record
  the plain-markdown readability constraint and how links to the excluded
  CLI-reference stub read. Amendment Log.
- **New ADR** — the default skill install path belongs to bob and is
  replaced as a whole on every install; the binary stands in for the release
  (a different binary warns that skills may differ, skill content is never
  compared); the install is all-or-nothing on decline; `-y` is the only
  unattended route.
- **S-010, ADR-014** — no amendment (confirmed by the Architecture
  Consistency Review, 2026-10-13).
