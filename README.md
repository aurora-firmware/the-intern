# the-intern

The Intern is an AI office-assistant project. This repository contains the
product design, the lifecycle workflow that drives the work, and the Rust
service (`bob`) that implements it.

`bob serve` is a binary with a Unix admin socket, a Unix extension socket, an
in-process request queue, in-memory persistence, graceful shutdown, and a
pi-agent supervisor that owns the lifecycle of `pi` child processes (spawn,
warm pool, prompt routing, idle reaping, kill). On top of that foundation it
also runs:

- **Policy Control** — deterministic pre-flight admission checks for
  queue-borne requests plus the blocking `tool_call` authorization gate.
- **Monitoring** — an append-only JSONL audit log with live `audit.tail`
  subscriptions and a `report.submit` intake.
- **JS extension** — `pi-extension/bob.ts`, which forwards pi-agent runtime
  events into `extension.sock` and hosts the `tool_call` authorization hook.
- **Interactive chat** — `bob chat` opens a supervised, directly-launched
  interactive `pi` session on the user's terminal (ADR-010/ADR-011).
- **Scheduler** — bob-internal cron jobs persisted in
  `$XDG_STATE_HOME/bob/schedules.json` and managed with `bob schedule`
  (ADR-006/ADR-012).

The email channel adapter and the action skills (external CLI tools described
to the agent) are not yet implemented.

## Repository structure

```
.
├── README.md, CLAUDE.md          # This file and the framework instructions
├── .ai-team.toml                 # ai-team CLI config
├── .github/workflows/            # CI (format, build, docs, tests) + release workflow
├── .claude/                      # Role agents and slash-skills (dev-loop,
│   ├── agents/                   #   bug-loop, tdd, code-review, integrate,
│   └── skills/                   #   spec-breakdown, etc.)
├── .codex/agents/                # Mirror role definitions for codex
├── the-intern/
│   ├── service/                  # Rust workspace — the `bob` binary lives here
│   ├── pi-extension/             # JS extension for pi-agent (bob.ts)
│   ├── bob-companion/
│   │   └── claude/               # Claude Code plugin: skills for bob setup, CLI usage,
│   │                             #   health checks, and troubleshooting
│   └── docs/                     # User manual (mdbook source; shipped with releases)
└── project/                      # Source of truth for product lifecycle
    ├── docs/                     # Architecture and coding guidelines
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

## pi-agent Version Compatibility

This README is the canonical record of the pi-agent versions the project is
tested against. **No backwards compatibility is guaranteed** — when the
pi-agent version in use changes, update this section (specs and ADRs
deliberately do not pin pi-agent versions).

- **Extension API** — the bob extension (`the-intern/pi-extension/bob.ts`) has
  been tested against `@earendil-works/pi-coding-agent` **version 0.75.3**
  only. This is the only supported pi-agent API version for the bob extension
  until a future task updates the compatibility record.
- **Interactive `pi` binary** — the supervised interactive-chat behaviour
  (TTY requirement, raw mode) was last verified against **pi 0.79.10**
  (T-103).
- **Scheduled/periodic `pi` binary** — non-interactive `pi -p -a` invocation
  by scheduled jobs (used by the `the-intern/email-skills` package) was last
  verified against **pi 0.65.2** in a live deployment (T-139).

If a different version of `@earendil-works/pi-coding-agent` is installed,
`npm test` in `the-intern/pi-extension` will fail with a clear incompatibility
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

For source-checkout development, the repo includes helper scripts that keep bob
config, state, data, and sockets under `.tmp/bob-dev` and run Cargo from
`the-intern/service/`:

**Terminal A — start the service with the dev helper:**

```bash
./scripts/run-bob-dev.sh
```

**Terminal B — drive it with matching dev-helper environment:**

```bash
./scripts/bob-dev.sh status
./scripts/bob-dev.sh sessions list --json
```

The helper requires the real `pi` binary on `PATH`.

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

Available subcommands: `serve`, `status`, `sessions`, `audit`, `policy`,
`schedule`, `chat`. Add `--help` to any of them for the full surface.

`bob chat` requires the running service: it asks `bob serve` to launch a
supervised interactive `pi` session and hands over the caller's terminal file
descriptors (`SCM_RIGHTS` over `admin.sock`), so pi's interactive UI runs on
your real TTY while bob supervises and reaps the child. Interactive chat is
exempt from pre-flight admission (ADR-010); it is gated by socket access and
the blocking `tool_call` authorization hook, which stays fully in force.

Stop the service with Ctrl-C (SIGTERM); the supervisor reaps pi-agent
children during shutdown phase 4 and the sockets are removed on exit.

## User documentation

The user-facing manual lives in `the-intern/docs/`. It covers the end-user
guide, operator guide, extension-author guide, architecture overview, and CLI
reference. This is the first stop for anyone using or deploying the Intern.

**`the-intern/docs/` vs `project/docs/`** — `the-intern/docs/` is the user
manual and is shipped with every release. `project/docs/` holds internal
development-lifecycle material (architecture notes, coding guidelines)
and is not shipped.

### Build the docs locally

Install the required tools once:

```bash
cargo install mdbook --version 0.4.52 --locked --force
cargo install mdbook-mermaid --version 0.14.0 --locked --force
```

Then build from inside the docs directory:

```bash
cd the-intern/docs
mdbook build
```

The rendered output is written to `the-intern/docs/book/`.

**CLI reference** — the CLI reference pages are generated from the live `bob`
binary at build time. Binary discovery order (highest priority first):

1. `BOB_BIN` environment variable
2. `the-intern/service/target/release/bob`
3. `the-intern/service/target/debug/bob`

Set `BOB_BIN` to point at a specific binary if needed. The build fails loudly
when no `bob` binary is found at any of these paths.

### Pre-built docs archive

Every GitHub Release attaches a rendered documentation archive as a release
asset. You can download it without installing any tooling from the
[Releases page](https://github.com/jose-moreno/the-intern/releases).

## Where to read more

- Product overview — [project/docs/system_overview.md](project/docs/system_overview.md)
- Concrete architecture — [project/docs/the-intern-architecture.md](project/docs/the-intern-architecture.md)
- Approved specifications — [project/specs/S-001-the-intern-agent-service-architecture.md](project/specs/S-001-the-intern-agent-service-architecture.md), [project/specs/S-002-bob-service-shell-architecture.md](project/specs/S-002-bob-service-shell-architecture.md)
- Architecture decisions — [project/decisions/](project/decisions/)
- Service-level build/test details — [the-intern/service/README.md](the-intern/service/README.md)
- Coding guidelines — [Rust](project/docs/coding-guidelines-rust.md), [Node.js](project/docs/coding-guidelines-node.md)
- Framework and slash-skill instructions — [CLAUDE.md](CLAUDE.md)

CI (`.github/workflows/build.yml`) runs formatting, build, Rust docs, user
docs, and the workspace test suite on pull requests and pushes to
`dev-agent`/`main`; `deploy.yml` builds the release binary and docs archive
on tag pushes.
