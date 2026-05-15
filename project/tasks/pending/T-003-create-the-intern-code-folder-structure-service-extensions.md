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

## Review
