---
name: bob-setup
description: Set up, build, or install bob (the-intern's Rust admin service) and its pi-agent extension. Use whenever the user wants to build bob from source, start a local dev instance, install the bob.ts extension, check prerequisites, or configure bob via config.toml/env vars for the first time. Also use if a build or startup fails on a missing prerequisite (rust toolchain, pi binary, extension file).
---

# bob-setup

Bootstrapping bob from a clean checkout of `aurora-firmware/the-intern`.

## 1. Hard prerequisite: `pi` on PATH

Bob's pi-agent supervisor refuses to do anything useful without a real `pi`
binary. This is a project-wide hard rule, not a suggestion:

```bash
which pi
```

If `pi` is missing: **stop and escalate to the user — do not substitute a
mock, a stub, or an alternate process runner.** This applies even in a
sandboxed/CI environment. See the root `CLAUDE.md` / `README.md`
"Runtime prerequisites" sections for the same rule.

Version compatibility is pinned, not aspirational — check the root
`README.md` "pi-agent Version Compatibility" section for the exact
supported versions before assuming a mismatch is your bug:
- Extension API (`@earendil-works/pi-coding-agent`): tested against
  **0.75.3** only — `npm test` in `the-intern/extensions` fails loudly with
  the exact fix command if the installed version differs.
- Interactive `pi` binary (used by `bob chat`): last verified against
  **0.79.10**.

## 2. Rust toolchain

Pinned via `the-intern/service/rust-toolchain.toml` (stable channel,
`rustfmt` + `clippy` components). `rustup` installs it automatically on
first build — no manual step needed.

## 3. Build

Always run cargo commands from `the-intern/service/`:

```bash
cd the-intern/service
cargo build -p bob            # target/debug/bob
cargo build -p bob --release  # target/release/bob
```

There is no `cargo install` step. Either run via `cargo run -p bob -- <args>`,
or add the `target/debug` or `target/release` dir to `PATH`.

## 4. Install the pi-agent extension

The extension (`the-intern/extensions/bob.ts`) is separate from the `bob`
binary and must be installed where `bob serve` expects it, or **bob will
refuse to spawn any `pi` process at all** ("pi extension file does not
exist at expected path '<resolved_path>'").

Default resolved path (XDG data dir):
- Linux: `~/.local/share/bob/extensions/bob.ts` (or `$XDG_DATA_HOME/bob/extensions/bob.ts`)
- macOS: `~/Library/Application Support/bob/extensions/bob.ts`

Copy `the-intern/extensions/bob.ts` there, or override the path with
`extension_path` in `config.toml` or the `BOB_EXTENSION_PATH` env var.

**Common install mistake**: if pi's own `~/.pi/agent/settings.json`
`packages` list *also* references an older, separately-installed copy of
`bob.ts`, pi will load two extension instances in one session. Never add
`bob.ts` to that `packages` list yourself — bob does not manage that file,
and the duplicate-connection failure mode looks like a policy/authz bug,
not an install bug (see `bob-troubleshooting`).

## 5. Config file (optional)

Location: `$XDG_CONFIG_HOME/bob/config.toml` (fallback
`~/.config/bob/config.toml`) on Linux, `~/Library/Application
Support/bob/config.toml` on macOS. Not required — bob runs on defaults.
Notable keys: `extension_path`, `pi_agent_cwd` (must be absolute),
`schedule_store_path`, `shutdown_drain_deadline`/`shutdown_reap_deadline`,
`[policy]`, `[monitoring]`.

One landmine: a `[[schedule]]` table in `config.toml` is parsed but
**silently ignored** — `schedules.json` (managed via `bob schedule`) is the
only authoritative schedule source. Don't debug a "schedule not firing"
issue by editing `config.toml`.

Env var overrides follow the pattern `BOB_<UPPER_SNAKE_FIELD_NAME>` (any
`BobConfig` field). Confirmed in active use:

| Env var | Purpose |
|---|---|
| `BOB_ADMIN_SOCK_PATH` | Path to `admin.sock` |
| `BOB_EXTENSION_SOCK_PATH` | Path to `extension.sock` |
| `BOB_EXTENSION_PATH` | Override resolved `bob.ts` path |
| `BOB_SCHEDULE_STORE_PATH` | Override `schedules.json` path |
| `BOB_PI_AGENT_MAX_PROCESSES` / `BOB_PI_AGENT_WARM_POOL_SIZE` | Supervisor pool sizing |
| `BOB_TRACING_LEVEL` (or `RUST_LOG`) | Log verbosity |

## 6. Local dev loop (preferred over hand-rolling env vars)

Two terminals, using the repo's own helper scripts — they derive matching
socket paths for you so client and server never disagree:

```bash
# Terminal A — starts bob serve under .tmp/bob-dev
./scripts/run-bob-dev.sh

# Terminal B — run bob commands against that instance
./scripts/bob-dev.sh status
./scripts/bob-dev.sh sessions list --json
```

`bob-dev.sh` checks `pi` is on PATH itself (`error: pi must be available on
PATH` if not) and sets `XDG_CONFIG_HOME`/`XDG_DATA_HOME`/`XDG_STATE_HOME`/
`XDG_RUNTIME_DIR` under `.tmp/bob-dev/`, so state from a dev run never
pollutes your real `~/.config`/`~/.local` dirs. Stop the server with
`SIGTERM`/`Ctrl-C` (see `bob-troubleshooting` if you ever kill it with
`SIGKILL` instead — it leaves stale socket files behind).

If you need to run `bob serve` manually instead of via the scripts (e.g. to
point at a specific runtime dir):

```bash
export BOB_TEST_RUNTIME_DIR="$(mktemp -d)"
BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock" \
BOB_EXTENSION_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/extension.sock" \
cargo run -p bob -- serve
```

Then, in another shell, reuse the same `$BOB_TEST_RUNTIME_DIR` value when
setting `BOB_ADMIN_SOCK_PATH` for client commands — a path mismatch here is
the single most common "bob isn't running" false alarm (see
`bob-troubleshooting`).

## 7. Sandbox caveat

Some tests (and `bob chat`/admin-rpc itself) rely on Unix domain sockets
and `SO_PEERCRED`/peer-credential reads. Under a restrictive sandbox these
can fail with `Operation not permitted` even though nothing is actually
broken — run in a normal local shell, not a locked-down CI sandbox, when
diagnosing this.
