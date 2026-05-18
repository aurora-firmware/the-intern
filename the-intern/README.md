# the-intern

This folder is the top-level home for application code for the Intern.

- `service/` contains the Rust service workspace. The `bob` binary now has the
  Phase 1 service shell plus working queue, requests-handler pre-flight, and
  in-memory persistence.
- `extensions/` is reserved for JS extension code authored for pi-agent in a
  later phase.

Architecture references:

- [`../project/specs/the-intern-agent-service-architecture.md`](../project/specs/the-intern-agent-service-architecture.md)
- [`../project/specs/bob-service-shell-architecture.md`](../project/specs/bob-service-shell-architecture.md)
