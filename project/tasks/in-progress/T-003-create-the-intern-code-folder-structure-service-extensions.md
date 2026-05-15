---
id: T-003
title: Create the-intern code folder structure (service + extensions)
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-15'
---

# Create the-intern code folder structure (service + extensions)

## Description

Carve out the top-level location where application code will live, separate
from the `project/` lifecycle tree and the `.claude/` framework definitions.

Layout to create:

```
the-intern/
├── README.md                # Explains the split below
├── service/                 # The Rust service (single crate for now)
│   └── README.md
└── extensions/              # JS extensions loaded inside pi-agent
    └── README.md
```

Notes:
- `pi-agent` itself is installed inside the dev container — it is NOT vendored
  into this repository. The `extensions/` folder only holds the JS extension(s)
  we author against pi-agent.
- The Rust side stays as one crate for now; further crate splits are deferred.

Out of scope (explicit): no source files or stub implementations
(`main.rs`, `lib.rs`, `index.ts`, etc.), no `Cargo.toml` / `package.json`
manifests, no dependency selection, no build-tooling choices (bundlers, TS
configs, build scripts), and no further internal Rust crate split.

Each README is a 3–6 line stub: what the folder is for, that code lands here
later, and a pointer back to `project/specs/the-intern-agent-service-architecture.md`.

## Acceptance Criteria

AC-1: The system shall provide directories `the-intern/`, `the-intern/service/`, and `the-intern/extensions/` at the repository root.
AC-2: Each of the three directories shall contain a `README.md` describing the folder's role in 3–6 lines and referencing `project/specs/the-intern-agent-service-architecture.md`.
AC-3: The system shall NOT add any source file, build manifest (`Cargo.toml`, `package.json`, `tsconfig.json`, etc.), or dependency declaration under `the-intern/`.
AC-4: The `the-intern/extensions/README.md` shall state that pi-agent is installed in the dev container and is not vendored in this repository.
AC-5: The system shall NOT introduce any additional Rust crate or Node package directory beyond `service/` and `extensions/`.

## Dependencies

- None

## Files to Touch

- `the-intern/README.md` — new
- `the-intern/service/README.md` — new
- `the-intern/extensions/README.md` — new

## Verification

```bash
test -d the-intern/service
test -d the-intern/extensions
test -f the-intern/README.md
test -f the-intern/service/README.md
test -f the-intern/extensions/README.md

# Forbidden files must not exist under the new tree
! find the-intern -type f \( -name '*.rs' -o -name '*.ts' -o -name '*.js' \
    -o -name 'Cargo.toml' -o -name 'package.json' -o -name 'tsconfig.json' \) \
    2>/dev/null | grep -q .

# extensions README mentions the dev-container fact
grep -qi "dev container" the-intern/extensions/README.md
grep -qi "not vendored\|not included\|installed in" the-intern/extensions/README.md
```

## Work Log

### Session 1 — 2026-05-15

Implemented T-003 with a strict red→green flow. I first added a new shell test suite (`tests/test_the_intern_structure.sh`) that encodes AC-1 through AC-5, including README line-count bounds, required spec reference, forbidden file patterns, and the extensions README dev-container/not-vendored statement. Initial execution failed as expected because `the-intern/` did not exist. I adjusted one test path in AC-5 to avoid premature exit when the root directory is missing, then reran to confirm clean failing output. I then created exactly `the-intern/`, `the-intern/service/`, and `the-intern/extensions/` with 3–6 line README stubs and no manifests or source files. After implementation, the new test suite passed, task verification commands passed, and existing repository tests still passed. I considered adding placeholder manifests or code stubs but rejected that because it violates explicit out-of-scope constraints. No remaining implementation work is left for this task on the branch.

Evidence:
- Red test run (before implementation): `tests/test_the_intern_structure.sh` → 4 failures, 1 pass.
- Green test run (after implementation): `tests/test_the_intern_structure.sh` → 5 passed, 0 failed.
- Task verification commands from the task file all passed (including forbidden-file and README grep checks).
- Regression checks passed:
  - `tests/test_workflows.sh` → 13 passed, 0 failed.
  - `tests/test_coding_guidelines.sh` → 7 passed, 0 failed.

Obstacles Encountered:
- `project/docs/coding_guidelines.md` referenced by role instructions does not exist in this repo; used existing project guideline docs and task-specific constraints instead.
- First draft of AC-5 test exited early when `the-intern/` was absent; patched test to report a normal failure state during red phase.

## Review

### Review Verdict — 2026-05-15
PASS

Stage 1 (acceptance criteria) passed.
- AC-1 met: `the-intern/`, `the-intern/service/`, and `the-intern/extensions/` exist.
- AC-2 met: all three `README.md` files exist, are 3-6 lines, and reference `project/specs/the-intern-agent-service-architecture.md`.
- AC-3 met: no `*.rs`, `*.ts`, `*.js`, `Cargo.toml`, `package.json`, or `tsconfig.json` files exist under `the-intern/`.
- AC-4 met: `the-intern/extensions/README.md` states pi-agent is installed in the dev container and not vendored in-repo.
- AC-5 met: no additional top-level code/package directories exist under `the-intern/` beyond `service/` and `extensions/`.

Stage 2 (quality) passed.
- Correctness/readability: folder layout and README content match scope; no out-of-scope code/manifests were introduced under `the-intern/`.
- Tests/evidence verified by reviewer:
  - `tests/test_the_intern_structure.sh` -> 5 passed, 0 failed.
  - `tests/test_workflows.sh` -> 13 passed, 0 failed.
  - `tests/test_coding_guidelines.sh` -> 7 passed, 0 failed.

Next owner: Development Loop.
