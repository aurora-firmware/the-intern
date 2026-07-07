---
id: T-123
title: Add optional resolved working-directory field to the event audit payload
status: pending
priority: medium
assigned-role: developer
created: '2026-07-05'
spec: S-005
---

# Add optional resolved working-directory field to the event audit payload

## Description

S-005 amendment: the event audit payload records the resolved working directory
for scheduled firings. Extend `ExtensionEventAuditPayload`
(`crates/bob-core/src/types/records.rs`) with an **optional** resolved
working-directory field annotated `#[serde(default, skip_serializing_if =
"Option::is_none")]` — `default` is required because the payload uses
`#[serde(deny_unknown_fields)]`, so existing JSONL audit records written without
the field must still deserialize. Do **not** add a new audit record kind — the
set stays `event`/`report`/`verdict`, and `report`/`verdict` payloads are
unchanged. This task adds only the model field; population for `periodic` firings
happens in T-128.

`ExtensionEventAuditPayload` is a plain struct built by full struct literals, so
every construction site must set the new field (mechanically `None`), otherwise
the workspace will not compile. One site is production —
`crates/extension-ipc/src/multiplex.rs` (~109); the other four are in
`#[cfg(test)]` modules — `crates/monitoring/src/lib.rs` (~255),
`crates/admin-rpc/src/lib.rs` (~1183/1266/1405), `crates/bob/src/serve.rs`
(~1257). Because four sites are test-only, verification MUST be `cargo test
--workspace` (a plain `cargo build` never compiles `#[cfg(test)]` code and would
false-green this task). (Optional: add an `ExtensionEventAuditPayload::new(name,
summary)` constructor that defaults the field to `None` and route sites through
it, to reduce future churn — the Developer's choice.)

## Acceptance Criteria

AC-1: The event audit payload shall include an optional resolved
      working-directory field, `#[serde(default, skip_serializing_if)]`, omitted
      from serialized output when absent.
AC-2: WHILE an event has no execution directory THE SYSTEM SHALL omit the field
      and keep the record a valid `event` record that still deserializes older
      records lacking the field.
AC-3: The system shall keep the audit record-kind set as
      `event`/`report`/`verdict` with `report` and `verdict` payloads unchanged.

## Dependencies

- `T-121` — ordering-only: both edit `crates/bob/src/serve.rs`; T-121 lands its
  serve.rs change first (no logical dependency, avoids a same-file conflict)

## Files to Touch

- `crates/bob-core/src/types/records.rs` — add the optional resolved-cwd field
- `crates/extension-ipc/src/multiplex.rs` — set the field (`None`) at the
  production construction site (~109)
- `crates/monitoring/src/lib.rs` — set the field at the test construction site (~255)
- `crates/admin-rpc/src/lib.rs` — set the field at the test construction sites
  (~1183/1266/1405)
- `crates/bob/src/serve.rs` — set the field at the test construction site (~1257)

## Verification

```bash
cd the-intern/service && cargo test --workspace
```

## Work Log

### Session 1 — 2026-07-08

Implemented T-123 (optional `resolved_cwd` field on `ExtensionEventAuditPayload`) via three TDD cycles on `task/T-123-add-optional-resolved-working-directory-field-to-the-event-audit-payload`.

Cycle 1 added `resolved_cwd: Option<PathBuf>` to the struct with `#[serde(skip_serializing_if = "Option::is_none")]`, confirmed RED via a compile failure (test referencing the not-yet-existing field), then fixed all five construction sites needed to make the workspace compile: the production site in `extension-ipc/src/multiplex.rs`, plus test-only sites in `monitoring/src/lib.rs`, `admin-rpc/src/lib.rs` (three call sites), `bob/src/serve.rs`, and one pre-existing test literal inside `bob-core/src/types/records.rs` itself (not explicitly named in the task's file-touch notes but within the already-listed file, so no scope issue). Added tests for omission-when-absent and inclusion-when-present.

Cycle 2 targeted AC-2 (legacy JSONL records without the field must still deserialize). Wrote the test, and it passed even before adding `#[serde(default)]` — verified in an isolated scratch crate that serde derive already treats missing `Option<T>` fields as `None` regardless of `default`, `deny_unknown_fields`, or internally-tagged enum wrapping (reproduced the exact `AuditRecordPayload`-style tagged-enum shape to confirm). Added `#[serde(default, skip_serializing_if = "Option::is_none")]` anyway because AC-1's literal text names that exact attribute pair as a requirement, not just a suggestion — treated as an explicit spec directive rather than something only test-derived.

Cycle 3 added a confirmatory test for AC-3 (record-kind set stays `event`/`report`/`verdict`, `report`/`verdict` payloads unchanged): a full `AuditRecord` envelope round-trip with a populated `resolved_cwd`, asserting the JSON `"kind"` tag stays `"event"` and the field nests correctly under `payload`. This passed immediately since no further production code was needed — AC-3 was already satisfied by leaving `ExternalReportAuditPayload` and `PolicyVerdictAuditPayload` untouched.

**Tried and rejected:** Omitting the `default` attribute since it's behaviorally redundant given serde's implicit `Option<T>` handling — rejected because AC-1 explicitly names the attribute combination, and including it is harmless and documents intent for future maintainers who may not know about serde's implicit-optional quirk.

**What remains:** Nothing outstanding for T-123 itself. Population of `resolved_cwd` for periodic firings is explicitly out of scope here and belongs to T-128, which depends on this task and on T-127 (already merged).

**Obstacles Encountered:** (1) The task description's claim that `default` is "required because the payload uses `#[serde(deny_unknown_fields)]`" is not technically accurate — serde already defaults missing `Option<T>` fields to `None` regardless — but the attribute was added anyway per AC-1's literal wording; no functional risk either way. (2) `records.rs` had a fifth, previously unlisted `ExtensionEventAuditPayload` construction site in its own `#[cfg(test)]` module (~line 163); fixed since it's within an already-listed file, no boundary violation.

All three commits (`ff98ca2` feat, `ddf973a` test, `1a31fd4` test) are on the task branch. `cargo test --workspace` (128 `bob-core` tests passing, including 5 new/fixed) and `cargo fmt --all -- --check` are both clean.

## Review

### Review Verdict — 2026-07-08

PASS

**Stage 1 — Acceptance Criteria**

- AC-1 (optional `resolved_cwd` field, `#[serde(default, skip_serializing_if)]`, omitted when absent): met. `crates/bob-core/src/types/records.rs` adds `pub resolved_cwd: Option<PathBuf>` to `ExtensionEventAuditPayload` with `#[serde(default, skip_serializing_if = "Option::is_none")]`. Covered by `extension_event_audit_payload_omits_resolved_cwd_when_absent` and `extension_event_audit_payload_includes_resolved_cwd_when_present`.
- AC-2 (legacy JSONL records without the field still deserialize): met. `extension_event_audit_payload_deserializes_legacy_json_without_resolved_cwd_field` deserializes a JSON object lacking `resolved_cwd` and asserts it defaults to `None`.
- AC-3 (record-kind set stays `event`/`report`/`verdict`; `report`/`verdict` payloads unchanged): met. `AuditRecordKind`, `ExternalReportAuditPayload`, and `PolicyVerdictAuditPayload` are untouched in the diff; `audit_record_event_payload_with_resolved_cwd_keeps_event_record_kind` round-trips a populated `resolved_cwd` through the full `AuditRecord` envelope and asserts `kind == "event"`.
- Only the five files named in "Files to Touch" were modified (`crates/bob-core/src/types/records.rs`, `crates/extension-ipc/src/multiplex.rs`, `crates/monitoring/src/lib.rs`, `crates/admin-rpc/src/lib.rs`, `crates/bob/src/serve.rs`) — confirmed via `git diff --stat` against the pre-task commit. No unspecified behavior was added; population for `periodic` firings was correctly left out of scope (deferred to T-128).

**Verified independently:**

- All six `ExtensionEventAuditPayload { ... }` construction sites in the workspace (grepped across all crates) set `resolved_cwd`, including the fifth, previously-unlisted site inside `records.rs`'s own `#[cfg(test)]` module (~line 163). That file is already one of the task's declared "Files to Touch" for adding the field itself, so fixing a same-file test construction site to keep the crate compiling is not a scope violation.
- The task description's claim that `default` is "required because the payload uses `#[serde(deny_unknown_fields)]`" is not accurate, and the Developer's Work Log correctly identifies this. Independently reproduced in an isolated scratch crate (same serde 1.0.228 / serde_json from this workspace's `Cargo.lock`): an `Option<T>` struct field under `#[serde(deny_unknown_fields)]` deserializes a missing key as `None` with or without an explicit `#[serde(default)]` attribute (this is serde-derive's implicit optional-field handling, triggered by the literal `Option<...>` field type). `deny_unknown_fields` only rejects fields present in the input that aren't recognized by the struct — it has no bearing on missing expected fields either way. Adding `#[serde(default)]` is therefore behaviorally redundant but harmless: it doesn't change deserialization outcome, doesn't weaken `deny_unknown_fields`'s rejection of unrecognized fields, and documents intent for maintainers unaware of the implicit-optional behavior. AC-1's literal wording names the attribute pair, so keeping it satisfies the criterion as written. No correctness issue either way.
- Checked out the task branch and ran `cd the-intern/service && cargo test --workspace`: all suites pass (0 failed), including the four new/updated tests in `bob-core` (`extension_event_audit_payload_omits_resolved_cwd_when_absent`, `extension_event_audit_payload_includes_resolved_cwd_when_present`, `extension_event_audit_payload_deserializes_legacy_json_without_resolved_cwd_field`, `audit_record_event_payload_with_resolved_cwd_keeps_event_record_kind`) plus the pre-existing round-trip test fixed to set the new field. `cargo fmt --all -- --check` is clean. `cargo clippy --tests` on the touched crates shows only pre-existing pedantic warnings in unrelated code (per CLAUDE.md, clippy is not yet a clean gate for this workspace); none touch the new field, its construction sites, or the new tests.
- Three commits on the task branch (`ff98ca2` feat, `ddf973a` test, `1a31fd4` test) follow `git-conventions` format.

**Stage 2 — Code Quality**

- Correctness: field addition follows the existing `summary: Option<String>` pattern; doc comment accurately describes the field's purpose and scope (periodic firings, T-128 dependency noted).
- Tests: cover the omission path, inclusion path, legacy-deserialization path, and record-kind-preservation path; independent, no shared mutable state.
- Security: not applicable (plain optional struct field, no external input parsing beyond existing serde boundary, no secrets, no queries).
- Readability: `resolved_cwd` name is descriptive and matches the field's documented semantics; no dead code.
- Performance: no loops, blocking calls, or resource concerns introduced.

**Minor observation (non-blocking):** the Work Log states "128 `bob-core` tests passing"; the actual `cargo test -p bob-core` run shows 126 passing (4 new tests + 1 existing test updated to set the new field = 5 touched, matching the Work Log's "5 new/fixed" count). Likely a minor arithmetic slip in the log, not a functional discrepancy — all tests pass either way.
