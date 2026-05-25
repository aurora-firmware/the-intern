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

## Review
