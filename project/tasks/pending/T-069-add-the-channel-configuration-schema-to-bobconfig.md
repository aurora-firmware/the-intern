---
id: T-069
title: Add the channel configuration schema to BobConfig
status: pending
priority: high
assigned-role: unassigned
created: '2026-05-21'
---

# Add the channel configuration schema to BobConfig

## Description

Implements **Component 2 (Channel configuration)** of S-006
(`project/specs/channel-adapter-framework-and-interactive-chat-adapter.md`),
Phase 1.

`bob`'s layered configuration (`BobConfig` in `crates/bob/src/config.rs`, TOML
via figment per ADR-002) currently has no per-channel settings. Add a channels
configuration section: a `ChannelsConfig` (or equivalent nested struct on
`BobConfig`) holding a per-channel **enable flag**. For this slice only the
chat channel exists; design the section so adding email/webhook/scheduler later
is a field addition, not a reshape.

Default behaviour, resolving the S-006 Gate-1 `[TODO]`: a channel whose
configuration is absent is **disabled**, **except the chat channel, which
defaults to enabled** — it is the primary interactive channel and rides the
always-on `admin.sock`. The new section must round-trip through the existing
figment layered-source loader and its defaults layer, exactly as the existing
`policy` and `monitoring` config sections do.

This task only adds the configuration surface. Reading the flag to decide
whether to start the chat adapter is T-072's responsibility.

## Acceptance Criteria

AC-1: `BobConfig` shall expose a channels configuration section carrying a
      per-channel enable flag for the chat channel.

AC-2: WHILE no channels configuration is supplied by any config source THE
      SYSTEM SHALL report the chat channel as enabled.

AC-3: WHEN a config source sets the chat channel's enable flag to false THE
      SYSTEM SHALL report the chat channel as disabled.

AC-4: The channels section shall load through the existing figment
      layered-source loader, verified by a config-loading test in `config.rs`.

AC-5: The workspace shall build and all tests shall pass under
      `cargo test --workspace`.

## Dependencies

- None.

## Files to Touch

- `the-intern/service/crates/bob/src/config.rs` — add the channels config
  section to `BobConfig` and its raw/defaults counterparts; add coverage for
  the default-enabled and explicitly-disabled cases.

## Verification

```bash
cd the-intern/service
cargo test -p bob config
cargo test --workspace
```

## Work Log

<!-- Mandatory. Append one entry per session boundary. -->

## Review

<!-- Reviewer: append verdict here after each review cycle. -->
