---
id: T-079
title: Write operator and deployer guide content
status: pending
priority: medium
assigned-role: developer
created: '2026-05-25'
spec: S-007
---

# Write operator and deployer guide content

## Description

Replace the stub created by T-077 for the Operator & Deployer Guide chapter
with content for the audience that installs, configures, runs, and observes
`bob` in a real environment.

Topics the chapter must cover, each as its own section:
- **Prerequisites** — Rust toolchain (pinned via `rust-toolchain.toml`) and
  the `pi` binary on `PATH` as a hard precondition; how to verify and what
  to do if it is missing.
- **Build and install** — building `bob` from the workspace; where the
  binary lands.
- **Runtime layout** — `BOB_TEST_RUNTIME_DIR`, admin and extension sockets,
  default paths and how to override them with `BOB_ADMIN_SOCK_PATH` /
  `BOB_EXTENSION_SOCK_PATH`.
- **Channel configuration** — the `[channels.chat]` config section and
  enabling/disabling channels.
- **Audit log** — what the JSONL log captures, where it lives, how to tail
  it via `bob audit`.
- **Policy basics** — what pre-flight admission and the blocking
  `tool_call` authorization gate do operationally (link to the
  architecture chapter for the conceptual picture).
- **Shutdown** — how SIGTERM drives the supervisor's shutdown phases and
  socket cleanup.

This chapter focuses on operational behaviour. Architectural rationale
belongs in the Architecture Overview chapter; CLI flag exhaustiveness
belongs in the CLI Reference part.

## Acceptance Criteria

AC-1: The system shall provide a populated Operator & Deployer Guide
chapter at `the-intern/docs/src/operator-guide.md` whose rendered HTML
contains a section for each topic listed in the Description.

AC-2: The system shall state the `pi`-on-`PATH` precondition explicitly,
including how to verify it and an instruction to stop and escalate rather
than substitute a mock when it is missing.

AC-3: WHEN `mdbook build` runs from `the-intern/docs/`, THE SYSTEM SHALL
produce the Operator & Deployer Guide chapter without warnings or broken
internal links.

AC-4: IF the chapter discusses policy or architectural rationale beyond
operational behaviour, THEN THE SYSTEM SHALL link to the Architecture
Overview chapter rather than restating that material.

## Dependencies

- `T-077` — provides the mdBook scaffold and the stub file this task
  replaces.

## Files to Touch

- `the-intern/docs/src/operator-guide/index.md` — replace stub created
  by T-077 with full content.

## Verification

```bash
cd the-intern/docs && mdbook build
test -s src/operator-guide/index.md
grep -rq "BOB_ADMIN_SOCK_PATH" book/
grep -rq "pi binary" book/
```

## Work Log

### Session 1 — 2026-05-26

Wrote the full Operator & Deployer Guide for
`the-intern/docs/src/operator-guide/index.md`, replacing the T-077 stub.

**Sources consulted:** `README.md`, `the-intern/service/README.md`,
`crates/bob/src/config.rs` (env var names, default paths, monitoring
config), `crates/bob/src/serve.rs` (shutdown phase sequence and logic),
`project/specs/bob-service-shell-architecture.md`,
`project/specs/monitoring-audit-log-and-external-action-reporting.md`,
`project/specs/policy-control-pre-flight-admission-and-the-blocking-tool-call-authorization-path.md`,
`project/decisions/ADR-002-bob-configuration-format-toml-via-figment.md`.

**Decisions:**
- Default socket paths described per-platform (Linux XDG, macOS
  `$TMPDIR`) directly from `config.rs::resolve_runtime_root`.
- Default audit log paths described per-platform from
  `config.rs::default_monitoring_audit_log_path_for_env`.
- The six-phase shutdown sequence is taken verbatim from
  `serve.rs::run_shutdown_protocol`, not paraphrased from the spec.
- Policy basics stay operational (configure + reload) and link to the
  Architecture Overview for rationale (AC-4).
- `BOB_TEST_RUNTIME_DIR` is covered in Runtime Layout as the idiomatic
  isolation pattern.
- The ADR-002 link uses a relative path from the docs source root;
  the ADR lives outside the docs source tree and mdBook does not flag
  it as a broken internal link.

Nothing remains. All ACs are met and verification commands pass.

### Session 2 — 2026-05-26

Two factual corrections applied to
`the-intern/docs/src/operator-guide/index.md` in response to the
cycle-1 Reviewer findings.

**Shutdown phase 4 order (Issue 1).** Reading
`crates/pi-agent-supervisor/src/pool.rs::shutdown_all` showed
`active_workers.drain()` runs before `warm_workers.pop()` in a loop.
Updated the description to: "active session workers first, then warm
(idle) workers, then sends forced kills to any that have not exited
within their individual termination deadline." The phrase "individual
termination deadline" reflects the per-worker
`child_termination_deadline` that `RpcWorkerProcess::terminate()` uses
internally.

**macOS audit log path (Issue 2).** Reading
`crates/bob/src/config.rs::default_monitoring_audit_log_path_for_env`
confirmed `XDG_STATE_HOME` is checked first on macOS before
`~/Library/Application Support`. Updated the macOS entry to mirror the
Linux pattern: `$XDG_STATE_HOME/bob/audit.jsonl` (falls back to
`~/Library/Application Support/bob/audit.jsonl`).

All four verification commands still pass. Changes committed as
`docs(operator-guide): fix shutdown order and macos audit log path`.

## Review

### Review Verdict — 2026-05-26

FAIL

**Stage 1 — AC checks**

All four acceptance criteria are met:

- AC-1: Rendered HTML contains all seven required section headings (Prerequisites, Build and install, Runtime layout, Channel configuration, Audit log, Policy basics, Shutdown). PASS.
- AC-2: `pi`-on-PATH precondition is stated explicitly with `which pi` verification step and a clear stop-and-escalate instruction. PASS.
- AC-3: `mdbook build` from `the-intern/docs/` produces no broken internal links; the only warning is a pre-existing mdbook-mermaid version mismatch unrelated to this task. PASS.
- AC-4: Policy basics section links to the Architecture Overview chapter rather than restating rationale. PASS.

Scope check: only `src/operator-guide/index.md` was modified on the branch (plus the task file). PASS.

Verification commands: all four passed on the task branch (`mdbook build`, `test -s`, `grep BOB_ADMIN_SOCK_PATH`, `grep "pi binary"`). PASS.

**Stage 2 — Content correctness issues**

Two factual errors were found by cross-checking the guide text against `crates/pi-agent-supervisor/src/pool.rs` and `crates/bob/src/config.rs`.

---

**Issue 1 — Shutdown phase 4: worker termination order is inverted**

- **File and location:** `the-intern/docs/src/operator-guide/index.md`, Shutdown section, phase 4 description.
- **What is wrong:** The guide states "The supervisor terminates idle workers first, then active workers, then sends forced kills to any that have not exited." The code in `pool.rs::shutdown_all` does the opposite: it iterates `self.active_workers.drain()` first, then pops from `self.warm_workers`. Active (busy session) workers are terminated before warm/idle workers.
- **What should change:** Correct the order to: "The supervisor terminates active session workers first, then warm (idle) workers, then sends forced kills to any that have not exited within their individual termination deadline."

---

**Issue 2 — macOS default audit log path omits XDG_STATE_HOME precedence**

- **File and location:** `the-intern/docs/src/operator-guide/index.md`, Audit log → Where the log lives section, macOS path entry.
- **What is wrong:** The guide describes the macOS default as `~/Library/Application Support/bob/audit.jsonl` with no qualification. The code in `config.rs::default_monitoring_audit_log_path_for_env` checks `XDG_STATE_HOME` first on macOS (same as Linux) before falling back to `~/Library/Application Support`. An operator with `XDG_STATE_HOME` set on macOS will find their log at a different path than documented.
- **What should change:** Update the macOS entry to match the Linux pattern: `$XDG_STATE_HOME/bob/audit.jsonl` (falls back to `~/Library/Application Support/bob/audit.jsonl`). This mirrors how the Linux entry is already described.
