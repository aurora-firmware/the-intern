# Quickstart

This page gets you to a working `bob chat` session using the **released
binary** — no Rust toolchain and no source build required. It links out to
the [Operator & Deployer Guide](../operator-guide/index.md) and the
[End-User Guide](../end-user-guide/index.md) for anything more detailed than
"make it run." Released install bundles are available for `linux-x86_64` and
`macos-arm64`. If you'd rather build from source, see
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

## 2. Download the install bundle

From the [latest release](https://github.com/aurora-firmware/the-intern/releases/latest),
download the install bundle that matches your platform:

- `the-intern-bob-install-<tag>-linux-x86_64.zip`
- `the-intern-bob-install-<tag>-macos-arm64.zip`

Replace `<tag>` with the release tag shown on the releases page (for example
`0.5.0`), then unzip the archive:

```bash
unzip the-intern-bob-install-<tag>-<platform>.zip
```

Released install bundles are published for `linux-x86_64` and `macos-arm64`.

---

## 3. Run the installer

Change into the unzipped directory and run the bundled installer:

```bash
cd the-intern-bob-install-<tag>-<platform>
./install.sh
```

`install.sh` installs `bob` and `bob.ts` into their default user-local
locations without `sudo`. Confirm the binary runs:

```bash
bob status --help
```

`bob` hands every `pi` process its extension via `pi --extension <path>`, and
the install bundle puts `bob.ts` at the default path that runtime lookup
expects. If you are building from source instead of using a release bundle, see
[Install the bob extension](../operator-guide/index.md#install-the-bob-extension).

---

## 4. Initialize a workspace

Pick the owner-only workspace directory you want bob sessions or scheduled jobs
to run in, then initialize it:

```bash
WORKSPACE="$HOME/workspaces/email-triage"
bob init "$WORKSPACE"
```

`bob init` creates the workspace files bob expects locally:

- `AGENTS.md`
- `CLAUDE.md`
- `config/email-triage.toml`
- `worklog/`
- `tasks/` (empty task board directory)

It also writes bob's live config file at the platform default location
(`$XDG_CONFIG_HOME/bob/config.toml` on Linux, `~/Library/Application Support/bob/config.toml`
on macOS) and installs the shared `himalaya`, `email-triage`, `worklog`, and
`tasks` skills once at bob's shared data path. It does **not** create a
workspace `.pi/skills` copy.

Before you serve or schedule that workspace, set the required manager escalation
address in the generated skill-local config:

```toml
# $WORKSPACE/config/email-triage.toml
manager_address = "manager@example.com"
```

`bob init` also generates a permissive bootstrap policy. It allows any
arguments for `bash`, `read`, `write`, and `edit`, keeps every other tool
default-denied, and is intended only as a starting point. Review and narrow the
generated `config.toml` before relying on it as a security control.

---

## 5. Start the service

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

## 6. Have your first chat

```bash
bob chat
```

This asks the running service to start a supervised, interactive `pi`
session and attaches it to your terminal. Type normally; when you exit pi,
`bob chat` exits too. If it instead prints `bob service is not running —
cannot reach admin socket at <path>`, the service isn't up or
`BOB_ADMIN_SOCK_PATH` doesn't match between the two shells — recheck step 5.

Stop the service itself with `Ctrl-C` (`SIGTERM`) in the terminal running
`bob serve`.

---

## Review the generated config

`bob init` writes a live `config.toml` for you, so the first-run task is to
edit what it generated rather than start from a blank file.

- Keep `skill_install_path` unless you intentionally want the shared skills
  somewhere else.
- Set `pi_agent_cwd` if you want every non-interactive session to start in a
  predictable directory.
- Replace the bootstrap-wide `bash`/`read`/`write`/`edit` rules with the
  narrower rules your deployment actually needs.

After editing the file, apply it without restarting the service:

```bash
bob policy reload
```

See [Policy basics](../operator-guide/index.md#policy-basics), [Working
directory for pi-agent
sessions](../operator-guide/index.md#working-directory-for-pi-agent-sessions),
and [Deploying the `email-triage` scheduled
job](../operator-guide/index.md#deploying-the-email-triage-scheduled-job) for
the full model.

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
