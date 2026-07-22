# PR Review: aurora-firmware/the-intern#39 — Add bob-companion Claude Code plugin (setup, CLI, health checks, troubleshooting)

## Summary

This PR renames the pi extension package, updates its runtime and release paths, and adds a Claude Code companion plugin with setup, CLI, health-check, and troubleshooting skills. After reviewing the developer response and the two follow-up workspace changes, there are no remaining findings for this review.

| Scope | Files | Lines changed | Tier | Findings |
|---|---:|---:|---|---:|
| ci | 1 | 2 | trivial | 0 |
| documentation | 13 | 547 | full | 0 |
| source | 12 | 37 | lite | 0 |
| security | 0 | 0 | — | 0 |

## Findings

No remaining findings.

## Resolved during re-review

- The manual service-start block now starts with `cd the-intern/service`, so its `cargo run -p bob -- serve` command runs in the Rust workspace.
- The AC-5 directory allowlist now permits `docs`. This assertion also failed on `main`, where `the-intern/docs` already existed, so the original review incorrectly treated it as a PR-created regression.

## Skipped files

- `the-intern/pi-extension/package-lock.json` — lock file.

## Review notes

Reviewed PR head `416035efd8dfd8dd99b47f9ce5004f92cb190f14` against `main`, then re-reviewed the developer's two uncommitted follow-up edits. CI was a trivial diff and its updated archive path exists. Documentation received a full contextual review; source received a focused diff review. GitHub has no inline review comments; the developer's issue comments explain the requested relocation and its subsequent implementation. `git diff --check` passed. `bash tests/test_the_intern_structure.sh` now passes AC-5; its AC-2 and AC-4 failures reproduce from stale pre-existing assertions and are outside this PR. `npm test --prefix the-intern/pi-extension` could not run because `vitest` is not installed in the current checkout.

## Developer response

Verified both warnings against the checkout — both are real, not reviewer
misreadings — and fixed rather than clarified in comments:

- **Doc warning** (`bob-setup/SKILL.md:127`): confirmed the manual
  `cargo run -p bob -- serve` block had no `cd`, while §3 of the same file
  establishes "always run cargo commands from `the-intern/service/`". Added
  `cd the-intern/service` as the first line of that block.
- **Source warning** (`tests/test_the_intern_structure.sh:83`): confirmed
  `the-intern/docs` exists and is unrelated to this PR (introduced in
  `e518211`, well before this change). Added `! -name docs` to the AC-5
  allowlist. `bash tests/test_the_intern_structure.sh` now reports
  `PASS: AC-5: no extra package/crate directories`.

AC-2 and AC-4 still fail after this fix, matching the review notes — those
assert on README content that predates this PR and are out of scope here.

— developer
