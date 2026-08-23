---
id: CR-011
title: remove the claude packaging target from the runtime skills package
status: applied
created: '2026-08-23'
---

# remove the claude packaging target from the runtime skills package

## Desired Changes

Delete the Claude packaging target of the runtime skills package, leaving the pi
target as the only generated target. Concretely, this removes the generated
`claude/` tree of sixteen files, the `package-claude-skills.sh` script that
generates it, and the `test_package_claude_skills.sh` test that verifies it.

**What this does not touch, stated plainly because the names invite confusion:**

- `the-intern/bob-companion/claude/` is **unaffected**. That is the Claude Code
  plugin a human uses to operate bob — its `bob-cli`, `bob-setup`,
  `bob-health-check`, and `bob-troubleshooting` skills stay exactly as they are.
  The two directories both end in `claude/` and have nothing else in common: one
  is a generated copy of the Intern's runtime skills, the other is hand-written
  operator tooling.
- The canonical `skills/` source and the generated `.pi/skills/` target both
  stay, along with `package-pi-skills.sh` and its test. The canonical-source
  layer is deliberately kept even though only one target consumes it — see
  below.
- No skill content changes. `himalaya`, `email-triage`, and `worklog` keep their
  content and their roles; only one generated copy of them goes away.

**The canonical-source layer stays.** With one target left, `skills/` →
`.pi/skills/` could be collapsed by editing pi-shaped files directly. That is
rejected: the generation step is a small script, while re-deriving vendor-neutral
content out of pi-shaped files later is expensive and error-prone. What stopped
paying for itself is the *second target*, not the separation between neutral
content and vendor layout.

## Context

The Claude target was built to demonstrate a design principle rather than to
serve a consumer. S-011 set out to prove that one source tree could feed two
vendors without a second copy of the content, and the target is that proof. No
consumer has appeared: nothing outside the package references it, and the Claude
Code surface actually in use is the `bob-companion` plugin, which is hand-written
operator tooling with a different audience — a distinction S-011 itself records.

The trigger is that the package is about to be reshaped anyway. CR-010 renames
its directory, and S-014 adds a fourth skill to it. Carrying a generated,
unconsumed sixteen-file tree through both of those means renaming it, updating
its generator's embedded plugin identity, updating its test's reconstructed
sibling layout, and regenerating it with a fourth skill — all for output nobody
installs.

**This reverses a stated success criterion, deliberately.** S-011's Purpose
defines success partly as "the same skill content is loadable by both supported
vendors from one source tree." After this change that is no longer true and no
longer verified by anything. The honest move is to amend the criterion rather
than leave the specification asserting a property the repository stopped
demonstrating. Re-adding a vendor later remains cheap precisely because the
canonical-source layer is being kept.

## Potential Impact

- **Nothing at runtime.** bob installs the pi package; the Claude tree was never
  embedded in the binary, never installed by `bob init`, and never referenced by
  the extension. `cargo test --workspace` is unaffected, because the embedded
  asset table is built from `.pi/skills` only.
- **Anyone who installed the generated Claude plugin loses it.** Under ADR-008's
  single-user local scope, and with the package at `0.1.0`, that is a decision
  for one operator rather than a migration.
- **The package README describes the two-target layout** in its directory map
  and in its packaging instructions; both become wrong.
- **S-011's System Diagram shows a "claude target" box** alongside the pi target,
  and its Component 2 is written in the plural, "one manifest per vendor."
- **S-014 assumes two targets in four places**, added days earlier by work that
  had no reason to expect the Claude target to go away. Nothing about the `tasks`
  skill's delivery changes; only the wording does.
- **CR-010 gets smaller.** Three of the files it lists as needing updates —
  `package-claude-skills.sh`, `test_package_claude_skills.sh`, and the generated
  plugin manifest — are deleted here instead of renamed, and the user-visible
  plugin-identity change CR-010 flagged stops existing. The two change-requests
  should be applied in the same pass, this one first, so the rename never has to
  touch files that are about to be deleted.
- **The mdBook is unaffected by this change.** Its stale `SKILL_PACKAGE_SRC=`
  path is a consequence of CR-010's rename and is fixed there; it refers to the
  pi target, not the Claude one.
- **Recovery is a git operation.** The deleted tree is generated output whose
  generator is also deleted, but both are in history, so re-adding the target
  later means reverting a commit and updating it for whatever the canonical
  source looks like by then.

## Possible Spec Amendments

- **S-011** — amend the Purpose so success no longer requires the content being
  loadable by two vendors, stating instead that the canonical source stays
  vendor-neutral so a second target can be added when a consumer exists. Amend
  the System Diagram to show a single pi packaging target, and Component 2 plus
  the "Packaging targets" responsibility row to describe one target while
  keeping the no-duplicated-content requirement that applies to any target.
- **S-011** — the exclusion "Duplicated per-vendor skill products" stays as
  written. It rejects shipping one copy of the *content* per vendor, which this
  change does not contradict; it removes a generated target, not a second
  authored copy.
- **S-014** — amend the four places that assume two packaging targets: the skill
  delivery branch of its System Diagram, the "Existing packaging targets"
  responsibility row, Component 4's "both existing packaging targets", and
  Phase 3's "delivered to the pi and Claude packages". The substance is
  unchanged — the `tasks` skill still reaches sessions through the pi target —
  but the wording assumes a target that will not exist.
- **S-012, S-013** — no amendment needed. Neither references the Claude target:
  `bob init` installs the pi package, and the install bundle ships the binary and
  the extension.
