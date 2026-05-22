---
id: ADR-002
title: Bob configuration format TOML via figment
status: accepted
created: '2026-05-16'
---

# ADR-002: Bob configuration format — TOML, loaded with `figment`

## Context

S-002 §Configuration calls for a layered configuration loader (defaults →
file → environment → CLI flags) but leaves the file format as an Open
Question:

> TOML is the conventional Rust default and aligns with the project's
> existing `.ai-team.toml`. Confirm during phase 2.

S-002 phase 2 is the binary skeleton (T-014); the loader itself lands in
T-015. The choice is load-bearing for the operator experience (humans hand-
edit this file) and for the loader's dependency footprint.

Forces:

- Rust ecosystem strongly prefers TOML for human-edited config (`Cargo.toml`,
  `rustfmt.toml`, `rust-toolchain.toml`, this project's `.ai-team.toml`).
- The configuration model is hierarchical (`[admin]`, `[supervisor]`,
  `[monitoring]`, …) with primitive leaves — a natural fit for TOML's table
  syntax.
- Layered configuration (defaults < file < env < CLI) is well-trodden in
  several Rust crates; rolling our own is unnecessary.
- The loader runs once at startup, validated up front, then treated as
  immutable per the Rust coding guidelines §7.

## Decision

The `bob` configuration file format is **TOML**. The loader is implemented
on top of **`figment`** (the layered-config crate), using its `Toml` and
`Env` providers plus a hand-rolled CLI provider for `--config-key=value`
overrides. The default file path is
`$XDG_CONFIG_HOME/bob/config.toml` on Linux and
`~/Library/Application Support/bob/config.toml` on macOS; both are
overridable with `--config <path>`.

Configuration loading and validation live in `bob::config::BobConfig::load()`
in `crates/bob/src/config.rs`. Field names use `snake_case`. Secret-bearing
fields wrap their values in a type that does not implement `Debug`/`Display`
to avoid leakage through tracing.

## Consequences

### Positive

- Matches every other config file an operator already sees on a typical
  Rust project, lowering the learning curve.
- TOML's table model maps 1:1 to per-subsystem configuration namespaces,
  making future subsystems' settings additive without restructuring the
  file.
- `figment` already implements the four-layer precedence (defaults → file →
  env → CLI) the spec requires; we don't write that ourselves.
- `figment`'s "profile" feature lets us add dev/prod variants later without
  forking the loader.

### Negative

- Adds a third-party dependency (`figment`) on the critical configuration
  path. Mitigation: `figment` is widely used and small; pin in
  `Cargo.lock`.
- TOML does not natively express durations; we'll deserialize duration
  fields from strings (e.g. `"5s"`, `"500ms"`) via a small custom helper.
- Operators familiar only with YAML or JSON config will need a one-time
  introduction; the cost is small for the OSS Rust audience.

### Neutral

- TOML deeply nested tables get noisy with `[a.b.c]` headers; we keep the
  configuration schema flat at two levels (`[section]`, then keys) to avoid
  this.

## Alternatives Considered

### Alternative A: YAML

**Description:** A widely-used human-editable hierarchical format.
**Rejected because:** Cuts against Rust ecosystem convention; introduces
foot-guns (YAML 1.1 vs 1.2 booleans, indentation sensitivity, the "Norway
problem"). No offsetting benefit for a config the project's audience
hand-edits.

### Alternative B: JSON

**Description:** Universal, ubiquitous.
**Rejected because:** Not designed for hand editing — no comments, no
trailing commas, awkward multiline strings. Operators editing
`config.json` lose comments documenting intent.

### Alternative C: A custom format hand-parsed in the binary

**Description:** Roll our own grammar (e.g. `key = value` lines).
**Rejected because:** Saves a dependency at the cost of building a
purpose-built parser, escaping rules, and error messages — none of which
add value over an off-the-shelf TOML loader.

### Alternative D: TOML with the `config` crate instead of `figment`

**Description:** The `config` crate also offers layered loading.
**Rejected because:** `figment`'s API expresses precedence and provider
composition more cleanly, and its error messages locate offending values
with file+line precision. Not a strong rejection — if `figment` ever
becomes a maintenance burden, swapping to `config` is a one-day migration.
