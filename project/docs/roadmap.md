# the-intern Project Roadmap

## Phase 0 — Foundations
Phase 0 establishes the delivery baseline with CI scaffolding, coding guidelines, and the `the-intern/service` plus `the-intern/extensions` layout so later architecture work lands in a stable environment. This preparatory phase aligns with the execution sequence described in `project/specs/the-intern-agent-service-architecture.md`, which defines the ordered implementation roadmap that starts at service fundamentals.

## Phase 1 — Rust service skeleton

**Status: complete through Phase 1b.**

Phase 1 delivers the deterministic backbone for all later runtime behavior, in two steps defined by `project/specs/the-intern-agent-service-architecture.md` (S-001) and `project/specs/bob-service-shell-architecture.md` (S-002):

- **Phase 1a — Service shell (S-002).** The `bob` binary, single Tokio runtime, the two Unix-domain sockets (`admin.sock` for JSON-RPC 2.0 control + future GUI/API; `extension.sock` for the JS-extension channel from S-001), subsystem actor scaffolds with port traits in the runtime-agnostic `bob-core` library crate, graceful shutdown, and the non-`serve` `bob` subcommands implemented as thin admin-RPC clients.
- **Phase 1b — Working core subsystems (S-001 Implementation Order Phase 1).** Fill the scaffolds with the internal event queue, the Requests Handler, and persistence — landing them into the seats the shell already reserved.

Current Phase 1 evidence includes a passing workspace test suite, shell E2E
coverage for `bob serve`/`bob status`/`bob sessions list --json`, and
integration coverage for requests-handler queue backpressure plus persistence
session-state roundtrips.

Phase 1a is positioned first because every later runtime feature lands into the shell; Phase 1b is positioned immediately after because S-001 Phases 2-7 depend on the working queue/handler/persistence rather than on the bare scaffolds.

## Phase 2 — pi-agent process supervision
Phase 2 adds per-session pi-agent lifecycle control, including spawn orchestration, warm-pool management, idle reaping, and prompt delivery over `runRpcMode()` so the service can run isolated long-lived sessions. This implements Implementation Order Phase 2 from `project/specs/the-intern-agent-service-architecture.md`, and it follows Phase 1b because supervision and prompt routing require the working queue/handler/persistence — not just the shell scaffolds from Phase 1a.

## Phase 3 — JS extension
Phase 3 delivers the in-agent JS extension surface for event subscription and forwarding so runtime activity can be exported from each session process into the service boundary. This implements Implementation Order Phase 3 and Component 3 in `project/specs/the-intern-agent-service-architecture.md`, and it builds on Phase 2 because the extension behavior is meaningful only once supervised pi-agent sessions are running.

## Phase 4 — Policy Control
Phase 4 introduces deterministic pre-flight access checks and the blocking `tool_call` authorization path over the Unix socket to enforce action gating outside the agent process. This implements Implementation Order Phase 4 in `project/specs/the-intern-agent-service-architecture.md`, and it depends on Phase 2 session supervision plus Phase 3 extension forwarding to carry policy decisions into the agent execution path.

## Phase 5 — Monitoring
Phase 5 establishes append-only audit capture and the inbound reporting interface used by external tools so every authorized action and event path is observable and traceable. This implements Implementation Order Phase 5 in `project/specs/the-intern-agent-service-architecture.md`, and it follows Phase 1 service foundations while using Phase 3 extension forwarding to receive runtime events.

## Phase 6 — Channel adapters
Phase 6 delivers channel adapter integrations for chat, email, and scheduler inputs so heterogeneous inbound traffic is normalized into a single internal event model. This implements Implementation Order Phase 6 in `project/specs/the-intern-agent-service-architecture.md`, and it follows Phase 1 because adapter intake feeds directly into the service queue and request handling surfaces created there.

## Phase 7 — Actions
Phase 7 defines action skills plus the CLI invocation and reporting contract so side-effect execution is controlled, attributable, and consistent across tools invoked through the agent harness. This implements Implementation Order Phase 7 in `project/specs/the-intern-agent-service-architecture.md`, and it depends on Phase 4 policy enforcement and Phase 5 monitoring to ensure execution is both authorized and auditable.
