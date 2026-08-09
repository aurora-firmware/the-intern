---
title: "Progress Report — 2026-08-05"
status: draft  # draft | final
created: 2026-08-05
---

# Progress Report — 2026-08-05

## Summary

Active specs: 9. Pending tasks: 0. In progress tasks: 0. Completed tasks: 141. Blocked tasks: 0. Open bugs: 0. Bugs in progress: 2. Resolved bugs: 31. ADRs: 13. Latest integration result: chore(bugs): merge B-032 trace denied authz call arguments.

## Specifications

| Spec | Status | Notes |
|---|---|---|
| S-001-the-intern-agent-service-architecture.md | approved | Current Gate 5 target |
| S-002-bob-service-shell-architecture.md | approved | Current Gate 5 target |
| S-003-js-extension-for-pi-agent-event-forwarding.md | approved | Current Gate 5 target |
| S-004-policy-control-pre-flight-admission-and-the-blocking-tool-call-authorization-path.md | approved | Current Gate 5 target |
| S-005-monitoring-audit-log-and-external-action-reporting.md | approved | Current Gate 5 target |
| S-006-channel-adapter-framework.md | approved | Current Gate 5 target |
| S-007-user-facing-documentation-site-mdbook.md | approved | Current Gate 5 target |
| S-009-scheduler-channel-adapter-and-bob-schedule-cli.md | approved | Current Gate 5 target |
| S-010-email-skills-for-pi-agent-himalaya-cli-reference-and-classification-driven-triage.md | approved | Current Gate 5 target |

## Integration Evidence

- Latest integration-test result: chore(bugs): merge B-032 trace denied authz call arguments
- Source: git log --all --grep=merge|integration|verification|test -n 1
- Date: 2026-08-05

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
| T-059 | Define canonical monitoring audit domain types | unassigned |
| T-060 | Implement persistent JSONL monitoring actor | unassigned |
| T-061 | Add monitoring configuration and startup wiring | unassigned |
| T-062 | Add report.submit admin-RPC facade | unassigned |
| T-063 | Wire audit.tail to Monitoring subscriptions | unassigned |
| T-064 | Add audit tail filter CLI support | unassigned |
| T-065 | Record extension events and policy verdicts in Monitoring | unassigned |
| T-066 | Add Monitoring integration coverage | unassigned |
| T-067 | Reshape InternalEvent from per-channel variants to delivery-kind-typed requests | unassigned |
| T-068 | Carry RequestContext through the requests-handler intake path | unassigned |
| T-069 | Add the channel configuration schema to BobConfig | unassigned |
| T-070 | Create the chat-adapter crate with the chat-normalization actor | unassigned |
| T-071 | Implement admin-rpc chat.send forwarding to the chat adapter | unassigned |
| T-072 | Wire the chat adapter into bob serve with supervision and shutdown | unassigned |
| T-073 | Carry self-asserted application identity through the chat.send intake path per ADR-005 | unassigned |
| T-074 | Remove the redundant in-service uid allow-list, leaving socket permissions as the sole connection gate | unassigned |
| T-075 | Add pi-agent compatibility verification for bob extension | unassigned |
| T-076 | Remove vestigial IPC handle command scaffolds | unassigned |
| T-077 | Scaffold mdBook documentation project under the-intern/docs | developer |
| T-078 | Write end-user CLI guide content with worked examples | developer |
| T-079 | Write operator and deployer guide content | developer |
| T-080 | Write architecture overview content for non-implementers | developer |
| T-081 | Write extension and channel-adapter author guide content | developer |
| T-082 | Implement CLI reference generator wired into the docs build | developer |
| T-083 | Integrate docs build into release workflow and attach archive as release asset | developer |
| T-084 | Update repository README to point at user documentation and release docs archive | developer |
| T-085 | Implement chat reply router in admin-rpc | developer |
| T-086 | Make chat.open establish a push channel with forwarder and teardown | developer |
| T-087 | Thread chat subscription id through inbound chat frames | developer |
| T-088 | Map CLI --session to context_id and retire the session wire field | developer |
| T-089 | Make the CLI chat receive loop frame-safe under concurrent send and stdin | developer |
| T-090 | Add end-to-end test for outbound chat delivery | developer |
| T-091 | Update user documentation for interactive bob chat | developer |
| T-092 | Add schedule config schema to BobConfig | developer |
| T-093 | Create scheduler-adapter crate with actor scaffold | developer |
| T-094 | Wire scheduler adapter into bob-serve supervision tree | developer |
| T-095 | Implement cron tick loop and periodic InternalRequest firing in scheduler-adapter | developer |
| T-096 | Expose scheduler ReloadHandle and wire into admin-RPC dispatcher | developer |
| T-097 | Implement schedule.add/remove/list/reload admin-RPC methods with config persistence | developer |
| T-098 | Add bob schedule CLI subcommands (add/remove/list/reload) | developer |
| T-099 | Document bob schedule commands and [schedule] config section in operator guide | developer |
| T-100 | Add extension_path config key and XDG_DATA_HOME resolution | developer |
| T-101 | Pass --extension to pi spawn and fail closed when the extension file is missing | developer |
| T-102 | Document the bob extension by-path install model in the extension README | developer |
| T-103 | Verify pi interactive-session invocation interface and decide the terminal-brokering mechanism | unassigned |
| T-104 | Add an interactive supervised pi-spawn mode to the pi-agent supervisor | developer |
| T-105 | Add admin-RPC interactive-session open/attach with stdio brokering | developer |
| T-106 | Make bob chat a service-required launcher for the supervised interactive pi session | developer |
| T-107 | Retire the admin-socket interactive-chat path and remove the chat admission stopgap | developer |
| T-108 | Update user docs for interactive bob chat and the extension by-path install | developer |
| T-109 | Implement admitted periodic request dispatch to pi-agent | developer |
| T-110 | Add end-to-end scheduled prompt execution coverage | developer |
| T-111 | Align scheduler cron evaluation with local wall-clock time | developer |
| T-112 | Document scheduled execution policy and cron semantics | developer |
| T-113 | Add JSON schedule state store path and persistence | unassigned |
| T-114 | Load scheduler entries from JSON state at startup | unassigned |
| T-115 | Persist schedule RPC mutations to JSON state | unassigned |
| T-116 | Update scheduler docs and end-to-end coverage for JSON state | unassigned |
| T-117 | Admit scheduler firings without UUID policy entries | unassigned |
| T-118 | Add optional cwd field to ScheduleEntry with absolute-path validation | developer |
| T-119 | Add pi_agent_cwd service-wide worker working-directory config key | developer |
| T-120 | Carry a job-id correlator through the inbound persistence queue | developer |
| T-121 | Spawn pi-agent pool workers with an explicit service-wide working directory | developer |
| T-122 | Add cwd-aware dedicated-worker session acquisition bounded by max_processes | developer |
| T-123 | Add optional resolved working-directory field to the event audit payload | developer |
| T-124 | Surface per-entry cwd in schedule.add and schedule.list admin-RPC handlers | developer |
| T-125 | Add --cwd flag to bob schedule add and render cwd in schedule list | developer |
| T-126 | Wire pi_agent_cwd to the supervisor and carry the job id from periodic enqueue to dispatch | developer |
| T-127 | Resolve per-entry scheduled cwd at dispatch with precedence and fire-time skip | developer |
| T-128 | Record the resolved working directory in the periodic event audit record | developer |
| T-129 | Document pi_agent_cwd, --cwd, precedence, and owner-only cwd trust in the operator guide | developer |
| T-130 | Add end-to-end coverage for scheduled per-entry cwd execution | developer |
| T-131 | Verify pi cwd-relative skill discovery and scaffold the email-skills package | developer |
| T-132 | Author the himalaya CLI-reference skill | developer |
| T-133 | Add the daily worklog format and skip-tolerant reconciliation reference | developer |
| T-134 | Add the manager-escalation reference and skill-local configuration template | developer |
| T-135 | Author the email-triage skill core loop | developer |
| T-136 | Define the starter category taxonomy and wire classification into the email-triage skill | developer |
| T-137 | Add the file-without-reply category workflows | developer |
| T-138 | Add the correspondence category workflows | developer |
| T-139 | Validate the deployed package against a live scheduled job happy path | developer |
| T-140 | Validate the escalation, block, and next-run continuity paths | developer |
| T-141 | Document email triage operator setup in the operator guide | developer |

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
| B-030 | hardened escalation-send command shape needs live end-to-end validation before production use | high | in-progress | in progress |
| B-031 | direct-request/meeting-scheduling reply-send S-004 rule needs live end-to-end validation before production use | high | in-progress | in progress |
| B-001 | bob serve does not answer status/sessions over admin socket | high | resolved | complete |
| B-002 | pi-agent-supervisor terminate test flakes under load because spawn_config sets 50 ms deadline | high | resolved | complete |
| B-003 | bob extension can grow memory without bound — pendingFrames uncapped and socket.write() return ignored | high | resolved | complete |
| B-004 | extension-ipc multiplex caches default_route permanently for unknown session ids | medium | resolved | complete |
| B-005 | bob serve admin-socket existence check is a TOCTOU race after admin_rpc::start() | medium | resolved | complete |
| B-006 | bob serve MonitoringAuditSink stringifies AuditKind via Debug and has no test | medium | resolved | complete |
| B-007 | bob build fails in requests-handler due to audit type mismatch | high | resolved | complete |
| B-008 | Invalid request when calling bob chat — chat.send requires params.id (GitHub issue #16) | high | resolved | complete |
| B-009 | Production extension.sock bind omits the documented 0700/0660 permission gate | medium | resolved | complete |
| B-010 | Shipped user docs link to internal project documents (GitHub issue #17) | medium | resolved | complete |
| B-011 | bob serve waits for shutdown timeouts after Ctrl-C or SIGTERM | medium | resolved | complete |
| B-012 | B-009 gated extension.sock bind regressed startup failure handling and shutdown connection draining | medium | resolved | complete |
| B-013 | admin-rpc dispatch sessions.list/kill tests fail under T-101 extension fail-closed gate | high | resolved | complete |
| B-014 | Bob serve omits interactive pi spawn configuration | medium | resolved | complete |
| B-015 | Interactive pi exit notification waits for idle reaper | medium | resolved | complete |
| B-016 | Extension rejects structured authz verdicts as transport errors | critical | resolved | complete |
| B-017 | periodic dispatcher kills pi worker immediately after prompt delivery ack | high | resolved | complete |
| B-018 | stale second bob extension instance silently blocks all tool calls | medium | resolved | complete |
| B-019 | bob.ts treats normal socket write backpressure as fatal and fail-closes the session | medium | resolved | complete |
| B-020 | Remove legacy TOML write_schedule_entries schedule-store writer (dead code, would not persist cwd) | low | resolved | complete |
| B-021 | bob chat interactive session does not use the bob chat invocation cwd as CR-005/S-002 specify | medium | resolved | complete |
| B-022 | schedule.add write-error test fails in CI because root bypasses the 0o500 permission check | high | resolved | complete |
| B-023 | periodic dispatcher re-enqueues non-periodic events, reordering the shared inbound persistence queue | high | resolved | complete |
| B-024 | session.interactive.open accepts blank or relative cwd values without validation | medium | resolved | complete |
| B-025 | periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt intermittently fails on CI with idle-reaper timeout elapsed | high | resolved | complete |
| B-026 | periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt still hangs the full 20s timeout on CI after B-025's widen+multi_thread fix | high | resolved | complete |
| B-027 | dev-agent pushes trigger duplicate concurrent Tests runs (push + pull_request), causing resource contention that stalls periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt | high | resolved | complete |
| B-028 | periodic_event_is_dispatched_to_pi_agent_with_payload_as_prompt fails deterministically in CI with no local repro, even with contention eliminated - needs #[ignore] pending runner-level investigation | medium | resolved | complete |
| B-029 | direct-request and meeting-scheduling reply categories have no S-004 allow-rule and were never live-validated | high | resolved | complete |
| B-032 | denied tool calls are unattributable — neither bob's audit record nor any log captures the arguments | medium | resolved | complete |
| B-033 | S-004 rule set may not admit email-triage SKILL.md's opening bash/read calls (absolute vs cwd-relative path mismatch) | high | resolved | complete |

## Decisions

| ADR | Title | Status |
|---|---|---|
| ADR-001 | Admin-RPC framing newline-delimited JSON | accepted |
| ADR-002 | Bob configuration format TOML via figment | accepted |
| ADR-003 | Admin client crate boundary lives in bob binary crate | accepted |
| ADR-004 | Inbound request interface typed by delivery kind (sync/async/periodic) | accepted |
| ADR-005 | Application-level request identity is self-asserted within the local-socket trust boundary | accepted |
| ADR-006 | Bob-internal scheduling over system cron | accepted |
| ADR-007 | Local control plane over a single JSON-RPC Unix-domain socket | accepted |
| ADR-008 | Single-user-local deployment scope | accepted |
| ADR-009 | bob filesystem layout follows the XDG Base Directory specification | accepted |
| ADR-010 | Interactive chat is exempt from pre-flight admission | accepted |
| ADR-011 | Interactive chat brokers the client terminal to pi via SCM_RIGHTS fd-passing | accepted |
| ADR-012 | Scheduler admission uses Unix trust boundary and JSON state | accepted |
| ADR-013 | Inbound persistence queue carries a job-id correlator so the periodic dispatcher resolves per-entry execution context from the live schedule table | accepted |

## Next Actions

1. **Retry live E2E validation for `B-030` and `B-031`** once pi's `openai-codex`
   (ChatGPT Plus) provider quota resets — ETA ~2026-08-08, independently
   confirmed via direct probe as of this report. Both bugs need a real
   `bob` + `himalaya` + live-mailbox session; they can reasonably be
   validated together in one session (`B-030`: hardened escalation-send;
   `B-031`: `direct-request`/`meeting-scheduling` reply-send). Both remain
   parked in `bugs/in-progress/` — there is no `blocked/` lifecycle state
   for bugs, and moving them back to `open/` would invite a fresh pickup
   that immediately re-hits the same lockout.
2. Consider whether the `B-032` fix (denied-call tracing in
   `extension-ipc`) should also be exercised live during that same retry
   session, to confirm the instrumentation actually surfaces a
   human-readable command string for any future denial, not just under
   the unit-test harness.
3. If the ~72h wait is unacceptable on business timelines, a human should
   decide whether to authorize an alternate model-provider credential —
   the Architect's escalation-review for `B-030` explicitly declined to
   make this the default path, since the wait costs nothing beyond delay
   and the interval was otherwise fully used for actionable static work.

## Risks and Concerns

- **Two high-severity bugs (`B-030`, `B-031`) are parked, not resolved,**
  pending an external infrastructure blocker (pi's sole authenticated
  model provider is quota-exhausted, ETA ~2026-08-08). Neither the
  hardened escalation-send command shape nor the `direct-request`/
  `meeting-scheduling` reply-send S-004 rule has been live-validated end
  to end — both are verified only at the static/mechanism level
  (`wildmatch` matcher checks, shell-injection-safety proofs). Until the
  live pass runs, do not treat either category as fully trustworthy in
  a live production deployment, per both bugs' own explicit Fix
  Verification bars.
- A live E2E test that sends real outbound email was authorized and run
  once this session (for `B-030`'s initial diagnosis attempt) using the
  environment's configured `daneel@aurorafw.com` account; the run did not
  reach the escalation-send step before the quota lockout hit. Any future
  retry should reuse the documented isolated-workspace setup captured in
  `B-030`'s Diagnosis Log rather than re-deriving it, and should isolate
  the operator's real unseen mail for the duration of the run as that
  session did.
- Two new bugs were filed as a direct result of this session's escalation
  review and are already resolved (`B-032`, tracing gap; `B-033`, a
  suspected S-004 path-convention gap that turned out to be a
  false-positive — already fixed by `T-140` before `B-033` was filed).
  No further action needed on either.
