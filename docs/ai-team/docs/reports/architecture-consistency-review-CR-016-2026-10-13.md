# Architecture Consistency Review — CR-016

Date: 2026-10-13
Reviewer: Architect (`architecture-consistency-review`)
Artifact reviewed: `docs/ai-team/change-requests/CR-016-bob-supplied-skill-that-answers-questions-about-bob-from-the-shipped-manual.md` (change-request, status `pending`)

```text
Result: FAIL

Artifact reviewed: docs/ai-team/change-requests/CR-016-bob-supplied-skill-that-answers-questions-about-bob-from-the-shipped-manual.md
Binding set checked: 16 accepted ADRs (ADR-001 – ADR-016), 14 approved specs (S-001 – S-007, S-009 – S-015);
                     applied CRs read for supersession: CR-007, CR-011, CR-012 (also CR-009, CR-010, CR-013 for skill-set listings)

Next owner:
- Planner (CR revision, two questions forwarded to Human)
```

No finding requires changing an approved spec beyond the amendments the CR
already proposes, so this is `FAIL` (revise the CR), not `ESCALATE`. The human
decisions recorded for this CR (skill name, copy at packaging time,
bundle-only delivery not embedded, full replacement on install, companion
unchanged, no pi global directory) are not re-litigated. Findings B2 and B3
need a human answer, which the Planner forwards.

## Delta isolated

1. A fifth skill, `the-intern-docs`, ships only as a directory inside the two
   install-bundle zips. Its reference pages are copied from
   `the-intern/docs/src/` at release packaging time. It is not embedded in the
   binary and no `bob init` mode touches it.
2. `install.sh` makes the shared skill install path match what the release
   ships. It replaces the docs skill and every embedded runtime skill in full,
   and removes stale files. This supersedes CR-012's "never passes `--force`".
3. Installed skills are release-owned. Editing them in place is no longer
   supported.
4. Delivery to pi (ADR-014) is unchanged. The action-rule requirement list
   gains `bob --help` / `bob <subcommand> --help`.

## Findings

### Blocking — the CR must be revised before its amendments are applied

**B1. Where the docs skill's source lives, and how it stays out of the embedded set.**
- *Artifacts:*
  - S-011 Design Principles L81-83 ("Skill content must exist exactly once in the repository").
  - S-011 Responsibility Separation L146-147 (canonical source "holds every skill's content"; packaging target carries "manifests and layout only").
  - S-011 Component 1 L161-162 ("every shipped skill").
  - S-011 Component 2 L176-178.
  - S-012 Principles L52-54 (the binary "embeds the generated pi package").
  - S-012 Responsibilities L71 ("Compile the generated `bob-skills/.pi/skills` output into the binary").
  - CR-016 item 2 L35-43 and item 3 L45-51.
- *Conflict:*
  - The CR says the skill's source holds `SKILL.md` and the topic index. It does not say where that source lives.
  - The existing pipeline is: canonical `bob-skills/skills/` → `package-pi-skills.sh` → tracked `bob-skills/.pi/skills/` → embedded wholesale by `service/crates/bob/build.rs` → installed by `bob init`.
  - If the docs skill's source sits in the canonical source, two things go wrong. It gets embedded and installed by `bob init`, which contradicts item 3. If the manual copy also runs through that target, a second, committed copy of the manual lands in the tracked `.pi/skills/` tree, which contradicts S-011 L81-83.
  - If the source sits elsewhere, then S-011 C1's "every shipped skill" and S-011 L146 ("every skill's content") become false.
- *Resolution:* the CR must state the source location of the docs skill's `SKILL.md` and index, and whether it goes through the pi packaging target. It must also state that the embedded set (S-012 L71) and the tracked `.pi/skills/` tree exclude it, and that the generated manual copy is never committed.
  - The S-012 amendment must cover Principles L52-54 and the Responsibilities "Embedded pi-package assets" row L71, not only "outside every `bob init` mode".
  - The S-011 amendment must cover Design Principle L81-83: the manual's single copy is in `the-intern/docs/src/`, and the skill's copy is a release artifact.
  - Route: Planner (CR revision).

**B2. "Holding exactly what the release ships" deletes more than the CR's bullets say.**
- *Artifacts:*
  - CR-016 item 4 L53-61 ("`install.sh` leaves the shared skill install path holding exactly what the release ships").
  - CR-016 Desired Changes L17-18.
  - S-011 Responsibility Separation L148 (install path row).
  - ADR-014 §3 (the install path is an operator-overridable location, not exclusively release content).
- *Conflict:* item 4's lead sentence implies `install.sh` removes everything at the install path that the release does not ship. That includes skill directories an operator added, and skills a later release drops. Its bullets only describe replacing the five named skills, so they don't say what happens to other directories. The CR's Potential Impact (L153-158) mentions only lost edits to shipped files, not deleted operator-added skills.
- *Resolution:* the human must choose, and the CR must state the choice:
  - (a) Only release-named skill directories are replaced in full. Anything else at the install path is left alone, so a skill dropped by a later release lingers. Reword "exactly what the release ships" to match.
  - (b) The whole install path is release-owned and everything else is removed. Then the CR states that operator-added skills are deleted, the S-011 L148 amendment says so, and release notes call it out.
  - Either way, the S-013 amendment must name the directory that `install.sh` may delete under (the resolved default `…/bob/skills`, never a parent).
  - Route: Planner → Human.

**B3. S-013's "never silently overwrite an existing install" principle is not addressed.**
- *Artifacts:*
  - S-013 Design Principles L110-111 ("An install must never silently overwrite an existing install — the operator's explicit confirmation is required first").
  - S-013 Workflow L245-247 (the confirmation is triggered only by an existing `~/.local/bin/bob`).
  - Current `install.sh` L100-114.
- *Conflict:* the CR declares that it supersedes S-013 Configuration Requirements L320-332 ("never passes `--force`"), but it does not mention this principle. Installed skills can exist when `~/.local/bin/bob` does not, for example after an earlier `mise`, Cargo, or `bob init --skills-only` install. In that case `install.sh` would overwrite or delete them with no prompt. That is the silent overwrite L110-111 forbids, and under the new semantics it destroys any operator edits.
- *Resolution:* the human picks one, and the S-013 amendment records it:
  - Scope the principle to the binary and extension, and say that skill replacement is release-owned and unprompted.
  - Or make the confirmation prompt also cover existing installed skills.
  - Route: Planner → Human.

### Non-blocking — fold into the CR's amendment text or the breakdown

**N1. Claim about the action-rule listings, and missing listings in item 7.**
- *Artifacts:*
  - CR-016 item 6 L84-89 ("Reads of the bundled pages … already admitted by the install-path-scoped rule").
  - S-011 Action rules L281-292.
  - S-004 Exclusions L51-52.
  - Operator guide narrowed ruleset L1214-1270 and `bob-skills/README.md` L224-344 (the two hand-written listings S-015 Phase 5 names).
- *Conflict:* the documented narrowed ruleset admits per-skill patterns (`…/email-triage/SKILL.md`, `…/himalaya/references/*.md`, and so on), not the whole install path. A deployment that followed it will deny reads of `the-intern-docs/SKILL.md` and its pages. The CR's statement is true only under the CR-007 bootstrap profile.
- *Resolution:*
  - Reword item 6.
  - Add both action-rule listings to item 7, with a `read` rule for the docs skill's `SKILL.md` and pages, plus a `bash` rule shape for `bob --help` / `bob <subcommand> --help`.
  - The S-011 amendment's requirement list (L281-284) should name the docs skill's reference reads as well as the `--help` calls.
  - Breakdown note: the read-rule pattern must match the copied page layout. If pages keep their `<part>/index.md` nesting, check how the matcher's `*` treats `/`.

**N2. Owner-only permissions for the docs skill.**
- *Artifacts:* ADR-014 §7, S-011 Config L266-271, S-012 Responsibilities L72 and Files created L141-142 (directories 0700, files 0600).
- *Conflict:* none of these is contradicted outright. However, the docs skill is the first skill that `install.sh` writes directly, not the binary's installer. Modes extracted from a zip are typically 0644/0755, so the owner-only rule would quietly weaken.
- *Resolution:* the S-013 amendment requires `install.sh` to write the docs skill with the same owner-only modes as the shared-skill installer. Route: Planner.

**N3. Which install path `install.sh` writes to, and the `skill_install_path` override.**
- *Artifacts:*
  - S-013 Design Principles L100-103.
  - S-013 Component 3 L194 (`install.sh` reads no `config.toml`; `--skills-only` resolves from the environment only).
  - ADR-014 §3 (the location is overridable by a `config.toml` key).
  - S-011 Config L254-277.
  - Operator guide L244 onward.
  - CR-016 L17-18 ("Installing a bob release always leaves the installed manual … identical").
- *Conflict:* `bob init --skills-only` resolves `$XDG_DATA_HOME/bob/skills` or the platform default (`config.rs` `default_skill_install_path_for_env`) and ignores the `config.toml` override. `install.sh` must not read `config.toml` either. An operator with a non-default `skill_install_path` therefore never receives the docs skill, and there is no command that installs it. That makes "always … identical" an overclaim.
- *Resolution:*
  - The CR and the S-013 amendment state that `install.sh` places the docs skill at exactly the default that `--skills-only` resolves. That means the same XDG cases and the macOS `~/Library/Application Support/bob/skills` default; one option is to take the path from the just-installed binary.
  - State that a configured `skill_install_path` override is not followed, as an accepted limitation, alongside the Cargo-build limitation already accepted at L74-76.
  - Qualify L17-18 to match.

**N4. Every S-013 location that enumerates bundle contents or `install.sh`'s writes.**
- *Artifacts (S-013), beyond those the CR lists:*
  - Purpose L31-34 (zip contents listed).
  - Design Principles L100 ("`install.sh` writes only to that resolved default location").
  - Exclusions L49-54 (the carve-out describes the only skill-path writer as `bob init --skills-only`).
  - Responsibility Separation L169 (the macOS job "does not build docs"), L170 (packaging step contents), L171 (`install.sh` row), L172 (`README.txt` row).
  - Component 2 L186-188.
  - Component 3 Purpose and Interfaces L192-194 ("Reads its own zip-local sibling files (the bob binary, `bob.ts`)"; "writes to `~/.local/bin` and the resolved extension data path").
  - Workflow L223, L231, L255-257.
  - Implementation Order L349 and L351.
- *Conflict:* each of these is a restatement of the old contents or of the non-destructive refresh.
- *Resolution:*
  - Amend every location above.
  - State explicitly that copying the manual into the docs skill is a plain file copy, not a docs build. That keeps S-013 L104-107 / L169 and S-007's "exactly one docs archive, one CLI-reference build" (S-007 L282-287) intact, even though the macOS job must stage the docs skill too.

**N5. S-007 lets manual pages link to development material.**
- *Artifacts:*
  - S-007 Component 2 L149-151 ("May link out to `project/docs/` for deep dives").
  - S-007 Implementation Order Phase 2 L294 ("outward links to `project/docs/`").
  - S-011 Design Principles L95-97 (skill content must not reference this project's internal artifacts).
- *Conflict:* once a page is copied into a skill, a link to `project/docs/` (specs, ADRs) becomes skill content that references internal artifacts. The manual has no such links today (checked), but S-007 explicitly allows them.
- *Resolution:* the S-007 amendment the CR already plans should also:
  - forbid links into development material from pages that are copied into the skill;
  - say whether `SUMMARY.md` is copied (the topic index replaces it);
  - say how links to the excluded CLI-reference stub read. Three pages link to it today: operator guide L327, quickstart L249, end-user guide L11.

**N6. CR-012's rejected Alternative 2 is partly adopted without saying so.**
- *Artifacts:* CR-012 Context, Alternative 2, L82-90 (shipping the skill package as a plain file tree in the zip, copied by `install.sh`, was rejected). CR-016 item 4 L65-68 (declares only the "never `--force`" part superseded).
- *Conflict:* CR-016 ships the docs skill exactly as a zip file tree copied by `install.sh`. That is the mechanism CR-012 rejected because non-zip upgrades would still need a command.
- *Resolution:* the supersession paragraph should also name Alternative 2. It should say the docs skill uses that mechanism by decision, and that the rejection's rationale is accepted as a limitation, which L74-76 already accepts.

**N7. S-012 Purpose overclaims after the change.**
- *Artifacts:*
  - S-012 Purpose L30-34 (`--skills-only` lets an operator upgrading "by any route" "pick up a skill a newer release adds").
  - S-012 Purpose L19-21 ("installs the shipped pi skill package").
  - S-012 Files created L139-140.
- *Conflict:* both Purpose statements stop being true for `the-intern-docs`.
- *Resolution:* the S-012 amendment qualifies them as covering embedded runtime skills only. L139-140 is correct as written and only needs a clarifying note. The Verification section L165-169 stays unchanged, because the per-file semantics of hand-run `--skills-only` remain.

**N8. Other S-011 locations the CR's list misses.**
- *Artifacts:*
  - S-011 Workflow L218 ("Operator installs the skill package").
  - S-011 Exclusions L64-65 ("bob … does not read, validate, or understand skill files").
- *Resolution:*
  - Amend the Workflow line to name `install.sh` / `bob init` as the installers.
  - L64-65 still holds. Breakdown constraint: if "replaced in full" is implemented inside the binary (for example `--skills-only --force` plus stale-file removal), that code must never enumerate or touch `the-intern-docs/`. Otherwise item 3's "no `bob init` mode … knows about it" breaks.

**N9. S-010 — no amendment needed. Remove it from the list, or keep it as an optional wording fix.**
- *Artifacts:*
  - S-010 Exclusions L58-60 ("an initial, adjustable sketch, not committed final policy").
  - S-010 Component 3 Interfaces L258 ("the taxonomy is fixed at release time — adding or changing a category means shipping a new version of the package, because a deployed workspace's skill content is replaced on upgrade and local additions would not survive it").
- *Finding:* S-010 never presents the category references as editable in place. L258 already says the opposite, and under CR-012's non-destructive refresh it had drifted from reality. CR-016 brings the two back into agreement.
- *Resolution:*
  - Correct CR-016 Potential Impact L154-155: S-010 describes the taxonomy as adjustable through releases, not by operators.
  - Optionally, change the stale phrase "a deployed workspace's skill content" (L258, pre-ADR-014 wording) to "the installed skill content".

**N10. ADR-014 — no amendment needed (confirmed).**
- Decisions §1-§8 all still hold:
  - Delivery is unchanged.
  - The set is still always active (§2): one more skill, the same for every session.
  - The default location is unchanged (§3).
  - Fail-open applies to Cargo builds with no docs skill (§4).
  - The trusted-input rule still applies (§7, see N2).
  - No new authority (§8).
- ADR-009's `data` bucket ("read-only, architecture-independent application assets") supports skill content being release-owned.
- S-001 L104/L156-164, S-002 L462/L515-519, S-003 L285-304 and S-004 L46-52 are unaffected.
- ADR-016 and S-014/S-015 are unaffected. Their "set of four" statements are historical Amendment-Log or phase text, and the embedded set stays at four.

**N11. Record an ADR when the CR is applied (Architect action, after human approval).**
- Proposed title: "Installed skills are release-owned and replaced in full on install; the manual skill ships in the install bundle, not the binary".
- *Why:* this reverses a stated property of CR-012 and S-013 (operator edits survive). It removes any supported customisation point for skill content, and it introduces a second skill route (bundle file tree) beside the embedded one. Any future skill, or any future customisation mechanism, has to respect these choices, so they belong in an ADR rather than spread across three spec amendment logs.
- Not created now, because the CR is `pending` and B2/B3 are still open.

**N12. Breakdown notes (no spec impact).**
- Tests that pin the old behaviour and must change:
  - `install-bundle/test-install.sh` L378 (`assert_not_contains … "--force"`) and the related "existing skill files kept" expectations.
  - `.github/workflows/test_deploy_workflow.py` L334-336 and L400-402 (bundle contents).
- `deploy.yml` staging steps (L33-44 macOS, L123-134 Linux) and `install-bundle/README.txt` (contents list L3-7) change.
- Naming: the existing release asset is `the-intern-docs-<tag>.tar.gz`. Substring-based assertions on bundle contents should match the staged directory specifically so they cannot pass on the archive name.
- Copied pages must never be named `SKILL.md`, so pi's recursive discovery does not pick up a page as a separate skill.
- Dev helpers (`scripts/run-bob-dev.sh`) get no docs skill. The CR accepts this.

## "Possible Spec Amendments" section — audit

| Entry | Verdict |
|---|---|
| S-011 | Correct, but incomplete. Add Design Principle L81-83 (B1), Workflow L218 (N8), and the action-rule reads in the requirement list (N1). Responsibility row L148 must reflect the B2 decision. |
| S-012 | Correct, but incomplete. Add Purpose L19-21 and L30-34 (N7), Principles L52-54, and Responsibilities L71 (B1). |
| S-013 | Correct, but incomplete. Add Design Principles L100 and L110-111 (B3, N4), Purpose L31-34, Exclusions L49-54, the Responsibility rows L169-172, Component 2, Component 3 Interfaces, Workflow L223/L231/L255-257, Implementation Order, owner-only modes (N2), and install-path resolution (N3). |
| S-007 | Correct, but incomplete. Add Component 2 L149-151 and Phase 2 L294 (links to development material), `SUMMARY.md` handling, and CLI-reference link handling (N5). |
| S-010 | Wrongly included as required. No amendment is needed (N9). Correct the CR's own Potential Impact wording. |
| ADR-014 | Correctly expected to need no amendment (N10). |
| Missing | No other spec needs an amendment. A new ADR is recommended when the CR is applied (N11). CR-012's Alternative 2 should be named in the supersession note (N6). The operator guide's and `bob-skills/README.md`'s action-rule listings should be added to item 7 (N1). These are manual and README content, not specs. |

## Pending and in-progress task overlap

- `docs/ai-team/tasks/pending/` and `docs/ai-team/tasks/in-progress/` are empty (only `.gitkeep`).
- CR-013's T-202 – T-213, and T-214 / T-217 – T-219, are all in `tasks/completed/`. That includes:
  - T-211 (operator guide worklog prose);
  - T-212 (`bob-skills/README.md` worklog prose);
  - T-201 (the CR-012 `install.sh` `--skills-only` call).
- `bugs/open/` and `bugs/in-progress/` are empty.
- No in-flight work touches `install.sh`, `test-install.sh`, `deploy.yml`, `test_deploy_workflow.py`, `install-bundle/README.txt`, `bob-skills/README.md`, `package-pi-skills.sh`, `build.rs`/`init_materializer.rs`, or the operator guide.
- Spec-breakdown has no file-conflict ordering to account for outside the new CR-016 tasks themselves. Within those, the operator guide, `install.sh`, and `test-install.sh` will each be touched by several tasks and need explicit dependency ordering.

## Corrections routed

- CR-016 (B1, N1 – N9 wording): Planner revises the CR draft.
- CR-016 (B2, B3): Planner forwards to the Human for decision, then records it in the CR.
- S-011, S-012, S-013, S-007: Planner applies the approved-spec amendments once the CR is revised and approved. The scope is widened as listed in the audit table.
- New ADR (N11): Architect records it when the CR is applied.

---

## Follow-up review (2026-10-13, revised CR-016)

```text
Result: FAIL

Artifact reviewed: docs/ai-team/change-requests/CR-016-bob-supplied-skill-that-answers-questions-about-bob-from-the-shipped-manual.md (revised, status pending)
Binding set checked: 16 accepted ADRs, 14 approved specs; applied CR-012, CR-007, CR-011

Next owner:
- Planner (CR wording revision; no further Human decision needed)
```

The human decisions since the first review are taken as given: bundle-only
docs-skill sources, replacing only the skills the release ships, check before
write with all-or-nothing on decline, `-y`, and configuration out of scope
(#140, #139). Both remaining blocking findings are wording gaps the Planner
can close without a new human decision.

### (1) Disposition of the first review's findings

| Finding | Status | Where in revised CR |
|---|---|---|
| B1 source location / embedding | Resolved | Item 2 L42-49; item 3 L61-63; S-011 and S-012 amendment entries L253-265 |
| B2 deletion scope | Resolved | Item 4 L99-105 |
| B3 never silently overwrite | Resolved, with gaps F2–F4 below | Item 4 L73-98 |
| N1 action-rule listings | Resolved | Item 6 L134-142; item 8 L157-159 |
| N2 owner-only modes | Resolved | L110-113 |
| N3 path resolution / override | Resolved (override accepted as a limitation) | L17-19, L110-116 |
| N4 S-013 locations; copy is not a build | Resolved | L50-54; S-013 entry L266-273 |
| N5 S-007 links, SUMMARY, CLI stub | Resolved | Item 7 L144-151; L54 |
| N6 CR-012 Alternative 2 | Resolved | L66-71 |
| N7 S-012 Purpose | Resolved | S-012 entry L260-261 |
| N8 S-011 Workflow; bob-side never touches the docs skill | Resolved | L62-63, L126, L155 |
| N9 S-010 | Resolved | L214-216, L223-226, L281-282 |
| N10 ADR-014 | Resolved | L281-282 |
| N11 new ADR | Resolved | L278-280 (see F6 on its scope) |
| N12 tests, naming, `SKILL.md`, dev setup | Resolved | L55, L237-245 |

### (2) New findings on the revised text

#### Blocking (wording in the CR)

**F1. `-y` contradicts an S-013 exclusion the CR does not declare withdrawn.**
- *Artifacts:*
  - S-013 Exclusions L80-82: "**Unattended/non-interactive install.** `install.sh`'s overwrite confirmation is interactive-only in this version; a `--yes`-style flag for scripted/CI use is out of scope."
  - CR-016 L95-98 (new `-y`).
- *Conflict:* the CR adds exactly the flag S-013 excludes. Its S-013 amendment entry (L266-273) says only "Exclusions", which the first review tied to the `bob init` carve-out at L49-54.
- *Resolution:* the CR states that S-013's "Unattended/non-interactive install" exclusion is withdrawn and replaced by `-y`. The S-013 entry names that exclusion explicitly. The human decision is authoritative.
- Route: Planner (CR wording).

**F2. A confirmed install promises skills identical to the release, but the skill step may fail without blocking.**
- *Artifacts:*
  - CR-016 L17-19 ("A confirmed install … leaves … every runtime skill the release ships identical to that release's").
  - L117-119 (the `--skills-only` call's failure stays non-blocking).
  - L218-219 ("never a partial one").
  - S-013 Configuration Requirements L329-331 and CR-012 L47-50 (non-blocking pattern).
- *Answer to the coordinator's question:* yes, a non-blocking failure after confirmation is coherent with all-or-nothing on decline. They govern different moments:
  - The all-or-nothing guarantee is about the operator's consent. Declining changes nothing.
  - The non-blocking guarantee is about execution failures after consent. A skill-step failure must not undo or fail an otherwise-good binary install.
  - This matches the existing `pi`-check pattern and CR-012.
  - It is only coherent if the CR says so explicitly. As written, L17-19 promises identical skills unconditionally, and L218-219 reads as "never partial" in general.
- *Resolution:* the CR adds a failure contract for the write phase:
  - Qualify L17-19 and L218-219: the all-or-nothing guarantee covers declining, and the write phase is not transactional.
  - A failure in either skill step — the runtime-skill replacement (`--skills-only` route) or the docs-skill copy, whose behaviour the CR does not currently specify — warns, names the skills that may not match the release, and leaves the binary and extension installed.
  - State whether the exit status is 0 (as for today's `--skills-only` warning) or non-zero.
  - Recovery is to rerun `install.sh` (with `-y` if needed), **not** a hand-run `bob init --skills-only --force`. That command neither removes stale files nor installs `the-intern-docs`, and the operator-guide upgrade text must say so.
- Route: Planner (CR wording).

#### Non-blocking (fold into the CR or the S-013 / S-012 amendment text)

**F3. What happens when the check cannot complete.**
- *Artifacts:* CR-016 L75-84; S-013 Design Principles L110-111 (to be extended to skills).
- *Conflict:* the CR doesn't say what happens if the pre-write comparison can't run, for example if the bundled binary's check route fails or an installed file is unreadable. If `install.sh` then proceeded without asking, it would silently overwrite, which breaks the principle the CR extends.
- *Resolution:* the CR states that an incomplete check counts as "would overwrite". The operator is prompted, or `-y` applies, and with no input the install aborts unchanged.

**F4. The extension is left out of "everything the install would change".**
- *Artifacts:* CR-016 L75-79 (the check covers the binary and skill files) versus L88-89 ("no binary, extension, or skill is written" on decline); current `install.sh` L133 (overwrites `bob.ts` unprompted).
- *Conflict:* an existing `bob.ts` that differs from the release, with no binary at `~/.local/bin/bob` (for example a `mise` install plus an earlier zip install), is still overwritten without a prompt. That contradicts "determines everything the install would change" and the extended principle.
- *Resolution:* either include the extension in the content compare, or state that it is deliberately excluded as release-owned and unprompted, as today. The S-013 amendment records whichever is chosen.

**F5. The breakdown routes may need S-012 CLI or S-013 Component 3 amendments the list doesn't name.**
- *Artifacts:*
  - CR-016 L82-84 ("for example a check-only mode of the bundled binary") and L123-126 (`--skills-only --force` plus stale removal, "or another route").
  - S-012 Configuration Requirements → CLI L105-123, Workflow L87-90 and Verification L165-169 (closed flag set: `<path>`, `--force`, `--skills-only`).
  - S-013 Component 3 L194 (the only binary invocation is the just-installed binary's `init --skills-only`).
- *Conflict:*
  - A check-only or prune flag would be a new `bob init` mode. That is the same unsanctioned-flag situation CR-012 was created to correct.
  - Running the **bundled** binary before install (for the check) is a new `install.sh` interface not covered by S-013 Component 3.
  - Some routes need neither. For example, `install.sh` can run the bundled binary's existing `init --skills-only` against a temporary `XDG_DATA_HOME` and compare that tree with the installed one.
- *Resolution:* the CR adds to the S-012 entry: "CLI contract, Workflow, and Verification, **if** the breakdown adds a check-only or prune capability to `bob init`". It also adds to the S-013 Component 3 entry: "any invocation of the bundled binary before install (check phase)". Otherwise Gate 2 would have to fail a task that needs a spec change.

**F6. Scope of the new ADR.**
- *Artifact:* CR-016 L278-280.
- *Resolution:* also record check-before-write with all-or-nothing on decline, and `-y` as the only unattended route. These are durable install-policy decisions that every future bundle-shipped asset must respect, so they belong with "release-owned, replaced in full".
- Route: Architect, when the CR is applied.

### (3) Consistency of the revised text with the binding set

- **S-013 existing-install prompt workflow** (Workflow L245-249; current `install.sh` L100-114). The revised design generalises it: same abort-unchanged on decline, same abort when no input is available. Workflow L245-247 must become "check binary and skills (and the extension, per F4) → single prompt". This is covered by the S-013 "Workflow" entry and needs no further change beyond F1–F5.
- **CR-012** (applied). What it still keeps — `--skills-only` as a sanctioned mode, invoked through the just-installed binary, non-blocking — is consistent with the revision once F2 is in place. Its Alternative 2 is now declared (L66-71).
- **S-011, S-012, S-007, S-010, ADR-009, ADR-014, CR-007, CR-011, S-001 – S-004**: no new conflict.
  - S-011 L95-97 now also binds the docs skill's `SKILL.md` and index in `install-bundle/`, which item 7 and the coding guidelines already require.
  - CR-007's broad first-run profile is correctly cited in item 6.
- **Configuration:** `install.sh` still reads and writes no config (S-013 L100-103, L194), and L114-116 and L172-176 hold.

### (4) Possible Spec Amendments — completeness

| Entry | Verdict |
|---|---|
| S-011 | Complete. |
| S-012 | Complete, apart from the conditional CLI / Workflow / Verification amendment (F5). |
| S-013 | Missing: the "Unattended/non-interactive install" exclusion L80-82 must be named and withdrawn (F1); Component 3 must cover any pre-install invocation of the bundled binary (F5); the write-phase failure contract (F2), incomplete-check rule (F3) and extension treatment (F4) belong in Design Principles, Component 3 and Configuration Requirements. |
| S-007 | Complete. |
| New ADR | Present; widen its scope (F6). |
| S-010, ADR-014 | Correctly listed as needing no amendment. |

### Corrections routed (follow-up)

- CR-016 F1 and F2 (blocking), F3 – F5: Planner revises the wording. No Human decision is needed: each follows from decisions already made.
- New ADR scope (F6): Architect records it when the CR is applied.
- Once F1 and F2 are in the CR, a PASS is expected without a further full review. The Architect only needs to check those two edits.

---

## Second follow-up review (2026-10-13, F1 – F6 edits only)

```text
Result: PASS

Artifact reviewed: docs/ai-team/change-requests/CR-016-bob-supplied-skill-that-answers-questions-about-bob-from-the-shipped-manual.md (revised, status pending)
Binding set checked: the F1 – F6 edits, re-checked against S-012, S-013, CR-012, ADR-014 and the code `bob init --skills-only` runs (config.rs, init_materializer.rs)

Next owner:
- Planner (apply the CR's amendments once the human approves; carry G1 and G2 into the S-013 amendment and the breakdown)
```

### Disposition

| Finding | Status | Where in revised CR |
|---|---|---|
| F1 `-y` versus the S-013 exclusion at L80-82 | Resolved | Item 4 L114-116; S-013 entry L299-301 |
| F2 promise versus failure contract | Resolved | L17-21; Context L245-248; item 4 "Write-phase failures" L124-133; S-013 entry L307-309. "Exit 0" is consistent with CR-012's non-blocking rule. The recovery path is correct (rerun `install.sh`). |
| F3 a check that cannot complete | Resolved | L95-99 |
| F4 extension included in the check | Resolved | L79-80, L102, L105-106; S-013 entry L298-299, L305 |
| F5 implementation route | Resolved | L85-94: the staging run uses the bundled binary's existing `init --skills-only` with a temporary `XDG_DATA_HOME`, so no new `bob init` mode is needed. I checked this against the code: `default_skill_install_path_for_env` honours an absolute `XDG_DATA_HOME` on both platforms, and `--skills-only` writes no config or workspace files. S-012's command-line rules are correctly left unchanged (L295-296). The bundled binary still bypasses any `bob` on `PATH`, which was CR-012's reason for naming the binary explicitly. |
| F6 ADR scope | Resolved | L316-319 |

### New findings from the edits (non-blocking; no CR revision needed)

**G1. S-013's `bob init` carve-out (Exclusions L49-54) needs rewording, not just the unattended-install exclusion.**
- The carve-out currently reads "`install.sh` MAY invoke it … immediately after installing the binary — it touches only the shared skill install path".
- Under the new route, the invocation happens **before** installing, uses the **bundled** binary, and touches only a temporary data directory. The carve-out's purpose — no workspace and no `config.toml` touched — still holds. Only its wording goes stale.
- The S-013 entry's "Exclusions" item should cover this exclusion as well as the withdrawn unattended-install one. The Planner can do this while applying the amendment; no CR revision is needed.

**G2. Where the staging directory lives, versus S-013's Design Principles L88-89.**
- That principle reads: installing bob must never "write outside the current user's home directory".
- A default `mktemp -d` places the staging tree in `$TMPDIR` (usually `/tmp`), which is outside the home directory.
- Breakdown constraint: create the staging directory under the user's home, for example beside the resolved skill install path in the same XDG data bucket. That also lets the final replacement be a rename on the same filesystem. Alternatively, the S-013 amendment states explicitly that the principle allows a private temporary directory that is removed afterwards. The first option needs no spec change.

No other new conflict was found:
- The write order (binary → extension → skills) keeps CR-012's rule that the binary install isn't failed by a skill problem.
- Confirming through a failed staging step degrades to "skills unchanged plus a warning", which ADR-014 §4 (fail-open) and S-011's "missing skills degrade, not prevent" both accept.
- On abort, nothing is written outside the staging directory, so the all-or-nothing guarantee on decline holds.

### Corrections routed (second follow-up)

- None blocking. The CR is ready for human approval.
- When applying it: the Planner carries G1 into the S-013 amendment and G2 into the S-013 amendment or the breakdown. The Architect records the widened ADR.

---

## Third follow-up review (2026-10-13, item 4 rewritten: the binary stands in for the release)

```text
Result: PASS

Artifact reviewed: docs/ai-team/change-requests/CR-016-bob-supplied-skill-that-answers-questions-about-bob-from-the-shipped-manual.md (revised, status pending)
Binding set checked: rewritten item 4, opening paragraph, Context L242-248, S-012/S-013/New ADR entries, against S-011, S-012, S-013, CR-012, ADR-009, ADR-014; regression check of B1 – B3, N1 – N12, F1 – F6, G1 – G2

Next owner:
- Planner (Human approval of CR-016; fix H1 wording at application; H2 – H3 go to breakdown)
```

The human's new design is taken as given:
- no comparison of skill content and no staging step;
- today's binary prompt is kept, plus a warning when the installed binary differs from the bundled one;
- with no binary installed, there is no prompt, only a note;
- every install removes each release-shipped skill and installs it fresh;
- the "never silently overwrite" principle stays scoped to the binary.

### Consistency with the binding set

- **S-013:**
  - Design Principles L110-111 stay scoped to the binary (L97-99). That is option 1 of B3, chosen by the human, and the S-013 entry records it (L296-297).
  - The existing-install prompt, Workflow L245-247 and current `install.sh` L100-114 are kept unchanged; only a warning before the prompt and `-y` are added.
  - The unattended-install exclusion (L80-82) is withdrawn explicitly (L103-105, L298-300).
  - The `bob init` exception (L49-54) is now true as written again: `install.sh` invokes `--skills-only` "immediately after installing the binary" and it "touches only the shared skill install path". The wording update the entry lists (L300-301) is still appropriate, because `install.sh` now also removes release-shipped skill folders itself.
  - Configuration Requirements L320-332 ("operator's own edits … never overwritten") are superseded and covered by the entry's "Configuration Requirements" item.
- **CR-012:** the route it introduced is kept: `--skills-only` through the just-installed binary, not a `bob` found on `PATH`, and non-blocking on failure (L142-144). Only the per-file "left untouched" outcome is superseded, and the CR declares that (L145-147). The rejection of Alternative 2 is still declared for the docs skill only (L68-73).
- **S-012:** no new `bob init` mode or flag. S-012's command-line rules, Workflow and Verification are correctly left unchanged (L294-295). Hand-run semantics are unchanged (L148-149).
- **S-011, ADR-009, ADR-014:**
  - The install path is still the default resolved from the environment (L134-141).
  - Owner-only modes are kept (§7).
  - A skill step that fails after removal leaves skills missing, not stale, and ADR-014 §4 (fail-open) covers that (see H2).
  - The ADR-009 `data` bucket as release-owned static assets is unchanged.
- **S-007, S-010, CR-007, CR-011:** these sections were not touched; nothing regresses.

### Regression check

| Finding | Status |
|---|---|
| B1, B2 | Unchanged and resolved (L44-51; L115-117). |
| B3 | Resolved by the human's choice of scoping to the binary (L97-99). Skill replacement without a binary stays visible through the printed note. |
| N1 – N12 | Unchanged and resolved (items 2, 3, 6, 7, 8; L134-141; Potential Impact; amendment list). |
| F1 | Retained (L103-105). |
| F2 | Retained: failure contract L121-129, opening paragraph L17-21, Context L246-248. |
| F3 | Replaced by its equivalent for the binary: a byte comparison that cannot complete counts as different (L86-87). There is no skill check left to fail. |
| F4 | Superseded by the human decision: the extension is not checked separately; the different-binary warning names it (L88-90), and the principle is scoped to the binary. Accepted. |
| F5 | No longer applies: there is no staging step and no new `bob` mode. Knowing the runtime skill names is a breakdown decision, checked by a test (L117-120). |
| F6 | The ADR entry is updated for the new design (L314-318). |
| G1 | Covered (L300-301). |
| G2 | **No longer applies (confirmed).** There is no staging folder. The only temporary file `install.sh` writes is the sibling of the binary in `~/.local/bin`, which is under the home directory, so S-013 L88-89 holds. |

### New findings (non-blocking)

**H1. Some text still says "confirmed install" or mentions a "second confirmation".**
- L252 ("lost on a confirmed install"), item 8 L181, the S-011 entry L285-286 and the New ADR entry L314-315 all say skills are replaced on a *confirmed* install. Under the new design, they are replaced on **every** install, including one with no binary and no prompt (L93-96). If the amendments copy "confirmed", they will be wrong for the no-binary case.
- L258-260 still says piped-`y` scripts "may now meet a second confirmation". There is only one prompt now, so a piped `y` still answers it. `-y` remains the supported route.
- L127-129 explains why a hand-run `bob init --skills-only` is not a substitute by saying it "neither replaces existing files without `--force` …". After `install.sh` has removed the release-shipped folders, a hand-run `--skills-only` *does* restore the runtime skills. The conclusion still stands because it never installs the docs skill, but the stated reason should be just that.
- Route: Planner. Fix the CR wording, or carry the correct wording into the S-011 and S-013 amendments and the ADR when applying.

**H2. A failed skill step now leaves skills missing, not stale.**
- Folders are removed before `--skills-only` runs. If the call or the docs copy then fails, sessions start without those skills: ADR-014 §4 fail-open, and S-011's "missing skills must degrade a session, not prevent it". A scheduled email-triage job would run with no skilled behaviour until `install.sh` is rerun.
- This is consistent with the binding set and the CR covers it ("may be missing", L124). The operator guide's upgrade section should state it, and the failure warning should be clearly visible.
- Route: breakdown.

**H3. Breakdown safety constraint for the removal step.**
- `install.sh` must delete only `<resolved default skill path>/<name>` for each name the release ships.
- It must abort the skill step, without deleting anything, if the resolved path or any name is empty.
- It must not follow a symlinked skill folder out of the install path.
- Route: breakdown, enforced by a test in `test-install.sh`.

### Corrections routed (third follow-up)

- None blocking. CR-016 is ready for human approval.
- H1: Planner wording, in the CR or at amendment time.
- H2, H3: spec-breakdown constraints.
- New ADR: Architect records it when the CR is applied, using the L314-318 scope with "every install" wording (H1).

---

## Fourth follow-up review (2026-10-13, prompt covers installed skills; bob owns the default skill install path)

```text
Result: PASS

Artifact reviewed: docs/ai-team/change-requests/CR-016-bob-supplied-skill-that-answers-questions-about-bob-from-the-shipped-manual.md (revised, status pending)
Binding set checked: rewritten item 4, Context L252-262, Potential Impact L266-274, S-011/S-012/S-013/New ADR entries; against S-010, S-011, S-012, S-013, ADR-009, ADR-014, CR-012; operator-facing docs (operator guide, bob-skills README, bob-companion bob-setup, pi-extension README, install-bundle README.txt, repo README)

Next owner:
- Planner (Human approval of CR-016; K1 – K3 go into the S-013 amendment or breakdown)
```

Human decisions taken as given:
- The prompt appears when a binary exists **or** when the default skill install path holds skills.
- S-013's "never silently overwrite" principle is extended to installed skills.
- The default skill install path belongs to bob alone and is emptied and refilled on every install.
- A configured `skill_install_path` override is never emptied.

### Does anything let operators place their own skills in the default skill install path?

No. Every binding statement either describes the location as bob-owned, read-only release content, or is silent:

- **ADR-009** L49, L58: the `data` bucket is "for read-only, architecture-independent application assets" belonging to bob.
- **ADR-014** §3: skills default to a directory in the `data` bucket "alongside the extension … which is the bucket for read-only architecture-independent application assets — which is what skill content is". §7 requires owner-only protection and says nothing about operator-added content. The Consequences say "skill content itself can be a shared read-only install".
- **S-011** L148: the install path is "the deployed, read-only location bob resolves". Workflow L218: "Operator installs the skill package" — the shipped package, not additional skills.
- **S-012** L52-54: the binary "materializes [the pi package] once into the shared install path". L139-140 lists exactly the four embedded trees.
- **S-010** L479-481: bob installs "that package" to the shared install path.
- **Operator-facing docs:** I searched for wording about own, custom, additional or extra skills, or adding a skill, and found none that refers to the install path. The operator guide's "Install the skill package" section (L191-258) covers only the packaged skills and the `skill_install_path` override. `bob-companion/claude/skills/bob-setup/SKILL.md` L89 refers to a workspace `.pi/skills/` copy, not to the install path.
- An operator who wants a different location has the `skill_install_path` override, which `install.sh` never empties (L147-150). That matches ADR-014 §3 and S-013's "reads no configuration".

The CR's "belongs to bob alone" (L80-84) and the S-011 entry (L299-300) therefore make explicit what the binding set already implies. There is no contradiction to route.

### Consistency with the binding set

- **S-013:**
  - Design Principles L110-111 are extended to installed skills, and the S-013 entry says so (L310-311). This is option 2 of B3.
  - The existing binary prompt, abort on decline, abort with no input, and the `-y` withdrawal of exclusion L80-82 (L109-111) are all consistent.
  - The `bob init` exception at L49-54 needs rewording, because `install.sh` now also empties the folder. The entry covers this (L314-315).
  - Configuration Requirements L320-332 are superseded and covered by the entry.
- **CR-012:** its route is kept: the just-installed binary, not a `bob` found on `PATH`, and non-blocking on failure (L151-153). The superseded per-file outcome is declared (L154-156).
- **S-012:** no new `bob init` mode, so S-012's command-line rules are unchanged (L308-309). The per-file semantics of `--skills-only` are untouched; it simply runs against an empty folder.
- **ADR-014 §4 and S-011's "missing skills degrade a session"** cover a skill step that fails after the folder is emptied (L131-136).
- **A relative `XDG_DATA_HOME`:** `install.sh` rejects it before writing anything (current behaviour, S-013 L284-287), so it never reaches the removal step, even though bob's resolver falls back to the platform default in that case (operator guide L253-258).

### Regression check

| Finding | Status |
|---|---|
| B1 | Unchanged and resolved. |
| B2 | Now the human's option (b): the whole default path is bob-owned (L80-84, S-011 entry L299-300). The deletion boundary is stated (L122-125). See K2 for the release-notes callout. |
| B3 | Now option 2 (the prompt covers skills, L85-95), and the S-013 entry is updated. |
| N1 – N12 | Unchanged and resolved. |
| F1 | Retained (L109-111). |
| F2 | Retained (L17-21, L126-138, Context L259-262). |
| F3 | Retained in its binary form (L97-98). |
| F4 | The extension still has no prompt of its own on a fresh install. This matches today's behaviour; it was accepted in the third pass and the warning names the extension. |
| F5, G2 | No longer apply: there is no staging step. |
| F6 | ADR entry updated (L329-333). |
| G1 | Covered (L314-315). |
| H1 | Fixed: "every install" at L266, L190 and L300; the single prompt at L272-274; the hand-run reason at L136-138; "confirm (or run with `-y`)" at L269, which is accurate now that every non-fresh install prompts. |
| H2 | Fixed (L131-136; item 8 L190-192). |
| H3 | Fixed and adapted to the whole-folder design (L122-125). See K1. |

### New findings (non-blocking; breakdown or amendment wording)

**K1. Removal safety when the skills folder itself is a symlink.**
- L122-125 forbids following a symlink *out of* the folder. If `<data dir>/bob/skills` is *itself* a symlink — an operator could have pointed it at another location instead of using the override — emptying it would delete the target's contents.
- The constraint should say: if the resolved path is a symlink, remove the link or refuse; never empty its target. Cover this in the same `test-install.sh` test.
- Route: breakdown, and the removal-safety rules in the S-013 amendment.

**K2. Release notes should mention that unexpected folders are removed.**
- L266-271 calls out lost local edits. Because the whole path is now emptied, any non-bob folder an operator placed there anyway is also deleted.
- No binding text ever sanctioned that, so this is not a contradiction. One sentence in the release-notes callout, and the operator guide's upgrade text ("this folder is managed by `install.sh`; do not keep anything else in it"), closes the gap.
- Route: Planner, through CR item 8 and the release notes.

**K3. What "holds any skills" means for the prompt.**
- L86 triggers the prompt when the default path "holds any skills", but L114 empties the path of *everything*.
- For "never silently overwrite" to hold, the prompt should trigger on any entry in the folder, not only folders that look like skills. Otherwise a folder holding only non-skill leftovers is emptied without a prompt.
- Route: breakdown, and the wording in S-013 Component 3.

### Corrections routed (fourth follow-up)

- None blocking. CR-016 is ready for human approval.
- K1, K3: S-013 amendment wording and breakdown constraints, test-covered.
- K2: Planner, release-notes and operator-guide wording.
- New ADR: Architect records it when the CR is applied, using the L329-333 scope.

---

## Fifth follow-up review (2026-10-13, full re-check: the docs skill is delivered like the runtime skills)

```text
Result: FAIL

Artifact reviewed: docs/ai-team/change-requests/CR-016-bob-supplied-skill-that-answers-questions-about-bob-from-the-shipped-manual.md (rewritten, status pending)
Binding set checked: 16 accepted ADRs, 14 approved specs; applied CR-007, CR-011, CR-012 (and CR-009/CR-010/CR-013 for skill-set listings); implementation facts: service/crates/bob/build.rs, bob-skills/package-pi-skills.sh, bob-skills/test_package_pi_skills.sh, root .gitignore, .github/workflows/deploy.yml

Next owner:
- Planner (one wording correction, P1; no Human decision needed)
```

Human decision taken as given: `the-intern-docs` lives in the canonical
source, goes through the pi packaging target, is embedded in the binary and is
installed by every `bob init` mode that installs skills. The manual pages are
copied in at build time and never committed. Install bundles and release
assets are unchanged.

### Blocking

**P1. One of the two copy steps the CR allows breaks "never committed" or "a Cargo build carries the docs".**
- *Artifacts:*
  - CR-016 item 3 L60-62: "Which build step produces the copy (the pi packaging step or the binary's build script) is a breakdown decision".
  - CR-016 item 2 L46-47: "A bob obtained any way — release install, `mise`, or a Cargo build — carries the docs of its own version".
  - CR-016 item 3 L53-56: "never committed".
  - S-011 Design Principles L81-83: content exactly once in the repository.
- *Implementation facts:*
  - `the-intern/bob-skills/.pi/skills/` is a **tracked** tree. The root `.gitignore` L4-6 excludes only the repo-root `/.pi`, and `init_assets.rs` describes it as "the canonical tracked … tree".
  - `package-pi-skills.sh` is run by hand and its output is committed.
  - `build.rs` L13-14 embeds whatever happens to be under `bob-skills/.pi/skills` at build time and does not run the packaging script.
- *Conflict:* if `package-pi-skills.sh` copies the manual pages, they land in that tracked tree. Then one of two things happens:
  - (a) They are committed. That creates a second copy of the manual, contradicting S-011 L81-83 and the CR's "never committed".
  - (b) They are carved out with an ignore rule. Then a plain `cargo build -p bob` from a clean checkout (the Cargo and source routes) embeds `the-intern-docs/SKILL.md` and an index pointing at pages that do not exist. That contradicts L46-47, and it fails silently.
- *Resolution:* the CR fixes the constraint, not the mechanism:
  - The copy must never be written into a tracked tree.
  - A plain `cargo build -p bob` from a clean checkout must embed the pages, or fail with a clear error if they cannot be produced. This mirrors S-007's "No silent failure of generated content" principle (S-007 L78-81).
  - In practice that means `build.rs` copies them from `the-intern/docs/src/`, or the packaging step writes to an untracked location that `build.rs` regenerates or checks.
  - The packaging step still handles the docs skill's `SKILL.md` and topic index like any other skill: they gain `allowed-tools` and are added to `skill_names` in `package-pi-skills.sh` L10.
- Route: Planner (CR wording in item 3; the S-011 Component 2 and S-012 "Embedded pi-package assets" entries should carry the same constraint).

### Specific re-checks requested

- **S-011 "content exactly once" with a copy generated at build time:** holds, provided P1 is fixed.
  - The manual in `the-intern/docs/src/` is the single committed source of the pages.
  - The skill's canonical source holds only `SKILL.md` and the index (L50-56).
  - The embedded copy lives in the build output, like every other embedded asset.
  - The CR's S-011 entry correctly names Design Principles, Component 1 (the manual as a second canonical input) and Component 2.
  - Side note: Component 1 L165-166 says the canonical source "exposes skill content as instruction documents with relative references". In the source tree the docs skill's index points at pages that exist only after the build, and the drift test covers that. The amendment should say so (see Q3).
- **S-012's wording about the embedded set:**
  - The entry covers Principles L52-54, the "Embedded pi-package assets" row L71 (now two inputs), Files created L139-140 (five trees), Verification, and the `install.sh` use of `--skills-only`. That is complete.
  - S-012 Purpose L19-21 and L30-34 ("pick up a skill a newer release adds", by any route) are **true again**, so dropping them from the entry is correct (N7 closed by design).
- **`build.rs` reading files outside the `bob-skills` package:**
  - No accepted ADR or approved spec limits what the build script may read. It already reads outside its own crate (`../../../bob-skills/.pi/skills`).
  - ADR-003 is about the admin-client crate boundary, not build inputs.
  - S-012 L71 is the only binding statement that names the embedded input, and it is in the amendment list.
  - There is no build cycle: bob reads the manual *source*, while the docs build (S-007) reads the source plus `bob --help`. The CLI-reference stub is excluded from the copy, so generated reference output never feeds back into the binary.
  - Breakdown notes:
    - `build.rs` must emit `rerun-if-changed` for `the-intern/docs/src/`, or a manual edit will not rebuild bob.
    - The relative path ties the bob crate to the monorepo layout, exactly as the existing `bob-skills` path already does. That is acceptable because bob is not published as a standalone crate.
- **S-007 / S-013 "one docs build per release" contract, given that the macOS job also builds bob:**
  - Unaffected. Each job's `cargo build` *copies* markdown into the binary. That is not an mdBook build and not a CLI-reference build.
  - S-007 L282-287 (exactly one docs archive, produced alongside the CLI reference against the Linux binary) and S-013 L104-107 / L169 (the macOS job "does not build docs") both still hold.
  - The macOS job needs only the repository checkout it already has, not mdBook.
  - The S-007 entry should say "copied at bob build time; not a docs build" so the contract stays explicit. The CR states this in item 3 L56-58, and the amendment should carry it.

### Regression check

| Finding | Status |
|---|---|
| B1 | Re-resolved by the new decision. The docs skill is in the canonical source and embedded. S-011 and S-012 entries are updated. The bundle-only source and "bob-side never touches" are correctly removed. |
| B2 | Retained (L69-73, L101-109). |
| B3 | Retained (L74-84). |
| N1 | Retained (item 6). |
| N2 | Now automatic: `bob init` writes owner-only (L130-133). The zip-extraction concern is gone. |
| N3 | Retained (L133-136). |
| N4 | Correctly narrowed. Bundle contents and assets are unchanged (L189-191), and S-013 is amended only for `install.sh` and `README.txt` (L307-319). |
| N5 | Retained (item 7). |
| N6 | No longer applies. There is no Alternative 2 exception, and the Context explains why (L229-236). CR-012's rejection of a plain file tree in the zip now holds without exception. |
| N7 | Closed by design (see above). |
| N8 | Workflow end state is listed. S-011 Workflow L218 ("Operator installs the skill package") stays accurate. "bob-side never touches the docs skill" is correctly dropped. |
| N9 | Retained (Context L245-247; S-010 needs no amendment). |
| N10 | Retained. ADR-014 needs no amendment: delivery is unchanged and the set is still one always-active set. |
| N11 / F6 | ADR scope updated (L324-328). Bundle-only delivery is correctly dropped from it. |
| N12 | Updated. `test_deploy_workflow.py` no longer needs changes. The embedding, `bob init` and `test_package_pi_skills.sh` expectations that pin four skills do (L281-284). The asset-name-prefix note is moot, and the `SKILL.md` naming rule is retained (L59-60). |
| F1 – F3 | Retained. |
| F4, F5, G2 | No longer apply, as before. |
| G1 | Retained (L310-312). |
| H1 – H3 | Retained (H3 reworked as K1, L110-115). |
| K1 – K3 | Resolved (L113-115, L265-269, L75-76). |

### Non-blocking

**Q1. List `package-pi-skills.sh`, `test_package_pi_skills.sh` and `build.rs` among the touched areas in item 8 and the Tests impact.** `package-pi-skills.sh` L10 pins four skill names and its test checks each one. These are source files, not specs; listing them helps breakdown ordering.

**Q2. Installs other than `install.sh` still keep stale docs pages.** `bob init --skills-only` without `--force` leaves existing files alone, and even with `--force` it does not remove stale ones. So after a `mise` or Cargo upgrade the *installed* manual matches the binary only if the operator runs `--skills-only --force`, and pages the release dropped will linger. Item 2 L46-47 is accurate (the *binary* carries its own version's docs), but the operator guide's non-zip upgrade text should say to run `bob init --skills-only --force`. This is consistent with S-012 and needs no amendment.

**Q3. The S-011 Component 1 amendment should note that the docs skill's index refers to pages that exist only in the build output.** Otherwise "exposes skill content as instruction documents with relative references" reads as if the references resolve within the canonical source.

### Corrections routed (fifth follow-up)

- P1 (blocking): Planner fixes the CR item 3 wording and carries the constraint into the S-011 Component 2 and S-012 "Embedded pi-package assets" entries.
- Q1 – Q3: Planner wording, in the CR or at amendment time, plus breakdown notes.
- New ADR: Architect records it when the CR is applied, using the L324-328 scope.
- Once P1 is in the CR, only that edit needs re-checking.

---

## Sixth follow-up review (2026-10-13, P1 and Q1 – Q3 edits only)

```text
Result: PASS

Artifact reviewed: docs/ai-team/change-requests/CR-016-bob-supplied-skill-that-answers-questions-about-bob-from-the-shipped-manual.md (revised, status pending)
Binding set checked: the P1/Q1 – Q3 edits against S-007, S-011, S-012, S-013 and the build facts recorded in the fifth review (tracked bob-skills/.pi/skills, build.rs embedding)

Next owner:
- Planner (Human approval of CR-016, then spec amendments and breakdown)
```

| Finding | Status | Where in revised CR |
|---|---|---|
| P1 | Resolved | Item 3 L60-71 fixes the outcome, not the mechanism. The copy is never written into a tracked directory, and the CR names why the hand-run pi packaging step cannot hold it. A clean `cargo build -p bob` embeds the pages or fails with a clear error, never a `SKILL.md` that points at missing pages, mirroring S-007 L78-81. The build script copies from `docs/src/` and rebuilds when it changes, or regenerates or checks an untracked output. A drift test is required. The same constraint is carried into the S-011 Component 2 entry (L314-315) and the S-012 "Embedded pi-package assets" entry (L318-320). S-011 L81-83 (content exactly once) and item 2's Cargo-build claim now hold under every allowed mechanism. |
| Q1 | Resolved | Item 8 L188-190 lists `package-pi-skills.sh`, its test and the build script. Tests impact L297 adds `test_package_pi_skills.sh`. |
| Q2 | Resolved | Item 8 L192-196 adds the non-zip upgrade note: `bob init --skills-only --force`, and dropped pages or skills linger. This is consistent with S-012's per-file semantics, which stay unchanged. |
| Q3 | Resolved | Item 3 L70-71; S-011 Component 1 entry L312-313. |
| S-007 not-a-docs-build note | Present | S-007 entry L339-342, which also cites S-013's "the macOS job does not build docs". |

The edits introduce no new conflict. They narrow what is allowed and add no
behaviour. Every earlier finding keeps the status recorded in the fifth review.

### Corrections routed (sixth follow-up)

- None. CR-016 is consistent with the binding set and ready for human approval.
- When the CR is applied: the Planner amends S-011, S-012, S-013 and S-007 per the CR's list, and the Architect records the New ADR (L345-349 scope) and runs `architecture-consistency-review` on it.

---

## Seventh review (2026-10-13, CR-016 applied: ADR-017 and the amended S-011 v0.3, S-012 v0.4, S-013 v0.4, S-007 v0.2)

```text
Result: FAIL

Artifact reviewed: docs/ai-team/decisions/ADR-017-the-default-skill-install-path-belongs-to-bob-and-install-sh-replaces-it-as-a-whole-on-every-install.md (accepted)
                   plus the CR-016 amendments to S-011, S-012, S-013, S-007
Binding set checked: 17 accepted ADRs (ADR-001 – ADR-017), 14 approved specs (S-001 – S-007, S-009 – S-015); CR-016 as approved intent; CR-012 for supersession;
                     implementation fact: `install_skills_only` resolves its paths via `resolve_init_paths_for_env` (environment only, no config.toml)

Next owner:
- Planner (two small approved-spec wording corrections, R1 and R2; no Human decision, no ADR change)
```

### ADR-017 against the binding set

- **ADR-009:** no conflict. ADR-017 §1 makes explicit that the `data` bucket's default skill path is bob-owned. No amendment.
- **ADR-014:** no conflict. ADR-017 relies on §2 (one set), §3 (default plus override), §4 (fail-open after a failed skill step) and §7 (owner-only, still written by `bob init`). Alternative B stays rejected. No amendment.
- **ADR-002, ADR-008, ADR-012 §7, ADR-015, ADR-016:** no conflict. Per-job state stays in the working directory, and the override key is unchanged.
- **CR-012:** the partial supersession is stated the same way in ADR-017 (Neutral), S-012 (CLI, L128-135) and S-013 (Exclusions L49-57; Amendment Log).
- **S-010 L258** ("replaced on upgrade"): now accurate. No amendment.
- **S-002 L515-521, S-003 `BOB_SKILL_INSTALL_PATH`:** unaffected.
- **ADR-017 against the four amended specs:** every decision point has a matching spec statement.
  - §1 (bob owns the default path; the override is never touched): S-011 L164 and L326-332; S-013 L89-93 and L125-130.
  - §2 (byte comparison; an incomplete comparison counts as different; the three warning cases; skill content never compared): S-013 L98-100 and L240.
  - §3 (write order; whole-folder replacement on every install; removal safety): S-013 L243-244 and L397-400.
  - §4 (prompt on a binary or any entry; all-or-nothing on decline; a fresh install is not prompted): S-013 L140-148, L239 and L241.
  - §5 (`-y` is the only unattended route): S-013 L83-88 and L409-417.
  - §6 (warn, exit 0, rerun to recover): S-013 L245 and L401-405.
  - §7 (hand-run `bob init` keeps per-file semantics): S-012 L132-135.

### Disposition of the previous ADR-017 review's findings

| Finding (ADR-017 draft review) | Status | Where |
|---|---|---|
| S-013 "never passes `--force` … edits never overwritten" | Resolved | Config Requirements L384-407 replaces it |
| S-013 unattended-install exclusion | Resolved | Withdrawn in favour of `-y`, L83-88 |
| S-013 prompt keyed on the binary only (Principle, Responsibility row, Workflow) | Resolved | L140-148, L214, L299-309 |
| S-013 Component 3 / Workflow add-only "refresh" | Resolved | L233-246, L316-321 |
| S-013 `bob init` carve-out wording (G1) | Resolved | L49-57 |
| S-013 "writes only to that resolved default location" | Resolved | L118-124 |
| S-012 four embedded trees (row L71, Files created) | Resolved | L54-59, L76, L151-154, Verification L174-187 |
| S-011 Workflow end state, action rules | Resolved | L291-292, L346-349, L372-377 |

Earlier CR-review items are also present in the specs:
- K1 (symlinked `bob/skills`): S-013 L244.
- K3 (prompt on any entry): S-013 L239.
- H2 (missing, not stale): S-013 L245.
- K2 and Q2 (operator-guide upgrade text, release notes, non-zip upgrades): S-013 L258.
- N5 (links to internal docs, CLI stub): S-007 L45-50, L159-167, L313.
- P1 (copy never in a tracked tree; fail loudly): S-011 L201-209; S-012 L54-59, L76.
- Q3 (index points at build output): S-011 L184-189.

### Findings (correction required)

**R1. S-012 says `--skills-only` installs at "the resolved `skill_install_path`"; S-013 and ADR-017 say it resolves the default from the environment alone.**
- *Artifacts:*
  - S-012 CLI L118-121 ("installs or refreshes the shared skill package at the resolved `skill_install_path` only") and Workflow L92-93.
  - S-013 L120 and L246 ("the one `bob init --skills-only` resolves from the environment alone"; "A `skill_install_path` override in `config.toml` is not followed").
  - ADR-017 Negative ("`--skills-only` resolves only the default").
  - S-002 L515 (`skill_install_path` is the config key, overridable).
- *Conflict:* read literally, S-012 lets `--skills-only` honour a configured override. If it did, `install.sh` would empty the default path and `--skills-only` would refill the override, leaving the default empty with no error. That breaks ADR-017 §3's guarantee that the path emptied is the path refilled. The code already matches S-013 (`install_skills_only` → `resolve_init_paths_for_env`). Before CR-016 this was a harmless near-miss; ADR-017 makes it load-bearing.
- *Authoritative:* S-013 / ADR-017 (and the code).
- *Correction:* the S-012 CLI `--skills-only` bullet and the Workflow line state that it resolves the default skill install path from the environment alone, never reads `config.toml`, and so never follows a configured `skill_install_path` override. Add an Amendment Log note, or fold it into the CR-016 entry.
- Route: Planner (approved-spec amendment).

**R2. S-011 Responsibility Separation has no row for the `the-intern-docs` skill.**
- *Artifacts:* CR-016 "Possible Spec Amendments", S-011 entry ("Responsibility Separation (new skill row; install path row …)"); S-011 table L159-171. Every other skill has a row there, and each row records the skill's boundary (for example himalaya: "Carries no triage policy").
- *Conflict:* not a contradiction, but an amendment the approved CR requires is missing. The Amendment Log's "Responsibility Separation row" refers to the new User-manual row, not a skill row. Component 6 holds the content, but the table — the place a reader checks for what each skill owns — still lists four skills.
- *Correction:* add a `the-intern-docs` row. Responsibility: read-only reference answering questions about bob and the Intern from the installed version's manual, with CLI answers taken from `--help`. Notes: no operating policy, never acts on bob, pages copied from the manual at build time (Component 6).
- Route: Planner (approved-spec amendment).

### Rulings on the Planner's open points

1. **S-011 Exclusion L64-65 left unchanged — OK.**
   - The exclusion and the bob-service row (L165, "bob never reads skill content") govern the running service. bob supplies a path and never reads, validates or interprets skill files at runtime. Nothing in CR-016 changes that.
   - Copying the manual at build time is a build step over the manual *source*, not bob reading skills.
   - `bob init` writing embedded bytes is the materialisation S-012 already sanctioned for four skills.
   - The drift test is a test.
   - The emptying step belongs to `install.sh`, not bob.
   - No wording change needed.
2. **S-007 System Diagram left unchanged — OK.**
   - The diagram depicts the mdBook build pipeline and does not claim the sources have only one consumer.
   - The second consumer is stated normatively in the new Design Principle (L84-91), the docs-sources row (L128) and the release-asset contract note (L303-306).
   - The copy edge is drawn in S-011's System Diagram (L122-125), which is where the skill pipeline lives.
   - Adding an arrow is optional and cosmetic.
3. **S-011 Component 6 and S-013 Phase 6 — keep both.**
   - CR-016's amendment list is titled "Possible Spec Amendments", so it is not exhaustive.
   - Component 6 is the only approved-spec home for CR-016 item 1, which is tagged "(S-011)": the description trigger, the topic index, the `--help` instruction, and no operating policy. Without it, Gate 2 would have no spec text to check the skill's content against.
   - Phase 6 is how spec-breakdown orders the new `install.sh` work after the completed Phases 2 and 5. It adds no behaviour beyond Component 3–5.
   - Neither adds scope outside CR-016's approved intent.
   - Optional, not required: S-011 and S-012 Implementation Order tables have no CR-016 phase. Breakdown can take coverage from their components, but a phase line in each (docs skill and build-time copy; five-skill embedding and drift test) would make ordering across the three specs explicit.

### Corrections routed (seventh review)

- R1: Planner — S-012 CLI `--skills-only` bullet and Workflow wording (environment-only default, no config override).
- R2: Planner — S-011 Responsibility Separation `the-intern-docs` row.
- ADR-017, ADR-009, ADR-014: no change.
- Once R1 and R2 are in place, only those two edits need re-checking; a PASS is expected.

---

## Eighth review (2026-10-13, R1 / R2 edits and the new S-011 Phase 6 / S-012 Phase 5 only)

```text
Result: PASS

Artifact reviewed: S-011 v0.3 (Responsibility row L171, Phase 6 L424, Amendment Log L435); S-012 v0.4 (Workflow L92-96, CLI L119-125, Phase 5 L207, Amendment Log L217)
Binding set checked: the edits, against ADR-017, S-013 v0.4 and the code fact recorded in the seventh review (`install_skills_only` → `resolve_init_paths_for_env`)

Next owner:
- Planner (CR-016 settled; proceed to spec-breakdown)
```

| Finding | Status | Where |
|---|---|---|
| R1 `--skills-only` path resolution | Resolved | S-012 Workflow L93-94 and CLI L119-125: the default skill install path is resolved from the environment alone, `config.toml` is never read, and an override is never followed. It also states why: `install.sh` refills exactly the path it emptied (S-013, ADR-017). This now matches S-013 L120/L246, ADR-017 §3 and Negative, and the code. Recorded in the S-012 Amendment Log (L217). |
| R2 `the-intern-docs` Responsibility row | Resolved | S-011 L171: a read-only reference that takes CLI answers from `--help`, has no operating policy and never acts on bob, with pages copied at build time (Components 2 and 6). It agrees with Component 6 and CR-016 item 1. Recorded in the S-011 Amendment Log. |
| Optional phase lines | Added; consistent | S-011 Phase 6 (docs skill `SKILL.md` and index into the canonical source and packaging target, plus narrowed rule listings; depends on S-011 Phases 2 and 5). S-012 Phase 5 (build-time page copy under the never-tracked and fail-loudly constraints, drift test, four-to-five expectation updates; depends on S-012 Phase 1 and S-011 Phase 6). S-013 Phase 6 is unchanged. The cross-spec order is acyclic: S-011 Phase 6 → S-012 Phase 5, and S-013 Phase 6 is independent. Neither phase adds scope beyond CR-016. |

No new conflict. ADR-017 and the CR-016 amendments to S-007, S-011, S-012 and S-013 are consistent with every accepted ADR and approved specification.

### Corrections routed (eighth review)

- None. CR-016 can be marked applied and broken down. Spec-breakdown should order the operator guide, `install.sh` and `test-install.sh` edits explicitly, because several tasks touch each of them (see the first review's in-flight section).
