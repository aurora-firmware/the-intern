# service

This directory is the Rust service workspace for the Intern.

## Workspace Layout

- `Cargo.toml` — workspace manifest.
- `crates/bob-core` — runtime-agnostic domain types, errors, and port traits.
- `crates/bob` — the `bob` binary: `bob serve` plus admin client subcommands.
- `crates/admin-rpc` — `admin.sock` listener, socket-permission gate, JSON-RPC
  framing/dispatch, and subscriptions.
- `crates/extension-ipc` — `extension.sock` listener, framing, and session
  multiplex scaffold.
- `crates/requests-handler` — bounded internal event queue and pre-flight
  identity/access check.
- `crates/persistence` — in-memory inbound event queue and session-state store.
- `crates/policy-control` — deterministic policy engine: pre-flight admission
  and the blocking `tool_call` action gate over a reloadable ruleset snapshot.
- `crates/monitoring` — append-only JSONL audit log with `audit.tail`
  subscriptions and a `report.submit` intake.
- `crates/pi-agent-supervisor` — per-session `pi` child process lifecycle:
  spawn, warm pool, prompt routing, idle reaping, kill.
- `crates/chat-adapter` — interactive-chat channel adapter: normalizes chat
  user-input frames into `InternalEvent`s and submits them to the
  requests-handler.

## Build

```bash
cargo build -p bob
```

## Test

Run the full Rust workspace test suite:

```bash
cargo test --workspace
```

Focused subsystem checks:

```bash
cargo test -p bob serve::tests
cargo test -p admin-rpc
cargo test -p chat-adapter
cargo test --test shell_e2e -- --nocapture
cargo test --test queue_load
cargo test --test session_state_roundtrip
```

`shell_e2e` starts `bob serve`, waits for `admin.sock` and `extension.sock`,
runs `bob status` and `bob sessions list --json`, sends `SIGTERM`, and asserts
clean shutdown plus socket cleanup.

Some tests use Unix domain sockets and peer credentials. In a restricted
sandbox they may fail with `Operation not permitted`; run them in a normal
local development shell.

## Formatting and Linting

```bash
cargo fmt --all -- --check
```

`cargo clippy --workspace -- -D warnings` is useful for auditing, but it is not
yet a clean gate for this workspace. The current `bob` crate still has existing
pedantic/doc/style lint debt.

## Running `bob`

Use environment overrides to keep sockets in an isolated runtime directory:

```bash
export BOB_TEST_RUNTIME_DIR="$(mktemp -d)"
echo "$BOB_TEST_RUNTIME_DIR"
BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock" \
BOB_EXTENSION_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/extension.sock" \
cargo run -p bob -- serve
```

In another shell, set `BOB_TEST_RUNTIME_DIR` to the printed value first, then:

```bash
BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock" cargo run -p bob -- status
BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock" cargo run -p bob -- sessions list --json
```

Stop the server with `SIGTERM` or `Ctrl-C`.

## Architecture References

- [`../../project/specs/the-intern-agent-service-architecture.md`](../../project/specs/the-intern-agent-service-architecture.md)
- [`../../project/specs/bob-service-shell-architecture.md`](../../project/specs/bob-service-shell-architecture.md)
