---
id: B-044
title: CLI reference preprocessor's hardcoded subcommand list omits bob task
severity: medium
status: open
created: '2026-08-24'
---

# CLI reference preprocessor's hardcoded subcommand list omits bob task

## Summary

The mdBook CLI-reference preprocessor (`the-intern/docs/preprocessors/cli-reference/src/main.rs`)
captures `--help` output for the root `bob` command and for each name in a
hardcoded `SUBCOMMANDS` constant, then injects one generated chapter per name.
`SUBCOMMANDS` was last updated when `init` was added and has never been
updated since; it does not include `task`. As a result, `bob task --help` (and
every `bob task` sub-subcommand's help) is silently absent from the shipped
mdBook manual's CLI Reference chapter, even though `mdbook build` succeeds
with no warning or error.

## Reproduction Status

Status: confirmed

Reproduced by building the docs locally against the current debug binary and
inspecting the generated HTML output.

## Evidence

- `grep -n "task\|SUBCOMMANDS" the-intern/docs/preprocessors/cli-reference/src/main.rs`
  shows a `const SUBCOMMANDS: &[&str]` list containing `init`, `serve`,
  `status`, `sessions`, `audit`, `policy`, `schedule`, `chat` — no `task`.
- `git log --oneline -- the-intern/docs/preprocessors/cli-reference/src/main.rs`
  shows the file was last touched by `54419cd docs(bob): document init
  bootstrap workflow`, before the `bob task` subcommand existed.
- `the-intern/service/target/debug/bob --help` lists `task` as a top-level
  command alongside `init`, `serve`, `status`, `sessions`, `audit`, `policy`,
  `schedule`, `chat`.
- After `(cd the-intern/docs && mdbook build)`, `ls the-intern/docs/book/cli-reference/`
  shows `audit.html bob.html chat.html index.html init.html policy.html
  schedule.html serve.html sessions.html status.html` — no `task.html`.
- Failing command: none exits non-zero; the build succeeds silently while
  omitting the chapter, which is the defect.

## Reproduction Steps

1. `cargo build -p bob` from `the-intern/service/`.
2. `cd the-intern/docs && mdbook build`.
3. `ls the-intern/docs/book/cli-reference/` and note there is no `task.html`,
   even though `bob task` is a real top-level subcommand.

## Expected Behavior

Every top-level `bob` subcommand the binary actually exposes — including
`task`, added after the preprocessor's `SUBCOMMANDS` list was last updated —
should get a generated CLI-reference chapter from its own `--help` output,
the same as `init`, `serve`, `status`, `sessions`, `audit`, `policy`,
`schedule`, and `chat` do.

## Actual Behavior

`bob task --help` is never captured. No `cli-reference/task.md` chapter is
injected into the book, and no `task.html` is produced. The build reports no
error or warning, so the gap is invisible unless someone inspects the
generated output directly. `bob task`'s sub-subcommands (`new`, `list`,
`show`, `status`, `note`) are consequently undocumented in the shipped manual
as well, since the preprocessor only recurses into subcommands already named
in `SUBCOMMANDS`.

## Environment

- OS / platform: Linux (dev container), also applies to release builds on
  `linux-x86_64` / `macos-arm64`.
- Language / runtime version: Rust stable per `the-intern/service/rust-toolchain.toml`;
  `mdbook v0.4.52`.
- Relevant dependencies: `the-intern/docs/preprocessors/cli-reference` (a
  separate Cargo package driving the `[preprocessor.cli-reference]` mdBook
  hook in `the-intern/docs/book.toml`).
- Branch / commit: found on `task/T-189-update-the-shipped-manual-for-bob-task-and-the-new-workspace-layout`,
  based on `dev-agent` at the point T-189 was picked up.

## Related

- Task: `T-189` (discovered while updating the shipped manual for `bob task`;
  T-189's own scope is limited to the two manual pages listed in its `Files
  to Touch` and does not include this preprocessor, so the gap is reported
  here instead of fixed in place).

## Suspected Area

`the-intern/docs/preprocessors/cli-reference/src/main.rs` — the `SUBCOMMANDS`
constant (currently `["init", "serve", "status", "sessions", "audit",
"policy", "schedule", "chat"]`) needs `"task"` added, or the list needs to be
derived from the binary's own top-level subcommand names instead of
hardcoded, so future subcommands don't require a matching preprocessor edit.

## Fix Verification

```bash
cargo build -p bob
cd the-intern/docs && mdbook build
test -f book/cli-reference/task.html
grep -q "bob task" book/cli-reference/task.html
```

## Diagnosis Log

<!-- Mandatory before implementation. Append one entry before changing production code. Format:
### Diagnosis N — YYYY-MM-DD
Reproduction status:
Evidence captured:
Isolated fault:
Root cause or fault hypothesis:
Planned verification:
-->

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
