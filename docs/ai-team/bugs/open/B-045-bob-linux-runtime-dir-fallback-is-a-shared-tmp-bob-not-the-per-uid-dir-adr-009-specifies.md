---
id: B-045
title: bob Linux runtime-dir fallback is a shared /tmp/bob, not the per-uid dir 
  ADR-009 specifies
severity: medium
status: open
created: '2026-09-01'
---

# bob Linux runtime-dir fallback is a shared /tmp/bob, not the per-uid dir ADR-009 specifies

## Summary

On Linux, when `XDG_RUNTIME_DIR` is unset, `bob` resolves its runtime (socket)
directory to a **shared** `/tmp/bob` for every user on the host. ADR-009 states
the fallback is "a per-uid temp directory (already implemented)", and the macOS
branch of `resolve_runtime_root` already does this (`$TMPDIR/bob-$UID`). Only
the Linux branch does not — it joins a fixed `"bob"` segment. On a multi-account
host the first user to run `bob serve` creates `/tmp/bob` mode `0700`, and a
second user's `bob serve` then cannot re-`chmod` a directory it does not own and
fails to start.

## Reproduction Status

Status: confirmed (by code inspection; behavioural repro requires a Linux host
with `XDG_RUNTIME_DIR` unset)

`resolve_runtime_root` in `the-intern/service/crates/bob/src/config.rs` has two
platform arms. The macOS arm joins `format!("bob-{}", sources.uid)`; the Linux
arm joins the literal `"bob"`. With `XDG_RUNTIME_DIR` unset the Linux runtime
root is therefore `env::temp_dir()/bob` = `/tmp/bob`, shared across uids.

## Evidence

- Logs / stack traces / failing assertions:
  - `crates/bob/src/config.rs`, `resolve_runtime_root` — Linux arm:
    `Ok((Path::new(&runtime).join("bob"), used_fallback))` where `runtime`
    falls back to `env::temp_dir()`; macOS arm:
    `Path::new(&tmpdir).join(format!("bob-{}", sources.uid))`.
  - `crates/admin-rpc/src/listener.rs`, `Listener::bind` step 1:
    `create_dir_all(parent)?; set_permissions(parent, 0o700)?;` runs on every
    start, for a pre-existing directory too — so a second uid's start fails at
    `set_permissions` with `EPERM` on a `/tmp/bob` it does not own.
- Failing command or test: `env -u XDG_RUNTIME_DIR bob status` on Linux names
  `/tmp/bob/admin.sock` (shared), not `/tmp/bob-<uid>/admin.sock`.
- Origin: surfaced by the architecture-consistency review of PR #78 / issue #60,
  which touched `resolve_runtime_root` for an unrelated diagnostic change and
  did not alter the path.

## Reproduction Steps

1. On a Linux host, as user A with `XDG_RUNTIME_DIR` unset, run `bob serve`.
   `/tmp/bob/` is created mode `0700`, owned by A.
2. As user B (also `XDG_RUNTIME_DIR` unset), run `bob serve`.
3. Startup fails: `Listener::bind` calls `set_permissions("/tmp/bob", 0o700)`,
   which returns `EPERM` because `/tmp/bob` is owned by A.

Single-user check (no second account needed): `env -u XDG_RUNTIME_DIR bob status`
and observe the socket path in the error is `/tmp/bob/admin.sock`, not
`/tmp/bob-<uid>/admin.sock`.

## Expected Behavior

Per ADR-009, Decision §Rules — "Sockets and pidfile live under runtime … When
`XDG_RUNTIME_DIR` is unset, fall back to a per-uid temp directory (already
implemented)" — and matching the macOS arm, the Linux fallback runtime root
should be per-uid: `env::temp_dir()/bob-$UID` (e.g. `/tmp/bob-1000`).

When `XDG_RUNTIME_DIR` **is** set, the root stays `$XDG_RUNTIME_DIR/bob` — that
directory is already per-user and `0700` by the XDG spec, so no `-$UID` suffix
is added there.

## Actual Behavior

Linux fallback runtime root is `env::temp_dir()/bob` = `/tmp/bob`, shared by all
uids. Second-user `bob serve` aborts during `Listener::bind` with an opaque
`set_permissions` `EPERM`.

## Environment

- OS / platform: Linux (macOS unaffected — its arm is already per-uid)
- Language / runtime version: Rust workspace `the-intern/service`
- Relevant dependencies: n/a
- Branch / commit: present on `dev-agent` at `377e7bf` (and every prior commit —
  the Linux arm has always joined the literal `"bob"`)

## Related

- Decision: `ADR-009-bob-filesystem-layout-follows-the-xdg-base-directory-specification.md`
  (Decision §Rules, "per-uid temp directory (already implemented)")
- Specification: `S-002-bob-service-shell-architecture.md` (Component 4 /
  Configuration §Socket paths — "must lie under a directory the service can
  create with mode `0700`")
- Decision: `ADR-005`, `ADR-007` (the `0700` owner-only transport trust
  boundary the runtime directory must preserve)
- Issue #60 / PR #78 — where this was surfaced

## Suspected Area

`the-intern/service/crates/bob/src/config.rs` — `resolve_runtime_root`, the
Linux (`cfg!(not(target_os = "macos"))`) arm, `XDG_RUNTIME_DIR`-unset fallback
branch only.

## Fix Verification

```bash
cd the-intern/service
# Fallback (XDG_RUNTIME_DIR unset) resolves to a per-uid dir; set case unchanged:
cargo test -p bob --lib -- config::tests
# Regression sweep + format:
cargo test -p bob --lib
cargo fmt --all -- --check
# Full workspace (UDS/peer-cred suites) — CI `Tests` job on the PR.
```

## Diagnosis Log

### Diagnosis 1 — 2026-09-01

Reproduction status: confirmed by code inspection. `resolve_runtime_root`
(`crates/bob/src/config.rs`) Linux arm joins a literal `"bob"` onto the
`env::temp_dir()` fallback; the macOS arm joins `format!("bob-{}", sources.uid)`.
A behavioural repro needs a Linux host with `XDG_RUNTIME_DIR` unset (and, for the
collision, a second uid); the diagnosis sandbox cannot stand that up.

Evidence captured:
- `crates/bob/src/config.rs` `resolve_runtime_root`: macOS
  `Path::new(&tmpdir).join(format!("bob-{}", sources.uid))` vs Linux
  `Path::new(&runtime).join("bob")`.
- `crates/admin-rpc/src/listener.rs` `Listener::bind`: unconditional
  `set_permissions(parent, 0o700)` on start → `EPERM` for a non-owning second
  uid on a shared `/tmp/bob`.
- ADR-009 Decision §Rules names the fallback as per-uid and "already
  implemented" — true for macOS only.

Isolated fault: `crates/bob/src/config.rs`, `resolve_runtime_root`, Linux arm,
the `XDG_RUNTIME_DIR`-unset (`env::temp_dir()`) branch — `.join("bob")` must be
`.join(format!("bob-{}", sources.uid))`. The `Some(dir)` (var-set) branch stays
`$XDG_RUNTIME_DIR/bob`.

Root cause or fault hypothesis: root cause — the ADR-009 per-uid fallback was
implemented for the macOS arm only; the Linux arm was never updated to match.

Planned fix (minimal): in the Linux arm's fallback branch, name the runtime root
`bob-<uid>` instead of `bob`, mirroring macOS. Keep the var-set branch as
`$XDG_RUNTIME_DIR/bob`. Directory mode (`0700`) is already enforced by
`Listener::bind` for created and pre-existing directories alike, so no
permission-handling change is needed for the minimal fix.

Out of scope (follow-up): `/tmp` is world-writable, so `/tmp/bob-<uid>` can be
pre-created by another local user before bob's first run. `Listener::bind`
currently reacts with an opaque `set_permissions` `EPERM` rather than an
explicit fail-closed "refusing to trust" check like
`bob_core::types::schedule::verify_trusted_store` does for the schedule store
(ADR-012). Hardening the fallback runtime dir with an owner+mode precondition is
a separate bug, not part of this fix.

Planned verification:
- `cargo test -p bob --lib -- config::tests` — fallback root is
  `env::temp_dir()/bob-<uid>` when `XDG_RUNTIME_DIR` is unset; stays
  `$XDG_RUNTIME_DIR/bob` when set; an explicit `BOB_ADMIN_SOCK_PATH` override
  still wins.
- `cargo test -p bob --lib`, `cargo fmt --all -- --check` for regressions.
- CI `Tests` job for the full workspace (UDS suites do not run in the sandbox).

## Work Log

<!-- Mandatory. Append one entry per session boundary. Format:
### Session N — YYYY-MM-DD
Free-prose body: what was done this session, what was tried and
rejected, decisions made, what remains for next session.

Start every session by reading the entries below.
The final entry serves as the handoff to the reviewer. -->

## Review

<!-- Reviewer: append verdict here after each review cycle.

### Review Verdict — YYYY-MM-DD
PASS | FAIL | ESCALATE

- For FAIL: file, location, what is wrong, what should change.
- For PASS: brief confirmation that diagnosis, fix, verification, and code quality passed.
- For ESCALATE: design issue and why normal Developer fixes cannot resolve it.
-->
