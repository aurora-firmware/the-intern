# PR Review: aurora-firmware/the-intern#24 - Promote dev-agent -> main: B-009 extension.sock permission gate + integrated S-008/S-009/B-010/B-011 work

## Summary

PR #24 promotes the current `dev-agent` integration branch to `main`, with the reviewed GitHub diff focused on B-009 lifecycle artifacts, a progress report, and the Rust extension socket permission-gate fix. The review found two warning-level issues in the Rust changes: one security-relevant startup regression where extension socket bind failures are swallowed, and one shutdown regression where accepted extension connections remain detached. No documentation findings were identified.

| Scope | Files | Lines changed | Tier | Findings |
|---|---:|---:|---|---:|
| documentation | 4 | 670 | full | 0 |
| source | 2 | 191 | full | 1 |
| security | 4 | 658 | full | 1 |

## Findings

### Security

#### [warning] Extension socket bind failures no longer abort startup - `the-intern/service/crates/extension-ipc/src/lib.rs:244`

`bob::start_subsystems` now relies on `extension_ipc::start()` to bind `cfg.extension_sock_path`, but `extension_ipc::start()` logs `Listener::bind` failures and returns `None`, allowing the service to continue without owning the configured extension socket. That regresses the documented `serve` contract that either socket bind failure returns `ServiceError::ServiceDown`, and it is security-sensitive because the same path is still passed to pi-agent workers as `BOB_EXTENSION_SOCK_PATH`. If the configured path cannot be bound because another local user controls the parent/path, bob can report healthy while workers still try to use a socket bob did not create. Treat a non-empty extension socket bind failure as a startup failure, or otherwise avoid launching workers with that path unless bob successfully owns the listener.

### Source

#### [warning] Accepted extension connections outlive shutdown - `the-intern/service/crates/extension-ipc/src/lib.rs:209`

The new listener shutdown signal stops `run_listener`, but each accepted connection is still spawned with `tokio::spawn(run_connection(...))` and is neither signaled nor joined. Once `bob serve` starts the extension listener on the production path, an idle connected extension peer can keep cloned subsystem handles alive, including the `MonitoringBackedHandle` and policy snapshot held by `run_connection`. During `run_shutdown_protocol`, bob drops the main handles and then awaits the non-supervisor joins; these detached connection tasks can keep actor channels open and force shutdown to wait until `shutdown_drain_deadline` rather than draining promptly. Track accepted connection tasks and close/join or abort them during extension-ipc shutdown.

## Skipped files

None. No lock files, vendored files, generated files, minified assets, source maps, or binary-only files were present in the GitHub PR file payload.

## Review notes

Reviewed PR metadata and file patches with `gh pr view`, `gh api repos/aurora-firmware/the-intern/pulls/24/files --paginate`, and existing review comments with `gh api repos/aurora-firmware/the-intern/pulls/24/comments --paginate` (none returned). The GitHub PR file payload contained 6 changed files and 861 changed lines; that payload was treated as authoritative because local `main...dev-agent` includes older accumulated branch differences not present in the GitHub PR diff.

Documentation, source, and security scopes were all full tier. Source and security review read surrounding code at the PR head, including `bob/src/serve.rs`, `extension-ipc/src/lib.rs`, `extension-ipc/src/listener.rs`, `extension-ipc/src/multiplex.rs`, `monitoring/src/lib.rs`, and `bob/src/config.rs`. Three scoped subagents reviewed documentation, source, and security in parallel; their findings were deduplicated and recategorized, with the bind-failure issue kept under security and the detached-connection shutdown issue kept under source.

No tests were run as part of this review; the PR body reports `cargo test --workspace` and `cargo fmt --all -- --check` as passing.
