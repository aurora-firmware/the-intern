# the-intern

The Intern is an AI office-assistant project. This repository contains the
product design, the lifecycle workflow that drives the work, and the Rust
service (`bob`) that implements it.

The service currently runs through Phase 6 (chat channel). `bob serve` is a
binary with a Unix admin socket, a Unix extension socket, an in-process request
queue, in-memory persistence, graceful shutdown, and a pi-agent supervisor that
owns the lifecycle of `pi` child processes (spawn, warm pool, prompt routing,
idle reaping, kill). On top of that foundation it also runs:

- **Policy Control (Phase 4)** — deterministic pre-flight admission checks plus
  the blocking `tool_call` authorization gate.
- **Monitoring (Phase 5)** — an append-only JSONL audit log with live
  `audit.tail` subscriptions and a `report.submit` intake.
- **JS extension (Phase 3)** — `extensions/bob.ts`, which forwards pi-agent
  runtime events into `extension.sock`.
- **Interactive-chat adapter (Phase 6)** — a channel adapter that normalizes
  `chat.send` traffic into the request queue via the requests-handler.

Phase 6's chat channel is wired end to end; the remaining channel adapters
(email, webhook, scheduler) and Phase 7 (actions) are not yet implemented.

## Repository structure

```
.
├── README.md, CLAUDE.md          # This file and the framework instructions
├── .ai-team.toml                 # ai-team CLI config
├── .github/workflows/            # Placeholder CI (echo-only today)
├── .claude/                      # Role agents and slash-skills (dev-loop,
│   ├── agents/                   #   bug-loop, tdd, code-review, integrate,
│   └── skills/                   #   spec-breakdown, etc.)
├── .codex/agents/                # Mirror role definitions for codex
├── the-intern/
│   ├── service/                  # Rust workspace — the `bob` binary lives here
│   └── extensions/               # JS extension for pi-agent (bob.ts)
└── project/                      # Source of truth for product lifecycle
    ├── docs/                     # Architecture, roadmap, coding guidelines
    ├── specs/                    # Approved specifications
    ├── decisions/                # ADRs
    ├── tasks/{pending,in-progress,completed,blocked}/
    └── bugs/{open,in-progress,resolved}/
```

Directory *is* status for tasks and bugs — moving a file is how state changes.

## Prerequisites

- **Rust** — toolchain is pinned to stable via `the-intern/service/rust-toolchain.toml`
  (`rustup` will install the right channel automatically the first time you build).
- **`pi` on `PATH`** — the pi-agent binary must be available as `pi`. This is a
  hard precondition for the supervisor (Phase 2 and later). Verify with
  `which pi`. If it is missing, do not substitute a mock — stop and escalate.
- A normal local shell. Some tests bind Unix domain sockets and use peer
  credentials, which can fail under restrictive sandboxes with
  `Operation not permitted`.

## JS Extension — pi-agent Package Compatibility

The bob extension (`the-intern/extensions/bob.ts`) has been tested against
`@earendil-works/pi-coding-agent` **version 0.75.3** only. This is the only
supported pi-agent API version for the bob extension until a future task
updates the compatibility record.

If a different version of `@earendil-works/pi-coding-agent` is installed,
`npm test` in `the-intern/extensions` will fail with a clear incompatibility
error. Other installed versions are **unsupported** until both the
compatibility test (`pi-agent-compat.test.ts`) and this documentation are
updated to reflect the new tested version.

## Build

From the Rust workspace:

```bash
cd the-intern/service
cargo build -p bob
```

This produces the `bob` binary at `the-intern/service/target/debug/bob`.

## Test

The full workspace suite:

```bash
cd the-intern/service
cargo test --workspace
```

Focused subsets that exercise specific subsystems:

```bash
# Service shell + shutdown protocol (Phase 1a, Phase 2 shutdown phase 4)
cargo test -p bob serve::tests

# Admin JSON-RPC dispatch including sessions.list / sessions.kill
cargo test -p admin-rpc

# End-to-end: spawns bob serve, waits for sockets, runs CLI subcommands,
# SIGTERMs, asserts socket cleanup
cargo test -p bob --test shell_e2e -- --nocapture

# Request queue and session-state roundtrip
cargo test -p bob --test queue_load
cargo test -p bob --test session_state_roundtrip
```

Formatting check:

```bash
cargo fmt --all -- --check
```

`cargo clippy --workspace -- -D warnings` is useful for auditing but is not
yet a clean gate — the `bob` crate carries existing lint/doc debt.

## Run and use

`bob serve` listens on two Unix sockets in `$BOB_TEST_RUNTIME_DIR`
(or the default runtime dir). Override the paths to keep a session isolated.

**Terminal A — start the service:**

```bash
export BOB_TEST_RUNTIME_DIR="$(mktemp -d)"
echo "$BOB_TEST_RUNTIME_DIR"
BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock" \
BOB_EXTENSION_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/extension.sock" \
cargo run -p bob -- serve
```

**Terminal B — drive it with the admin CLI:**

```bash
export BOB_TEST_RUNTIME_DIR="<paste path from terminal A>"
export BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock"

cargo run -p bob -- status
cargo run -p bob -- sessions list --json
cargo run -p bob -- sessions kill <session-id>
```

Available subcommands: `serve`, `status`, `sessions`, `audit`, `policy`, `chat`.
Add `--help` to any of them for the full surface.

`bob chat` opens a chat subscription and sends each stdin line as a `chat.send`
call; each request includes a self-asserted application identity from
`chat_application_identity`, and the interactive-chat adapter normalizes that
identity into the request queue where the requests-handler runs pre-flight
admission. The chat channel is enabled by default and can be disabled via the
`[channels.chat]` config section.

Stop the service with Ctrl-C (SIGTERM); the supervisor reaps pi-agent
children during shutdown phase 4 and the sockets are removed on exit.

## Where to read more

- Product overview — [project/docs/system_overview.md](project/docs/system_overview.md)
- Delivery plan — [project/docs/roadmap.md](project/docs/roadmap.md)
- Approved specifications — [project/specs/the-intern-agent-service-architecture.md](project/specs/the-intern-agent-service-architecture.md), [project/specs/bob-service-shell-architecture.md](project/specs/bob-service-shell-architecture.md)
- Service-level build/test details — [the-intern/service/README.md](the-intern/service/README.md)
- Coding guidelines — [Rust](project/docs/coding-guidelines-rust.md), [Node.js](project/docs/coding-guidelines-node.md)
- Framework and slash-skill instructions — [CLAUDE.md](CLAUDE.md)

GitHub workflows in `.github/workflows/` are placeholders today (echo-only);
use the local commands above for real verification until they are wired up.
