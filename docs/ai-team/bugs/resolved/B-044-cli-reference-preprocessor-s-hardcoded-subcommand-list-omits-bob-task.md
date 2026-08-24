---
id: B-044
title: CLI reference preprocessor's hardcoded subcommand list omits bob task
severity: medium
status: resolved
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

### Diagnosis 1 — 2026-08-24
Reproduction status: confirmed, per the Reproduction Steps above.
Evidence captured: the `SUBCOMMANDS` constant in the preprocessor, unchanged
since commit `54419cd` (before `task` existed); the missing `task.html` in
the built book despite a clean `mdbook build` exit.
Isolated fault: `SUBCOMMANDS` is a hardcoded list that nothing keeps in sync
with the binary's actual top-level subcommand set, so any subcommand added
after the list was last touched is silently omitted from the generated
manual with no build failure to catch it.
Root cause: the preprocessor derives its documented pages from a static list
instead of from the binary it already runs to capture `--help` text.
Planned verification: the Fix Verification block below.

## Work Log

### Session 1 — 2026-08-24

This bug was discovered and diagnosed while implementing `T-189`, then fixed
as part of that same task's review-remediation cycle rather than through a
separate bug-fix pass: `T-189`'s reviewer FAILed the task on the equivalent
gap in its own AC-3, the loop expanded `T-189`'s `Files to Touch` to cover
this file, and the fix landed there as commit `380f00a` on
`task/T-189-update-the-shipped-manual-for-bob-task-and-the-new-workspace-layout`
(merged to `dev-agent`).

The fix removes `SUBCOMMANDS` entirely rather than adding `"task"` to it —
the second option this bug's own Suspected Area named — deriving the
documented subcommand list from `bob --help`'s own `Commands:` section via a
new `parse_subcommand_names` function, so no future subcommand can silently
repeat this defect. The `help` entry clap auto-generates is explicitly
excluded, matching the old list's behavior. Independently re-verified twice
by `T-189`'s reviewer (cycle 3, from a clean `rm -rf book` rebuild) and once
more here, directly: this bug's own Fix Verification block, run verbatim
against `dev-agent` after the merge, passes — `task.html` exists and
contains real `bob task --help` content.

Closing as resolved. No further action needed; this bug's fix is already on
`dev-agent`.

## Review

### Review Verdict — 2026-08-24
PASS

Resolved as a byproduct of `T-189`'s review cycle 2/3, not a standalone
Developer/Reviewer pass — `T-189`'s own Reviewer independently verified this
exact defect twice (diagnosing it in cycle 1, confirming the fix in cycle 3
from a clean rebuild), and this bug's literal Fix Verification block was
re-run here against `dev-agent` post-merge with the same result: PASS. No
separate code-quality review is recorded here since none of this bug's code
was touched outside what `T-189`'s Reviewer already assessed in full.
