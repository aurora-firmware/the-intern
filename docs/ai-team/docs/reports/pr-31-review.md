# PR Review: aurora-firmware/the-intern#31 - Complete S-009 scheduled execution: dispatch, e2e coverage, local-time cron, docs

## Summary

Re-reviewed after the developer fix commit now at GitHub PR head `4ed9ddf0bfe5e157507793f46e529829078c9091`. The three prior findings are resolved and I found no new review findings.

| Scope | Files | Lines changed | Tier | Findings |
|---|---:|---:|---|---:|
| Source | 2 fix files | 62 | full | 0 |
| Documentation | 1 fix file | 13 | full | 0 |
| CI | 0 | 0 | n/a | 0 |
| Security | 2 flagged fix files | 62 | full | 0 |

## Findings

No findings.

## Resolved Prior Findings

### Source

- `the-intern/service/crates/bob/src/serve.rs`: periodic dispatch now calls `supervisor.kill_session(session_id)` after each one-shot prompt send, and the existing dispatch test now waits for the supervisor session list to become empty after delivery.
- `the-intern/service/crates/scheduler-adapter/src/lib.rs`: next-fire calculation is extracted into `next_cron_occurrence`, and the local-time regression test exercises that helper used by the tick loop.

### Documentation

- `the-intern/docs/src/operator-guide/index.md`: the guide now describes pre-flight denials as denied `verdict` audit records with `allow: false` and a reason beginning with `preflight denied:`, rather than as a non-existent `PreflightDenied` audit kind.

## Skipped files

None for the fix-branch delta. No lock files, vendored code, generated files, minified assets, source maps, or binary files were present.

## Review notes

- Fetched updated PR metadata, file patches, and review comments with `gh`; there were no existing review comments.
- Fetched `refs/pull/31/head` to `origin/pr-31` before the developer pushed the fix; refreshed PR metadata afterwards and confirmed GitHub now reports head `4ed9ddf0bfe5e157507793f46e529829078c9091`, matching local `dev-agent`.
- Reviewed the fix diff against the previous PR head: 3 files changed, 56 insertions, 19 deletions.
- Security lens: the session cleanup change reduces the prior resource-exhaustion risk; no new trust-boundary issue was found.

## Verification

- `cd the-intern/service && cargo test -p scheduler-adapter local_time_cron_next_occurrence_is_expressed_in_local_timezone` passed.
- `cd the-intern/docs && mdbook build` passed, with the existing mdbook-mermaid version warning.
- `cd the-intern/service && cargo test -p bob serve::tests::periodic::periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt` failed at subsystem startup with `ServiceDown`. The unchanged `serve::tests::periodic::periodic_dispatcher_starts_during_serve_startup` test also failed the same way, before exercising the new cleanup assertion, so I did not count it as a new finding against the fix branch. This workspace's AGENTS instructions note that some Unix-socket/process tests may fail in restricted environments; rerun the `bob` focused tests in a normal local shell before merge.

## Architecture consistency review

Result: PASS

Artifact reviewed: `project/specs/S-009-scheduler-channel-adapter-and-bob-schedule-cli.md`
Binding set checked: 11 accepted ADRs, 8 approved specs

Findings:
- none

Corrections routed:
- none

Next owner:
- none

Notes: the fix branch changes implementation, tests, and operator docs only; it does not change S-009, any approved spec, or any accepted ADR. The updated implementation remains consistent with S-009's fire-and-forget periodic workflow, ADR-004 periodic delivery semantics, ADR-006 bob-internal scheduling, ADR-007 `schedule.*` control-plane placement, ADR-010/S-004 pre-flight admission for queue-borne scheduler requests, and S-005's `verdict` audit record model.
