# Quickstart

This page gets a new machine from zero to a working `bob chat` session as
fast as possible. It links out to the [Operator & Deployer
Guide](../operator-guide/index.md) and the [End-User
Guide](../end-user-guide/index.md) for anything more detailed than "make it
run."

---

## 1. Prerequisites

- **Rust (stable).** Pinned in `the-intern/service/rust-toolchain.toml`;
  `rustup` installs the right channel automatically on first build.
- **The `pi` binary on `PATH`.** This is a hard precondition — `bob` will not
  start without it. Verify with:

  ```bash
  which pi
  ```

  If this comes back empty, stop here and install/escalate for `pi` before
  continuing. Do not substitute a mock or wrapper script. See the
  repository `README.md`'s "pi-agent Version Compatibility" section for the
  tested versions.

---

## 2. Build `bob`

```bash
cd the-intern/service
cargo build -p bob
```

The binary lands at `the-intern/service/target/debug/bob`. Add that
directory to `PATH`, or prefix every command below with the full path.

---

## 3. Install the bob extension

`bob` hands every `pi` process its extension via `pi --extension
<path>` — it never relies on pi's own extension search path. Install it
once:

```bash
mkdir -p ~/.local/share/bob/extensions
cp the-intern/pi-extension/bob.ts ~/.local/share/bob/extensions/bob.ts
```

(macOS default is `~/Library/Application Support/bob/extensions/bob.ts`
instead. Use `extension_path` in `config.toml` or `BOB_EXTENSION_PATH` to
put it somewhere else.) Full details:
[Install the bob extension](../operator-guide/index.md#install-the-bob-extension).

---

## 4. Start the service

Fastest path — the repo's dev helper scripts keep sockets, config, and state
under `.tmp/bob-dev` for you:

```bash
# Terminal A
./scripts/run-bob-dev.sh
```

```bash
# Terminal B
./scripts/bob-dev.sh status
```

Prefer to run it yourself with an isolated runtime directory:

```bash
export BOB_TEST_RUNTIME_DIR="$(mktemp -d)"
echo "$BOB_TEST_RUNTIME_DIR"

BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock" \
BOB_EXTENSION_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/extension.sock" \
bob serve
```

In a second shell, point client commands at the same socket:

```bash
export BOB_ADMIN_SOCK_PATH="$BOB_TEST_RUNTIME_DIR/admin.sock"
bob status
```

Expect:

```
ok: true
version: 0.3.0
uptime_seconds: 2
```

---

## 5. Have your first chat

```bash
bob chat
```

This asks the running service to start a supervised, interactive `pi`
session and attaches it to your terminal. Type normally; when you exit pi,
`bob chat` exits too. If it instead prints `bob service is not running —
cannot reach admin socket at <path>`, the service isn't up or
`BOB_ADMIN_SOCK_PATH` doesn't match between the two shells — recheck step 4.

Stop the service itself with `Ctrl-C` (`SIGTERM`) in the terminal running
`bob serve`.

---

## Recommended starting configuration

Bob runs with sane defaults and an empty config is valid, but a fresh
install with **no policy configured denies every tool call** — `bob chat`
will connect but every action the agent tries will be blocked. For anything
beyond a bare connectivity check, create a config file at:

- Linux: `$XDG_CONFIG_HOME/bob/config.toml` (falls back to
  `~/.config/bob/config.toml`)
- macOS: `~/Library/Application Support/bob/config.toml`

A reasonable starting point for local, single-operator use:

```toml
# Run pi-agent sessions from a predictable project directory so it can find
# AGENTS.md/CLAUDE.md, skills, and relative prompt paths.
pi_agent_cwd = "/srv/workspaces/default"

[monitoring]
# Keep the default audit log path unless you need it elsewhere; narrow what
# live `bob audit tail` shows by default.
default_tail_filters = ["events", "verdicts"]

[policy]
# Interactive `bob chat` and scheduled jobs are not admission-gated, so this
# list only matters if/when other channel adapters are added.
admitted_users = []

# Allow-list the tools you actually want the agent to use. Anything not
# listed here is denied — there is no default-allow.
[[policy.action_rules]]
tool = "read_file"

[[policy.action_rules]]
tool = "bash"
```

Notes on the choices above:

- **`pi_agent_cwd` must be absolute** and is unset by default (in which case
  sessions inherit whatever directory you launched `bob serve` from). Set it
  explicitly so behavior doesn't depend on your shell history.
- **`[policy.action_rules]` is allow-only.** Start narrow (`read_file` is a
  safe first rule) and add tools as you confirm you need them, rather than
  starting broad and trying to lock down later.
- After editing the file, apply it without restarting the service:

  ```bash
  bob policy reload
  ```

See [Policy basics](../operator-guide/index.md#policy-basics) and [Working
directory for pi-agent
sessions](../operator-guide/index.md#working-directory-for-pi-agent-sessions)
for the full model.

---

## Example usage

**Check what's running:**

```bash
bob status --json
bob sessions list --json
```

**Watch the agent work in real time** (run in a third terminal while
`bob chat` is open elsewhere):

```bash
bob audit tail --filter events --filter verdicts
```

**Add a recurring prompt** instead of (or alongside) interactive chat:

```bash
bob schedule add \
  --id "morning-check" \
  --cron "0 9 * * *" \
  --prompt "Check the inbox and summarise any unread messages." \
  --cwd /srv/workspaces/default

bob schedule list
```

Scheduled jobs run on the host's local wall-clock time and fire only while
`bob serve` is up — a missed tick is skipped, not replayed on restart. See
[Scheduled jobs](../operator-guide/index.md#scheduled-jobs) for the entry
format and every field.

**End a stuck session:**

```bash
bob sessions kill <session-id>
```

---

## Where to go next

- Every subcommand with worked examples — [End-User Guide](../end-user-guide/index.md)
- Socket layout, the audit log, policy, and scheduling in depth —
  [Operator & Deployer Guide](../operator-guide/index.md)
- Why the service is shaped this way — [Architecture Overview](../architecture-overview/index.md)
- Every flag, exhaustively — [CLI Reference](../cli-reference/index.md)
