---
id: T-082
title: Implement CLI reference generator wired into the docs build
status: pending
priority: medium
assigned-role: developer
created: '2026-05-25'
spec: S-007
---

# Implement CLI reference generator wired into the docs build

## Description

Implement the CLI-reference generation step described in S-007 so the CLI
Reference part of the book is produced from the live `bob` binary at build
time rather than maintained by hand.

The generator must:
- For `bob` itself and for each first-level subcommand (`serve`, `status`,
  `sessions`, `audit`, `policy`, `chat`) capture the `--help` output and
  produce a corresponding markdown page under the CLI Reference part of
  the book.
- Be invoked automatically as part of the single-command docs build from
  `the-intern/docs/` (i.e. `mdbook build`). The reader does not run a
  separate step.
- Locate the `bob` binary via a documented rule: read the path from the
  `BOB_BIN` environment variable when set; otherwise fall back to
  `the-intern/service/target/release/bob` then
  `the-intern/service/target/debug/bob` (paths relative to the workspace
  root).
- Fail the build with a clear, actionable error message naming `BOB_BIN`
  and the fallback paths when no usable `bob` binary is found. The build
  must not silently skip the reference or emit empty pages.

Implementation form (an mdBook preprocessor binary, an mdBook
preprocessor written in Rust, or a pre-build script invoked from
`book.toml`) is a developer decision. The contract above is the
constraint; pick the simplest form that meets it and that stays Rust-only.

This task may modify `book.toml` (which T-077 creates) to register the
generator. It must not modify hand-written content owned by T-078..T-081.

## Acceptance Criteria

AC-1: WHEN `mdbook build` runs from `the-intern/docs/` with a valid `bob`
binary discoverable via `BOB_BIN` or the documented fallback paths, THE
SYSTEM SHALL produce CLI reference pages for `bob` and each of its
first-level subcommands populated with the captured `--help` text.

AC-2: IF no usable `bob` binary is found at `BOB_BIN` or the documented
fallback paths, THEN THE SYSTEM SHALL fail the docs build with an error
message that names `BOB_BIN`, lists the fallback paths, and tells the
reader to build the binary or set the variable.

AC-3: The system shall not require any runtime other than the Rust
toolchain to build the CLI reference; no Node, Python, or other
interpreter may be introduced.

AC-4: The system shall integrate the generator into the same single
command that produces the rest of the book; no additional explicit step
shall be required of the reader.

## Dependencies

- `T-077` — provides the mdBook scaffold (`book.toml`, `SUMMARY.md`
  entries for the CLI Reference part) the generator plugs into.

## Files to Touch

- `the-intern/docs/book.toml` — register the generator/preprocessor.
- `the-intern/docs/` (new file(s)) — generator implementation; location
  decided by the developer (typically a small Rust crate or script under
  `the-intern/docs/preprocessors/` or similar).

## Verification

```bash
# Positive path: with bob built
cd the-intern/service && cargo build -p bob --release
cd ../docs && BOB_BIN="$PWD/../service/target/release/bob" mdbook build
grep -rq "bob serve" book/

# Negative path: no binary available, build must fail loudly
BOB_BIN=/no/such/path mdbook build 2>&1 | grep -i "BOB_BIN"
```

## Work Log

### Session 1 — 2026-05-28

Implemented T-082 in full. Created a Rust binary crate at
`the-intern/docs/preprocessors/cli-reference/` that acts as an mdBook
preprocessor. The binary is a standalone Cargo workspace (its own
`Cargo.toml` and `Cargo.lock`) so it does not pollute the service
workspace. It depends only on `mdbook` (for the
`CmdPreprocessor::parse_input` and book types) and `serde_json` (for
writing the processed book to stdout).

The preprocessor follows the mdbook protocol: when called with
`supports <renderer>` it exits 0 (supports all renderers); when called
normally it reads a `(PreprocessorContext, Book)` JSON pair from stdin,
discovers the `bob` binary, captures `--help` output for `bob` and each
of the six first-level subcommands, injects generated chapters under
the CLI Reference section, and writes the modified book JSON to stdout.

Binary discovery was the central design decision. `find_bob_binary`
reads `BOB_BIN` from the environment and, if absent or empty, falls
back to `../service/target/release/bob` then
`../service/target/debug/bob` (both resolved relative to the book root,
which is the directory mdbook is invoked from). If none are found, the
build fails with a clear message that names `BOB_BIN` and both fallback
paths. To avoid test-isolation races from parallel tests all mutating
the same env variable, the discovery logic was split into
`find_bob_binary` (public, reads the env) and
`find_bob_binary_with_env` (inner, accepts the value as a parameter).
All tests call the inner function.

`book.toml` registers the preprocessor with
`command = "cargo run --manifest-path preprocessors/cli-reference/Cargo.toml -q --"`.
The trailing `--` is load-bearing: it is the cargo argument-separator,
so when mdbook appends `supports html` the args become
`["run", ..., "--", "supports", "html"]` and the binary receives
`["supports", "html"]` rather than cargo trying to interpret them as
package names.

All four acceptance criteria are satisfied. Eight unit tests were
written and pass. Clippy is clean. The positive-path and negative-path
verification commands from the task file both succeed. Service tests
are unaffected.

## Review

### Review Verdict — 2026-05-28

PASS

Both stages passed.

**Stage 1 — Spec compliance**

- AC-1 (positive path): Verified. `mdbook build` with `BOB_BIN` pointing to the release
  binary produced `book/cli-reference/{bob,serve,status,sessions,audit,policy,chat}.html`.
  `grep -rq "bob serve" book/` confirmed help text is present. All seven pages (root + six
  subcommands) are present.
- AC-2 (negative path): Verified. `BOB_BIN=/no/such/path mdbook build` exited non-zero
  (exit code 101), printed the `BOB_BIN` value that was tried, listed both fallback paths,
  and instructed the reader how to fix the problem.
- AC-3 (Rust only): Verified. `Cargo.toml` lists only `mdbook` and `serde_json` as
  production dependencies; `tempfile` is dev-only. No Node, Python, or other interpreter
  is involved.
- AC-4 (single command): Verified. The preprocessor is registered in `book.toml` via
  `[preprocessor.cli-reference]`; `mdbook build` invokes it automatically with no extra
  reader step.
- Scope: Only `the-intern/docs/book.toml` and `the-intern/docs/preprocessors/cli-reference/`
  were modified. Hand-written content from T-078..T-081 is untouched.

**Stage 2 — Code quality**

- Correctness: Binary discovery logic is correct for all three paths (BOB_BIN set/good,
  BOB_BIN set/bad, BOB_BIN absent with release/debug fallback). All eight unit tests cover
  the happy and failure paths for discovery, help capture, formatting, and index generation.
- Tests: 8 tests, all pass. Tests use `find_bob_binary_with_env` to avoid env-var races.
  Fake `bob` shell script makes tests hermetic with temp directories.
- Security: No hardcoded secrets. No external input is used beyond the binary path and its
  stdout output, which goes straight to the book as pre-formatted text.
- Readability: Functions are focused and well-named. Comments explain design decisions
  (the `--` separator, the env-var isolation split). No dead code.
- Performance: No unnecessary loops; book sections are walked once.

**Non-blocking observations (no action required)**

1. `capture_help` docstring says it returns an error on non-zero exit status, but the
   implementation does not actually check `output.status`. For clap-based CLIs `--help`
   always exits 0, so this has no practical impact. The docstring could be corrected in a
   future cleanup pass.
2. In `inject_cli_reference`, after `std::mem::take(&mut chapters)` the local `chapters`
   is always empty, making `if chapters.is_empty()` tautologically true in the recursive
   path. The logic is safe for the actual book structure (CLI Reference is top-level), but
   the condition could be replaced with an unconditional `found_index = true; break;` for
   clarity.
