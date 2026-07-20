# Passing a system prompt to pi-agent through bob

How bob launches `pi`, the ways to give it a system prompt, and the working
directories that matter. Verified against the current source and `pi --help`.

This doc covers the **launch-cwd fallback** — the directory `pi` gets when
neither the service-wide `pi_agent_cwd` config key nor (for scheduled jobs) a
per-entry `--cwd` is set. When either is set, it takes precedence over
everything described here; see the [operator guide's "Working directory for
pi-agent sessions"](the-intern/docs/src/operator-guide/index.md) section for
the full precedence chain (per-entry `cwd` → `pi_agent_cwd` → inherited
launch cwd).

## How bob launches pi

bob spawns every RPC worker as:

```
pi <pi_agent_args…> --extension <bob.ts>
```

- `pi_agent_args` (config key, default `["--mode", "rpc"]`) is passed through to
  `pi` **verbatim**.
- bob appends `--extension <bob.ts>` itself and sets env `BOB_SESSION_ID` and
  `BOB_EXTENSION_SOCK_PATH`.
- When `pi_agent_cwd` is unset, bob sets no working directory, so `pi`
  inherits bob's cwd. When `pi_agent_cwd` **is** set, bob passes it as the
  worker's `current_dir` instead (see [Working directories](#working-directories)).
- `bob.ts` only forwards telemetry and gates tool calls — it does **not** touch
  prompts, so it is not a system-prompt mechanism.

`pi` itself supports the system prompt (from `pi --help`):

```
--system-prompt <text>          System prompt (default: coding assistant prompt)
--append-system-prompt <text>   Append text OR file contents to the system prompt (repeatable)
--no-context-files, -nc         Disable AGENTS.md and CLAUDE.md discovery and loading
```

## Ways to pass a system prompt

### 1. `--append-system-prompt` via `pi_agent_args` (recommended)

Appends to pi's default prompt. The value may be literal text **or a file path**
(pi reads the file's contents), and the flag can be repeated. Keep the prompt in
a file and point at it:

```toml
# .tmp/bob-dev/config/bob/config.toml
pi_agent_args = ["--mode", "rpc", "--append-system-prompt", "/abs/path/to/system.md"]
```

Effective launch: `pi --mode rpc --append-system-prompt /abs/path/to/system.md --extension …/bob.ts`

### 2. `--system-prompt` via `pi_agent_args` (replace the default)

```toml
pi_agent_args = ["--mode", "rpc", "--system-prompt", "You are Bob's back-office assistant. Be terse."]
```

Replaces pi's built-in coding-assistant prompt rather than appending to it.

### 3. `AGENTS.md` / `CLAUDE.md` auto-discovery

`pi` auto-discovers `AGENTS.md` and `CLAUDE.md` (unless `-nc` /
`--no-context-files`) starting from **its working directory** — which is bob's
cwd (see below). Useful but constrained by cwd:

- A file under `.tmp/bob-dev/…` is **not** discovered — that is not pi's cwd.
- In the dev setup pi's cwd is `the-intern/service`, whose `AGENTS.md` is a
  symlink to the repo's `CLAUDE.md`, so **pi is already loading this project's
  CLAUDE.md as context.** Add `-nc` to `pi_agent_args` to stop that.
- To make pi discover *your* `AGENTS.md`, bob's cwd must be your workspace —
  i.e. launch `bob serve` from that directory (see below).

**Rules for all of the above**
- Always keep `--mode rpc` in `pi_agent_args` — bob's supervisor speaks pi's RPC
  protocol; without it the worker breaks.
- These apply to the **RPC worker pool** (scheduled jobs + async work), **not**
  to `bob chat` interactive sessions, which are spawned with empty args
  (`build_interactive_session_config` → `args: Vec::new()`). Sharing a prompt
  with chat needs a small bob change.

## Working directories

When `pi_agent_cwd` (and, for a scheduled entry, its per-entry `cwd`) is
unset, bob sets no cwd for pi, so pi inherits whatever cwd the `bob serve`
process has. That cwd is decided by how you launch bob. If `pi_agent_cwd` or
a per-entry `cwd` **is** set, it is passed as the worker's `current_dir`
instead and this fallback never applies — see the operator guide's
precedence chain.

| Process | Working directory (dev helper scripts, no `pi_agent_cwd`/`--cwd` set) | Why |
|---|---|---|
| `bob serve` (the service) | `the-intern/service` | `scripts/bob-dev.sh` runs `cd "$service_dir"` before `cargo run` |
| `pi` workers | `the-intern/service` | inherited from `bob serve` (bob sets no `current_dir` when `pi_agent_cwd` is unset) |
| `bob <cmd>` (the CLI call) | `the-intern/service` | same script `cd`s to `service_dir` before `cargo run` |

**Gotcha — relative paths on the CLI.** Because `scripts/bob-dev.sh` `cd`s to
`the-intern/service` before running the command, a relative path you pass (e.g.
`schedule add --file ./prompt.txt`) resolves against `the-intern/service`, **not
your terminal's pwd**. Use absolute paths with the dev script.

**Controlling pi's cwd.** To give pi a different cwd (e.g. so it discovers your
own `AGENTS.md`), run the built binary from that directory instead of the
cwd-pinning script:

```bash
cd the-intern/service && cargo build -p bob
cd /path/to/your/workspace           # put your AGENTS.md here
XDG_STATE_HOME=…/.tmp/bob-dev/state \
BOB_ADMIN_SOCK_PATH=…/.tmp/bob-dev/run/admin.sock \
BOB_EXTENSION_SOCK_PATH=…/.tmp/bob-dev/run/extension.sock \
BOB_EXTENSION_PATH=…/the-intern/extensions/bob.ts \
…/the-intern/service/target/debug/bob serve
```

pi's cwd is then `/path/to/your/workspace`, and its `AGENTS.md`/`CLAUDE.md`
discovery starts there.

### Scheduled runs

A scheduled firing's cwd is resolved by the periodic dispatcher using the
precedence chain documented in the operator guide's ["Working directory for
pi-agent sessions"](the-intern/docs/src/operator-guide/index.md#working-directory-for-pi-agent-sessions)
section: **per-entry `cwd`** (`--cwd` on `bob schedule add`), then
**service-wide `pi_agent_cwd`**, then the **inherited launch cwd** of `bob
serve` as the final fallback. Only in that last, no-config-set case is a
scheduled run's cwd exactly `bob serve`'s cwd — `the-intern/service` under the
dev scripts, since neither the scheduler-adapter nor the dispatcher change it
on their own.

Consequences for a scheduled job:

- The stored prompt path is **absolute** (the `--file` option enforces this), so
  it resolves regardless of cwd.
- But if the **prompt text** tells pi to read/write a **relative** path, pi
  resolves it against whichever cwd the precedence chain above resolved for
  that entry — `the-intern/service` only if neither `--cwd` nor `pi_agent_cwd`
  is set. Use absolute paths inside the prompt, or set `--cwd`/`pi_agent_cwd`
  (or point bob's own cwd at your workspace, the built-binary launch above) if
  you want relative paths to land somewhere specific.

## Recommendation

Use **`--append-system-prompt <file>`** in `pi_agent_args`: file-based (matches
how you already keep prompt files), bob-supported passthrough, and independent
of the cwd quirks. Reach for the `AGENTS.md` route only if you also want pi's
normal project-context discovery, and remember it keys off pi's cwd.
