---
id: T-002
title: Write Rust and NodeJS coding guidelines
status: pending
priority: medium
assigned-role: unassigned
created: '2026-05-15'
---

# Write Rust and NodeJS coding guidelines

## Description

The Intern is built as a Rust service plus a Node.js extension (see
`project/specs/the-intern-agent-service-architecture.md`). Before any code
lands we need a short, opinionated style document per language so that future
tasks share one baseline.

Each document is convention-only prose — no checked-in tool configs, no CI
wiring, no pre-commit hooks. Each document must cover:

1. Source layout and module naming.
2. Identifier naming conventions.
3. Error handling style (Rust: `Result` + chosen error-crate boundary;
   Node: thrown `Error` subclasses vs. result objects — pick one).
4. Logging conventions (level usage, structured fields, what never to log).
5. Testing conventions — file layout, naming, what a "good test" looks like,
   *without* picking a specific framework.
6. Formatter and linter to use, named only (e.g. `rustfmt` + `clippy`,
   `prettier` + a linter), with one-line rationale each. No config files.

Out of scope (explicit): no architecture / module boundary / layering
guidance (lives in specs), no test framework selection, no CI integration of
formatters or linters, no dependency licensing / security advisory / pinning
policy.

## Acceptance Criteria

AC-1: The system shall provide `project/docs/coding-guidelines-rust.md` and `project/docs/coding-guidelines-node.md`.
AC-2: Each guideline document shall contain sections covering: source layout, naming, error handling, logging, testing conventions, and the chosen formatter + linter.
AC-3: The system shall NOT include any tool configuration file (`rustfmt.toml`, `clippy.toml`, `.eslintrc*`, `biome.json`, `.prettierrc*`, `.editorconfig`) as part of this task.
AC-4: The system shall NOT include guidance on architecture, module boundaries, dependency licensing, security advisories, or CI wiring of linters.
AC-5: Each document shall describe testing conventions in framework-agnostic terms (no `cargo nextest`, `jest`, `vitest`, `mocha`, etc. selected as official tool).

## Dependencies

- None

## Files to Touch

- `project/docs/coding-guidelines-rust.md` — new file, ~one page
- `project/docs/coding-guidelines-node.md` — new file, ~one page

## Verification

```bash
test -f project/docs/coding-guidelines-rust.md
test -f project/docs/coding-guidelines-node.md

for f in project/docs/coding-guidelines-rust.md project/docs/coding-guidelines-node.md; do
  for h in "source layout" "naming" "error handling" "logging" "testing" "formatter"; do
    grep -qi "$h" "$f" || { echo "missing: $h in $f"; exit 1; }
  done
done

! ls rustfmt.toml clippy.toml .eslintrc* biome.json .prettierrc* .editorconfig 2>/dev/null | grep -q .
```

## Work Log

## Review
