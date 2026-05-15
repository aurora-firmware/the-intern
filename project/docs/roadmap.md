# the-intern Project Roadmap

## Phase 0 — Foundations
Phase 0 establishes the delivery baseline with CI scaffolding, the local development container, coding guidelines, and the `the-intern/service` plus `the-intern/extensions` layout so later architecture work lands in a stable environment. This preparatory phase aligns with the execution sequence described in `project/specs/the-intern-agent-service-architecture.md`, which defines the ordered implementation roadmap that starts at service fundamentals.

## Phase 1 — Rust service skeleton
Phase 1 delivers the initial Rust service core with the internal event queue, Requests Handler, and persistence surfaces that become the deterministic backbone for all later runtime behavior. This implements Implementation Order Phase 1 and Component 1 in `project/specs/the-intern-agent-service-architecture.md` and is positioned first because all later runtime features depend on this shared service base.

## Phase 2 — pi-agent process supervision
Phase 2 adds per-session pi-agent lifecycle control, including spawn orchestration, warm-pool management, idle reaping, and prompt delivery over `runRpcMode()` so the service can run isolated long-lived sessions. This implements Implementation Order Phase 2 from `project/specs/the-intern-agent-service-architecture.md`, and it follows Phase 1 because supervision and prompt routing require the service skeleton to exist first.

## Phase 3 — JS extension
Phase 3 delivers the in-agent JS extension surface for event subscription and forwarding so runtime activity can be exported from each session process into the service boundary. This implements Implementation Order Phase 3 and Component 3 in `project/specs/the-intern-agent-service-architecture.md`, and it builds on Phase 2 because the extension behavior is meaningful only once supervised pi-agent sessions are running.

## Phase 4 — Policy Control
Phase 4 introduces deterministic pre-flight access checks and the blocking `tool_call` authorization path over the Unix socket to enforce action gating outside the agent process. This implements Implementation Order Phase 4 in `project/specs/the-intern-agent-service-architecture.md`, and it depends on Phase 2 session supervision plus Phase 3 extension forwarding to carry policy decisions into the agent execution path.

## Phase 5 — Monitoring
Phase 5 establishes append-only audit capture and the inbound reporting interface used by external tools so every authorized action and event path is observable and traceable. This implements Implementation Order Phase 5 in `project/specs/the-intern-agent-service-architecture.md`, and it follows Phase 1 service foundations while using Phase 3 extension forwarding to receive runtime events.

## Phase 6 — Channel adapters
Phase 6 delivers channel adapter integrations for chat, email, webhooks, and scheduler inputs so heterogeneous inbound traffic is normalized into a single internal event model. This implements Implementation Order Phase 6 in `project/specs/the-intern-agent-service-architecture.md`, and it follows Phase 1 because adapter intake feeds directly into the service queue and request handling surfaces created there.

## Phase 7 — Actions
Phase 7 defines action skills plus the CLI invocation and reporting contract so side-effect execution is controlled, attributable, and consistent across tools invoked through the agent harness. This implements Implementation Order Phase 7 in `project/specs/the-intern-agent-service-architecture.md`, and it depends on Phase 4 policy enforcement and Phase 5 monitoring to ensure execution is both authorized and auditable.
