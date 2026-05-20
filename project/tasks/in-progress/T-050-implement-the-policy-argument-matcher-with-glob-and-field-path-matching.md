---
id: T-050
title: Implement the policy argument matcher with glob and field-path matching
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-20'
spec: S-004
---

# Implement the policy argument matcher with glob and field-path matching

<!--
Task Quality Rules (see the new-task skill for full details):
  - Atomic — one clear outcome.
  - One-shottable — ≤ 3–4 files touched, ≤ 5 ACs, Description ≈ 20 lines.
  - Verifiable — concrete Verification command or explicit manual steps.
  - Self-contained — Description is enough to start without follow-up questions.
  - EARS — every AC matches one of the five EARS patterns below.
  - Dependency-honest — list every prior task this one reads from or modifies.
-->

## Description

Phase 1 of S-004. Implement the matching behaviour for `ArgMatcher` (the
data type from T-049). An argument matcher decides whether one field of a
tool call's `arguments` JSON satisfies a glob.

In a new `matcher.rs` module, implement
`ArgMatcher::matches(&self, arguments: &serde_json::Value) -> bool` with
these **contract** semantics (this resolves the S-004 open question on
matcher syntax):

- **Field path**: a dot-separated sequence of object keys (e.g. `command`,
  `opts.force`). It resolves only through JSON objects. Array indexing is
  out of scope for v1.
- **Glob**: `*` matches any run of characters including empty, `?` matches
  exactly one character, all other characters are literal. Use the
  `wildmatch` crate.
- The matcher **passes** only when the value at the field path is present,
  is a JSON string, and that string matches the glob.
- A missing path, a non-object encountered mid-path, or a non-string value
  at the path makes the matcher **fail** (`false`).

This is pure logic — no I/O, no async. Declare `mod matcher;` in `lib.rs`.
Cover the contract with unit tests, including each failure case above.

## Acceptance Criteria

AC-1: WHEN `ArgMatcher::matches` is called and the value at the matcher's dot-separated field path is a JSON string matching the glob THE SYSTEM SHALL return `true`.
AC-2: WHEN the glob contains `*` or `?` THE SYSTEM SHALL treat `*` as any run of characters and `?` as exactly one character, with all other characters literal.
AC-3: IF the field path is absent, traverses a non-object, or resolves to a non-string value THEN THE SYSTEM SHALL return `false`.
AC-4: The system shall implement `ArgMatcher::matches` as a pure function with no I/O and no async.

## Dependencies

- `T-049` — defines `ArgMatcher`; shares `policy-control/src/lib.rs` and `Cargo.toml`.

## Files to Touch

- `the-intern/service/crates/policy-control/src/matcher.rs` — new module: `ArgMatcher::matches` and its unit tests.
- `the-intern/service/crates/policy-control/src/lib.rs` — declare `mod matcher;`.
- `the-intern/service/crates/policy-control/Cargo.toml` — add `wildmatch`.

## Verification

```bash
cd the-intern/service
cargo test -p policy-control
cargo clippy -p policy-control --all-targets
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

### Session 1 — 2026-05-20

Implemented `ArgMatcher::matches` for the `policy-control` crate as specified by T-050. The implementation was completed in a single TDD cycle covering all four acceptance criteria.

**What was done.** Added `wildmatch = "2"` and `serde_json` (from workspace) to `policy-control/Cargo.toml`, declared `mod matcher;` in `lib.rs`, and created `src/matcher.rs`. The new module implements `ArgMatcher::matches(&self, arguments: &Value) -> bool` as a pure, sync function. It delegates field-path traversal to a private `resolve_field_path` helper that splits the path on `.` and walks through `Value::Object` maps, returning `None` on any absent key, non-object intermediate node, or non-string terminal value. When the helper returns `Some(&str)`, the string is matched against `self.pattern` using `WildMatch::new(&self.pattern).matches(s)` from the `wildmatch` crate, which treats `*` as any run of characters (including empty) and `?` as exactly one character. Ten matcher tests cover AC-1 through AC-3 in detail — literal match, `*`/`?` semantics, nested dot paths, absent paths, non-object intermediate nodes (string, array), and non-string terminal values (number, boolean, null, object). AC-4 (pure, no I/O, no async) is enforced structurally: the function signature is `&self, &Value -> bool` with no async or I/O imports.

**What was tried and rejected.** No alternative approaches were considered; the `wildmatch` crate was specified in the task and behaves exactly as the contract requires.

**What remains.** Nothing for this task. All four ACs are covered with passing tests and clean clippy output.

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that both stages passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
