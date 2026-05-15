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

### Session 1 — 2026-05-15

Started with an empty Work Log (first session). Read the task file, the architecture spec (S-001), and the system overview to understand the technology context (Rust service + Node.js JS extension inside pi-agent).

Adapted TDD to documentation: wrote `tests/test_coding_guidelines.sh` first, covering AC-1 (file existence), AC-2 (six required section headings via grep), AC-3 (no tool config files), and AC-5 (no specific test framework names). The script started red — four failures because neither document existed yet.

Wrote `coding-guidelines-rust.md` covering source layout (`snake_case` modules, Cargo workspace structure), naming (`UpperCamelCase`/`snake_case`/`SCREAMING_SNAKE_CASE`), error handling (`Result`+`thiserror` at boundaries, `anyhow` at application layer, no silent swallowing), logging (`tracing` with structured fields, level guidance, what never to log), testing (co-located `#[cfg(test)]` modules, naming convention, no shared state, no network/filesystem unless that is the subject), and formatter/linter (`rustfmt` + `clippy`, one-line rationale each). Framework names (cargo nextest etc.) were deliberately omitted.

Wrote `coding-guidelines-node.md` on the same six sections for the JS extension: `kebab-case` files, `camelCase`/`PascalCase` identifiers, typed `Error` subclasses with `cause` propagation, structured JSON logging, the same good-test checklist, and `prettier` + `eslint` with rationale.

All seven tests turned green. The canonical verification block from the task file also passed without modification. Committed everything in one cycle (`af23e9b`). Nothing was tried and rejected; both documents came out within the one-page scope on the first pass.

Nothing remains for this task.

### Session 2 — 2026-05-15

The Reviewer issued FAIL on Session 1's submission for a single AC-4 violation: line 103 of `project/docs/coding-guidelines-rust.md` contained the phrase "Treat `clippy` warnings as errors in CI;" — the two words "in CI" explicitly prescribe CI behaviour, which is out of scope per both the task description ("no CI integration of formatters or linters") and AC-4.

The fix was a one-phrase removal: "in CI" was dropped from that sentence, making it read "Treat `clippy` warnings as errors;" with the rest of the sentence unchanged ("suppress a lint only with an inline `#[allow(...)]` and a comment explaining why"). No other content was altered.

A full grep for "in ci", "continuous integration", "pipeline", "github actions", "pre-commit", and "pre commit" across both guideline documents returned no matches. The phrases "Run it before every commit" that appear in both documents (describing when to run `rustfmt` and `prettier`) were reviewed and retained: they are developer workflow instructions, not CI wiring, and were not flagged by the Reviewer.

All seven tests in `tests/test_coding_guidelines.sh` passed (0 failures). The canonical verification block from the task file also passed fully. Commit `176b056`.

## Review

### Review Verdict — 2026-05-15

FAIL

**Stage 1 — AC-4 violation**

- **File:** `project/docs/coding-guidelines-rust.md`, line 103
- **What is wrong:** The sentence "Treat `clippy` warnings as errors in CI;" is explicit CI wiring of the linter. The task description states under "Out of scope (explicit)": "no CI integration of formatters or linters." AC-4 states: "The system shall NOT include guidance on … CI wiring of linters." This sentence directly prescribes how CI must be configured, which violates the acceptance criterion.
- **What should change:** Remove the CI-specific clause from the `clippy` rationale. The sentence can end after the statement of what `clippy` catches and enforces, without prescribing CI behaviour. For example: "Treat `clippy` warnings as errors; suppress a lint only with an inline `#[allow(...)]` and a comment explaining why." This preserves the intent (clippy warnings must not be ignored) without naming CI as the enforcement mechanism.

**Stage 1 — All other AC checks**

- AC-1: PASS — both `coding-guidelines-rust.md` and `coding-guidelines-node.md` exist.
- AC-2: PASS — both documents cover all six required sections (source layout, naming, error handling, logging, testing, formatter).
- AC-3: PASS — no tool config files (`rustfmt.toml`, `clippy.toml`, `.eslintrc*`, `biome.json`, `.prettierrc*`, `.editorconfig`) were added.
- AC-4: FAIL (see above). No other AC-4 violations were found (no architecture layering guidance, no module-boundary rules, no dependency licensing or security advisory content).
- AC-5: PASS — testing sections in both documents are framework-agnostic; no `cargo nextest`, `jest`, `vitest`, `mocha`, or similar names appear.

**Stage 2 — Skipped** (per procedure: Stage 2 is skipped when Stage 1 fails)

**Out-of-scope file note (non-blocking):** `tests/test_coding_guidelines.sh` is not listed in "Files to Touch" but is justified in the Work Log as TDD scaffolding. This is acceptable; the justification is present.
