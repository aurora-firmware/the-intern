---
id: ADR-009
title: bob filesystem layout follows the XDG Base Directory specification
status: accepted
created: '2026-06-23'
---

# ADR-009: bob filesystem layout follows the XDG Base Directory specification

## Context

bob needs a single, documented answer to "where does each of its files live",
covering configuration, the pi extension, runtime sockets, and the audit log.

At the time of this decision bob already resolved most locations from XDG base directories
(`$XDG_CONFIG_HOME/bob/config.toml`, `$XDG_STATE_HOME/bob/audit.jsonl`,
`$XDG_RUNTIME_DIR/bob/` for sockets, each with spec-default fallbacks in
`config.rs`), but two things are undecided:

- Before CR-003, the pi extension (`bob.ts`) had no bob-owned location: the
  operator installed it manually into pi's own search path. CR-003 needed a
  default path bob could pass to pi.
- There is no single record codifying the layout, and per-path `BOB_*` env
  overrides have accreted.

A single self-contained root (`BOB_HOME`, e.g. `~/.bob`, with sockets in a
`run/` subdir) was considered and rejected — see Alternatives — primarily
because placing sockets under a nested install root risks the Unix-domain-socket
`sun_path` length limit (~108 bytes on Linux) and puts sockets on disk (stale
files across reboots, not tmpfs).

Forces and constraints:

- **ADR-008** commits the product to a single-user, local deployment scope.
- The socket trust boundary (**ADR-005**, **ADR-007** "Layer 1 is the real
  gate") requires the directory holding a socket to be `0700` owner-only.
- Minimise reliance on bespoke environment variables; prefer standard
  conventions with sane defaults over per-path overrides.

## Decision

Adopt the **XDG Base Directory specification** as bob's filesystem layout on
Linux, with application name `bob`. Each variable falls back to its XDG-spec
default when unset:

| Purpose | Location (default) | Holds |
|---|---|---|
| config | `$XDG_CONFIG_HOME/bob/` → `~/.config/bob/` | `config.toml` |
| data (static app assets) | `$XDG_DATA_HOME/bob/` → `~/.local/share/bob/` | `extensions/bob.ts` |
| cache (regenerable) | `$XDG_CACHE_HOME/bob/` → `~/.cache/bob/` | reserved; not yet implemented |
| state (persistent logs) | `$XDG_STATE_HOME/bob/` → `~/.local/state/bob/` | `audit.jsonl` |
| runtime (ephemeral) | `$XDG_RUNTIME_DIR/bob/` | `admin.sock`, `extension.sock`, pidfile |

Rules:

- The **pi extension default** is `$XDG_DATA_HOME/bob/extensions/bob.ts`
  (→ `~/.local/share/bob/extensions/bob.ts`) — the path bob passes to pi
  (consumed by CR-003). `data` is the XDG bucket for read-only, architecture-
  independent application assets, which is what the extension is.
- The **audit log** lives under `state` (persists across reboots), **not** under
  runtime or cache.
- **Sockets and pidfile** live under `runtime` (tmpfs, short paths, per-user,
  cleared on reboot). When `XDG_RUNTIME_DIR` is unset, fall back to a per-uid
  temp directory (already implemented).
- `config.toml` MAY override individual subpaths (for example, the extension
  path). Standard `BOB_*` per-path overrides remain available but are not the
  primary mechanism.
- The runtime directory (and any directory holding a socket) MUST be `0700`
  owner-only to preserve the Layer-1 transport trust boundary (ADR-005,
  ADR-007). `XDG_RUNTIME_DIR` is already `0700` by the spec.
- **macOS** retains its existing platform conventions (Application Support /
  `TMPDIR`-based runtime), as already implemented; this ADR specifies Linux.

To be explicit: bob's resolution (`config.rs`) covers **config**, **state**,
**runtime**, and the **data** row used by the extension path / `extension_path`.
The **cache** row remains reserved for future work.

## Consequences

### Positive

- OS-idiomatic and predictable; ratifies the resolution `config.rs` already
  implements for config, state, and sockets.
- Sockets stay on tmpfs in `XDG_RUNTIME_DIR`: short paths (no `sun_path` length
  risk) and auto-cleared on reboot (no stale socket files).
- Clear lifecycle separation — static assets (`data`) vs. regenerable (`cache`)
  vs. persistent logs (`state`) vs. ephemeral (`runtime`).
- Gives CR-003 a concrete, well-placed default extension path.

### Negative

- bob is spread across up to five directories rather than a single deletable
  root; a full uninstall must touch `config`, `data`, `cache`, `state`, and
  `runtime` locations.
- No single home from which the pi child can derive the socket path, so the
  supervisor→child handshake is **not** reduced: `BOB_SESSION_ID` and the
  extension socket path are still passed explicitly (S-003 contract unchanged).
- Relies on XDG conventions; on minimal/non-login environments some `XDG_*`
  variables are unset, requiring the spec-default fallbacks (already
  implemented).

### Neutral

- The configuration file keeps the name `config.toml`.
- The `cache` location is reserved but unused until bob has cacheable data.
- Does not supersede a prior ADR — no dedicated path-resolution ADR existed; the
  XDG behaviour previously lived only in `config.rs`.

## Alternatives Considered

### Alternative A: Single BOB_HOME root (e.g. ~/.bob with a run/ subdir)

**Description:** Anchor everything under one root directory (`bin/`,
`extensions/`, `config.toml`, and a `run/` directory for sockets), overridable
via a single `BOB_HOME` variable.
**Rejected because:** placing sockets under a nested install root risks the UDS
`sun_path` length limit and puts sockets on disk (stale files across reboots,
not tmpfs), coupling ephemeral runtime state to the install. The self-contained,
single-deletable-root benefit did not outweigh these risks for a tool whose
sockets are security-load-bearing.

### Alternative B: Bespoke per-path BOB_* overrides as the primary mechanism

**Description:** Keep resolving each location chiefly from dedicated environment
variables (`BOB_ADMIN_SOCK_PATH`, `BOB_EXTENSION_SOCK_PATH`, …).
**Rejected because:** it fragments configuration across many variables with no
single convention; XDG with optional `config.toml` overrides is cleaner and
standard.
