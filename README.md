# the-intern

The Intern is an AI office-assistant project with architecture, delivery state,
and early implementation tracked in this repository. The Rust service shell
(`bob`) now has a working Phase 1 foundation: Unix-socket admin and extension
IPC scaffolding, admin JSON-RPC client subcommands, request queue/pre-flight
wiring, in-memory persistence, graceful shutdown, and integration coverage for
the shell plus Phase 1b queue/session-state behavior.

## Start Here

- Product overview: [project/docs/system_overview.md](project/docs/system_overview.md)
- Delivery plan: [project/docs/roadmap.md](project/docs/roadmap.md)
- Approved specifications: [project/specs/the-intern-agent-service-architecture.md](project/specs/the-intern-agent-service-architecture.md), [project/specs/bob-service-shell-architecture.md](project/specs/bob-service-shell-architecture.md)
- Application layout: [`the-intern/service`](the-intern/service), [`the-intern/extensions`](the-intern/extensions)
- Rust service build/test instructions: [`the-intern/service/README.md`](the-intern/service/README.md)
- GitHub workflows: [`.github/workflows/`](.github/workflows/) currently contain placeholder build/test/deploy jobs; use the local commands below for real verification.
- Coding guidelines: [Node.js](project/docs/coding-guidelines-node.md), [Rust](project/docs/coding-guidelines-rust.md)

## Current State

- Task queue: drained through `T-030`; open/in-progress bug queue is empty.
- Completed service phase: Phase 1a shell and Phase 1b queue/handler/persistence.
- Main service workspace: `the-intern/service`.
- JS extension area: `the-intern/extensions`; implementation is still future work.
- Process/lifecycle state lives under `project/tasks/` and `project/bugs/`; directory location is status.

## Runtime Prerequisites

- The pi-agent binary must be available as `pi` on `PATH`. This is a hard
  project precondition for Phase 2 and later work.
- If `pi` is not available at any point, stop the current work and escalate;
  do not implement substitutes, mocks, or alternate process runners as a way
  around the missing prerequisite.

## Local Verification

From the Rust workspace:

```bash
cd the-intern/service
cargo fmt --all -- --check
cargo build -p bob
cargo test --workspace
```

Some tests bind Unix domain sockets. In restricted sandboxes they may fail with
`Operation not permitted`; run them in a normal local development shell.

Useful focused checks:

```bash
cd the-intern/service
cargo test --test shell_e2e -- --nocapture
cargo test --test queue_load
cargo test --test session_state_roundtrip
```

`cargo clippy --workspace -- -D warnings` is not yet a passing project gate;
there is existing lint/documentation debt in the `bob` crate.
