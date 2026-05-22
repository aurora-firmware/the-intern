---
title: "Progress Report — 2026-05-20"
status: draft  # draft | final
created: 2026-05-20
---

# Progress Report — 2026-05-20

## Summary

Active specs: 4. Pending tasks: 0. In progress tasks: 0. Completed tasks: 58. Blocked tasks: 0. Open bugs: 0. Bugs in progress: 0. Resolved bugs: 6. ADRs: 3. Latest integration result: chore(tasks): merge T-058 implement policy reload admin rpc.

## Specifications

| Spec | Status | Notes |
|---|---|---|
| bob-service-shell-architecture.md | approved | Current Gate 5 target |
| js-extension-for-pi-agent-event-forwarding.md | approved | Current Gate 5 target |
| policy-control-pre-flight-admission-and-the-blocking-tool-call-authorization-path.md | approved | Current Gate 5 target |
| the-intern-agent-service-architecture.md | approved | Current Gate 5 target |

## Integration Evidence

- Latest integration-test result: chore(tasks): merge T-058 implement policy reload admin rpc
- Source: git log --all --grep=merge|integration|verification|test -n 1
- Date: 2026-05-20

## Completed

| Task ID | Title | Agent Role |
|---|---|---|
| T-001 | Scaffold GitHub Actions CI: build, test, deploy | unassigned |
| T-002 | Write Rust and NodeJS coding guidelines | unassigned |
| T-003 | Create the-intern code folder structure (service + extensions) | unassigned |
| T-004 | Add VSCode devcontainer pointing at a local dev image | unassigned |
| T-005 | Write phase-based project roadmap | unassigned |
| T-006 | Refresh repo documentation to reflect foundations work | unassigned |
| T-007 | Establish Cargo workspace and bob-core crate skeleton | unassigned |
| T-008 | Add bob-core domain types | unassigned |
| T-009 | Add bob-core error taxonomy | unassigned |
| T-010 | Add bob-core port traits | unassigned |
| T-011 | Scaffold IPC actor crates admin-rpc and extension-ipc | unassigned |
| T-012 | Scaffold core subsystem actor crates requests-handler policy-control monitoring | unassigned |
| T-013 | Scaffold pi-agent-supervisor and persistence actor crates | unassigned |
| T-014 | Create bob binary skeleton with clap subcommand dispatch | unassigned |
| T-015 | Implement bob configuration loader with layered sources | unassigned |
| T-016 | Implement bob tracing initialization | unassigned |
| T-017 | Implement bob serve runtime wiring and graceful shutdown | unassigned |
| T-018 | Implement admin-rpc UDS listener with permissions and peer-cred gate | unassigned |
| T-019 | Implement admin-rpc JSON-RPC 2.0 framing and method dispatch | unassigned |
| T-020 | Implement admin-rpc subscription notification plumbing | unassigned |
| T-021 | Implement extension-ipc UDS listener with permissions and peer-cred gate | unassigned |
| T-022 | Implement extension-ipc framing session multiplex and deny-by-default verdict | unassigned |
| T-023 | Implement bob admin-rpc client primitive | unassigned |
| T-024 | Implement bob client subcommands status sessions audit chat policy | unassigned |
| T-025 | Add end-to-end shell integration smoke test | unassigned |
| T-026 | Implement requests-handler internal event queue with backpressure | unassigned |
| T-027 | Implement requests-handler identity attachment and pre-flight check | unassigned |
| T-028 | Implement persistence in-memory inbound queue and session state stores | unassigned |
| T-029 | Wire real requests-handler and persistence into bob serve | unassigned |
| T-030 | Add Phase 1b integration tests for queue and session state | unassigned |
| T-031 | Add pi-agent supervisor RPC process configuration | unassigned |
| T-032 | Implement pi-agent RPC child process lifecycle | unassigned |
| T-033 | Implement pi-agent session registry and warm pool | unassigned |
| T-034 | Add pi-agent RPC prompt routing | unassigned |
| T-035 | Implement pi-agent idle reaping and session kill | unassigned |
| T-036 | Wire Phase 2 supervisor into bob serve and admin sessions | unassigned |
| T-037 | Scaffold the the-intern/extensions Node project for the bob extension | unassigned |
| T-038 | Implement the bob extension bob.ts with event forwarding to extension.sock | unassigned |
| T-039 | Set BOB_SESSION_ID and BOB_EXTENSION_SOCK_PATH on every pi-agent child spawn | unassigned |
| T-040 | Wire TracingMonitoringHandle into extension-ipc actor for forwarded events | unassigned |
| T-041 | Deduplicate PeerCred between admin-rpc and extension-ipc | unassigned |
| T-042 | Rename collision between bob-core SubscriptionId and admin-rpc SubscriptionId | unassigned |
| T-043 | Make BobConfig socket-path fields non-empty by construction | unassigned |
| T-044 | Cover ctx.ui.notify warning branch in bob.test.ts | unassigned |
| T-045 | Cover unknown-session-after-default-route-close path in extension-ipc multiplex tests | unassigned |
| T-046 | Document connect-window pipelining vs forbidden retry-buffering in extensions README | unassigned |
| T-047 | Annotate placeholder crates with doc scaffold markers | unassigned |
| T-048 | Document inbound-write back-pressure coupling in extension-ipc run_connection | unassigned |
| T-049 | Define the policy ruleset config schema and validated snapshot types | unassigned |
| T-050 | Implement the policy argument matcher with glob and field-path matching | unassigned |
| T-051 | Implement PolicyEngine admission and action evaluation | unassigned |
| T-052 | Add the lock-free ruleset snapshot handle and reload-capable policy-control actor | unassigned |
| T-053 | Wire the bob policy config section and policy-control snapshot into startup | unassigned |
| T-054 | Route the pre-flight admission gate through the policy snapshot | unassigned |
| T-055 | Remove the unused user field from the Authz wire frame | unassigned |
| T-056 | Implement the action gate evaluation in extension-ipc multiplex | unassigned |
| T-057 | Add the blocking tool_call authorization hook to the bob extension | unassigned |
| T-058 | Implement the policy.reload admin-RPC method | unassigned |

## In Progress

| Task ID | Title | Agent Role | Notes |
|---|---|---|---|
| none | n/a | n/a | no in-progress tasks |

## Blocked

| Task ID | Title | Blocked By | Action Needed |
|---|---|---|---|
| none | n/a | n/a | no action needed |

## Bugs

| Bug ID | Title | Severity | Status | Diagnosis Status |
|---|---|---|---|---|
| B-001 | bob serve does not answer status/sessions over admin socket | high | resolved | complete |
| B-002 | pi-agent-supervisor terminate test flakes under load because spawn_config sets 50 ms deadline | high | resolved | complete |
| B-003 | bob extension can grow memory without bound — pendingFrames uncapped and socket.write() return ignored | high | resolved | complete |
| B-004 | extension-ipc multiplex caches default_route permanently for unknown session ids | medium | resolved | complete |
| B-005 | bob serve admin-socket existence check is a TOCTOU race after admin_rpc::start() | medium | resolved | complete |
| B-006 | bob serve MonitoringAuditSink stringifies AuditKind via Debug and has no test | medium | resolved | complete |

## Decisions

| ADR | Title | Status |
|---|---|---|
| ADR-001 | Admin-RPC framing newline-delimited JSON | accepted |
| ADR-002 | Bob configuration format TOML via figment | accepted |
| ADR-003 | Admin client crate boundary lives in bob binary crate | accepted |

## Next Actions

1. No immediate actions.

## Risks and Concerns

- No immediate risks identified.
