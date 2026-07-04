# CLAUDE.md

This file provides Claude with the commands and conventions it needs to work in
this repository (AGENTS.md is a symlink to it).

## Build and Install

Toolchains are managed with mise (`mise.toml`: gh, node, python 3.14, rust).
The Rust service workspace lives in `the-intern/service/` — run all cargo
commands from there.

```bash
cargo build -p bob
```

## Test

Run the full Rust workspace test suite from `the-intern/service/`:

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

Some tests use Unix domain sockets and peer credentials. In a restricted
sandbox they may fail with `Operation not permitted`; run them in a normal
local development shell.

CI (`.github/workflows/build.yml`, self-hosted runners) runs on pull requests
and pushes to `dev-agent`/`main`: `format` (`cargo fmt --check`), `build`
(`cargo build -p bob`), `documentation` (`cargo doc`), `user-docs` (mdBook
build of `the-intern/docs`), and `tests` (`cargo test --workspace`).
`deploy.yml` runs on tag pushes and attaches the release `bob` binary and the
mdBook docs to the GitHub Release.

## Run

For local development, the helper scripts keep all bob config, state, data, and
sockets under `.tmp/bob-dev` and run Cargo from `the-intern/service/`:

```bash
# Terminal A — start the service
./scripts/run-bob-dev.sh

# Terminal B — run bob commands against that service
./scripts/bob-dev.sh status
./scripts/bob-dev.sh sessions list --json
```

The helper requires the real `pi` binary on `PATH`.

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

## Lint and Format

```bash
cargo fmt --all -- --check
```

`cargo clippy --workspace -- -D warnings` is useful for auditing, but it is
not yet a clean gate for this workspace — the `bob` crate still has existing
pedantic/doc/style lint debt.

## Key Conventions

### What this repository is

Two things live here, and they must not be confused:

1. **The product being designed — "the Intern".** A logical architecture for an
   intelligent office-assistant agent, with architecture in
   `project/docs/system_overview.md` and
   `project/docs/the-intern-architecture.md`, and current Rust service code in
   `the-intern/service/`.
2. **The AI-team process that builds it.** Role definitions in
   `.claude/agents/` (mirrored in `.codex/agents/`) and the slash-skills in
   `.claude/skills/`, backed by the `ai-team` CLI.

### Folder structure

```
.
├── CLAUDE.md                    # This file (AGENTS.md is a symlink to it)
├── README.md
├── .ai-team.toml                # Framework config (project.dir, version)
├── .github/
│   └── workflows/
│       ├── build.yml            # CI: format, build, rust-docs, user-docs, tests (PRs + pushes to dev-agent/main)
│       ├── deploy.yml           # Release: build release binary + mdBook docs, attach both to GitHub Release (tag pushes)
│       └── test_deploy_workflow.py  # Static checks over deploy.yml (T-083 acceptance tests)
├── ai-process-cli-reported-issues.md  # Running log of ai-team CLI / skill bugs
├── .claude/
│   ├── agents/                  # Role definitions: planner, architect, developer, reviewer, integrator
│   └── skills/                  # Slash-skills backing the workflow (brainstorm, spec-breakdown,
│                                #   spec-breakdown-review, dev-loop, bug-loop, tdd, code-review,
│                                #   integrate, debug, escalation-review, git-conventions,
│                                #   merge-conflicts, new-{task,bug,spec,adr}, status-report)
├── .codex/
│   └── agents/                  # Mirror role definitions for the codex toolchain (*.toml)
├── the-intern/
│   ├── docs/                    # User manual (mdBook source; shipped with releases)
│   ├── extensions/              # JS extension for pi-agent (`bob.ts`)
│   └── service/                 # Rust service workspace (`bob` and subsystem crates)
└── project/                     # Source of truth for product lifecycle state
    ├── docs/                    # Product design (system_overview.md, the-intern-architecture.md)
    │                            # Coding guidance lives here too; archive/ holds retired docs
    ├── specs/                   # Approved specifications (input to spec-breakdown)
    ├── decisions/               # ADRs
    ├── reports/                 # Generated status and gate reports
    ├── tasks/{pending,in-progress,completed,blocked}/
    └── bugs/{open,in-progress,resolved}/
```

Directory *is* the status for tasks and bugs — moving a file is how state transitions.

### Runtime prerequisites

- The pi-agent binary must be available as `pi` on `PATH`. This is a hard
  project precondition for Phase 2 and later work.
- If `pi` is not available at any point, stop the current work and escalate;
  do not implement substitutes, mocks, or alternate process runners as a way
  around the missing prerequisite.
- `README.md` is the canonical record of the currently used/tested pi-agent
  versions (no backwards compatibility guaranteed). Whenever the pi-agent
  version in use changes, update the README's compatibility section — specs
  and ADRs must not pin pi-agent versions.

### Git model (authoritative: `git-conventions` skill)

| Branch | Who touches it |
|---|---|
| `main` | Human only — no automated role ever commits here |
| `dev-agent` | Integration target + canonical lifecycle state; non-Developer roles & loops commit docs/specs/task files here (never source code) |
| `task/T-NNN-...` / `bug/B-NNN-...` | Developer only; source, tests, artifacts |

Commit format: `<type>(<component>): <description>` — type ∈ `feat|fix|test|docs|chore`,
imperative, lowercase, no period, ≤72 chars. Do not repeat the task/bug ID (the branch carries it).

Hard rules: no `--no-verify`, no `--force` on `dev-agent`/`main`, no amending pushed commits.

### Working in this repo

- When asked to do product work, route it through the framework (spec → tasks → loop), don't
  free-hand implementation against `project/docs/`.
- Editing process itself (agents/skills) is direct repo work — but keep agent and skill
  definitions internally consistent (each agent's `skills:` frontmatter must match real skills).
- Keep the `.claude/` and `.codex/` agent definitions in sync when changing roles.

### Pointers

- Coding guidelines: `project/docs/coding-guidelines-node.md`, `project/docs/coding-guidelines-rust.md`
- Local Rust verification details: `the-intern/service/README.md`
