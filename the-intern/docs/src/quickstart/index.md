# Quickstart

This page gets you to a working `bob chat` session using the **released
binary** — no Rust toolchain and no source build required. It links out to
the [Operator & Deployer Guide](../operator-guide/index.md) and the
[End-User Guide](../end-user-guide/index.md) for anything more detailed than
"make it run." If you'd rather build from source (for example, to run on a
platform other than Linux x86_64), see
[Build and install](../operator-guide/index.md#build-and-install) in the
Operator & Deployer Guide instead.

Repository: [aurora-firmware/the-intern](https://github.com/aurora-firmware/the-intern)
· Releases: [aurora-firmware/the-intern/releases](https://github.com/aurora-firmware/the-intern/releases/latest)

---

## 1. Prerequisites

- **The `pi` binary on `PATH`.** This is a hard precondition — `bob` will not
  start without it. Install it from the official pi-agent
  [quickstart guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md)
  (project site: [pi.dev](https://pi.dev/)), then verify it resolves:

  ```bash
  which pi
  ```

  If this comes back empty, stop here and install `pi` before continuing. Do
  not substitute a mock or wrapper script. See the repository `README.md`'s
  "pi-agent Version Compatibility" section for the tested versions.

---

## 2. Download `bob`

Grab the `bob` binary from the
[latest release](https://github.com/aurora-firmware/the-intern/releases/latest)
and put it on your `PATH`:

```bash
curl -fL -o bob \
  https://github.com/aurora-firmware/the-intern/releases/latest/download/bob
chmod +x bob
sudo mv bob /usr/local/bin/bob   # or any directory already on PATH
```

The released binary is built for Linux x86_64. Confirm it runs:

```bash
bob status --help
```

---

## 3. Install the bob extension

`bob` hands every `pi` process its extension via `pi --extension
<path>` — it never relies on pi's own extension search path. Download the
extension archive from the same [release page](https://github.com/aurora-firmware/the-intern/releases/latest)
(named `the-intern-bob-extension-<version>.tar.gz`) and install `bob.ts`:

```bash
mkdir -p ~/.local/share/bob/extensions
curl -fL -o bob-extension.tar.gz \
  https://github.com/aurora-firmware/the-intern/releases/download/<version>/the-intern-bob-extension-<version>.tar.gz
tar -xzf bob-extension.tar.gz -C ~/.local/share/bob/extensions bob.ts
```

Replace `<version>` with the tag shown on the releases page (for example
`0.5.0`). (macOS default install path is
`~/Library/Application Support/bob/extensions/bob.ts` instead. Use
`extension_path` in `config.toml` or `BOB_EXTENSION_PATH` to put it
somewhere else.) Full details:
[Install the bob extension](../operator-guide/index.md#install-the-bob-extension).

---

## 4. Start the service

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
version: 0.5.0
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
# AGENTS.md/CLAUDE.md and relative prompt paths. Skills are unaffected by
# this key — see skill_install_path below.
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

- The `bob` binary, docs archive, and bob extension for every version —
  [GitHub Releases](https://github.com/aurora-firmware/the-intern/releases)
- The `pi` coding agent itself — [install guide](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/quickstart.md), [pi.dev](https://pi.dev/)
- Every subcommand with worked examples — [End-User Guide](../end-user-guide/index.md)
- Socket layout, the audit log, policy, and scheduling in depth, plus
  building from source —
  [Operator & Deployer Guide](../operator-guide/index.md)
- Why the service is shaped this way — [Architecture Overview](../architecture-overview/index.md)
- Every flag, exhaustively — [CLI Reference](../cli-reference/index.md)
