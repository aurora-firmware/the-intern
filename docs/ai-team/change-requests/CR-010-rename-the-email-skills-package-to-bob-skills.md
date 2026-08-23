---
id: CR-010
title: rename the email-skills package to bob-skills
status: applied
created: '2026-08-23'
---

# rename the email-skills package to bob-skills

## Desired Changes

Rename the directory `the-intern/email-skills/` to `the-intern/bob-skills/` and
update every live reference to it. Nothing inside the package moves: the
canonical `skills/` source, the generated `.pi/skills/` target, the `config/`
examples, the packaging script, and its test keep their current names and
layout. This assumes CR-011 has removed the Claude packaging target first.

Scope:

- **The skills themselves are not renamed.** `himalaya`, `email-triage`, and
  `worklog` keep their names, their content, and their roles. Only the
  container is renamed.
- **No behaviour changes.** The shared install path, what `bob init` installs,
  the generated package layout, and the extension's resource-discovery answer
  are all unaffected. This is a rename and its references, nothing else.
- **The Claude packaging target is out of scope here.** Its generated manifest
  declares the plugin `name` as `email-skills`, but CR-011 deletes that target
  along with its generator and test, so this change-request does not rename any
  of it. **CR-011 must be applied first.** If it is not, three more files come
  back into scope — `package-claude-skills.sh` (which embeds the plugin identity
  in a literal block), `test_package_claude_skills.sh` (which reconstructs the
  sibling layout by path), and the generated manifest — and the rename becomes a
  user-visible plugin-identity change.
- **Historical artifacts are not rewritten.** Completed tasks, resolved bugs,
  and progress reports record what was true when they were written and keep the
  old name. Only live, load-bearing references are updated — roughly fourteen
  files, against several hundred occurrences that are pure history.
- **Example workspace names are updated in the same pass.** The shipped manual
  uses `email-skills` as the name of an example *workspace* directory in
  copy-pasteable commands. That is unrelated to the package path, but leaving it
  beside a renamed package invites the reader to conflate the two.

## Context

The package has outgrown its name. `worklog` is domain-free by S-011's own
design principle that "the diary mechanism must carry no domain knowledge", and
S-014 adds `tasks`, which has nothing to do with email either. S-011 already
treats this as *the* vendor-neutral skill package bob supplies to every session
it spawns under ADR-014 — a property of the service, not an email feature. The
directory name is the last artifact still describing it as one, and it is the
name a reader meets first.

The trigger is sequencing. S-014 phase 3 adds a fourth skill to this package,
and phase 5 changes what `bob init` installs from it. Renaming after that work
lands means writing the new skill, the installer change, and the documentation
updates against a name already scheduled to change, then touching the same files
a second time. Renaming first costs one pass.

**On the name.** `bob-skills` names the owner and sits beside `bob-companion/`,
which makes the two look like a pair when they are opposites, and the difference
matters enough to state here: `bob-skills` holds runtime skills bob supplies to
the pi sessions it spawns; `bob-companion` holds Claude Code tooling for a human
operating bob. S-011 already records that these have different audiences and
different release cadences. Both READMEs should say which is which, in those
terms, so the shared prefix reads as common ownership rather than common
purpose.

## Potential Impact

- **The Rust build breaks until three files are updated.** `build.rs` resolves
  the embedded package at a relative path containing the directory name;
  `init_assets.rs` asserts the embedded source directory ends with that path;
  `init_materializer.rs` resolves the example email configuration through it.
  All three fail loudly at build or test time rather than silently, and
  `cargo test --workspace` is the check.
- **No user-visible plugin identity change**, given CR-011 lands first: the
  plugin being renamed would have been the one CR-011 removes.
- **The shipped manual carries the package path in prose and in a
  copy-pasteable command.** The operator guide names the package directory when
  explaining skill installation and again in a `SKILL_PACKAGE_SRC=` assignment a
  reader is expected to paste. A stale path there fails at the reader's shell,
  not in CI.
- **Two shell tests reference the package by path** once CR-011 has landed:
  `test_package_pi_skills.sh`, which asserts against repository-relative paths,
  and the operator-guide trust test under `the-intern/docs/`, which asserts a
  documented `cp -r` command. Neither is part of the cargo workspace, so a missed
  one does not surface in `cargo test`. `package-pi-skills.sh` needs no change —
  it resolves everything relative to its own location.
- **`CLAUDE.md`'s folder map and a `.gitignore` comment** name the directory and
  go stale.
- **Git history should follow the rename.** Moving the tree with `git mv` in its
  own commit, separate from the reference updates, keeps `git log --follow`
  working on the package's files.
- **No runtime or installed-state impact.** The shared install path is resolved
  from the XDG data location and does not contain the repository directory name,
  so already-installed skills and already-initialised workspaces are untouched.
  Nothing needs migrating on any machine.
- **Sequencing.** CR-011 first, then this, then S-014 phases 3 through 5. This
  does not block S-014 phases 1 and 2, which touch none of these files.

## Possible Spec Amendments

- **S-012** — amend the design principle naming `the-intern/email-skills/skills`
  as the canonical skills source, and the Responsibilities row naming the
  generated `email-skills/.pi/skills` output compiled into the binary, to use the
  new directory name.
- **S-014** — remove the exclusion stating that renaming the package directory is
  out of scope and separate work. This change-request is that separate work, so
  the exclusion becomes stale on approval rather than remaining true.
- **S-011** — no amendment needed. It defines the package by its principles and
  names no directory literally, which is why the rename does not disturb it.
