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

### Session 1 — 2026-05-22

Implemented T-069 (add the channel configuration schema to `BobConfig`) in two TDD cycles on branch `task/T-069-add-channel-configuration-schema`.

**What was done.**

Cycle 1 (AC-1 + AC-2): Added two new public structs — `ChannelsConfig` (top-level, one field per channel) and `ChatChannelConfig` (just `enabled: bool`) — to `config.rs`. Added `channels: ChannelsConfig` to `BobConfig` and its `test_base()` helper. Added `RawChannelsConfig` and `RawChatChannelConfig` with serde attributes: `RawChatChannelConfig` uses `#[serde(default = "default_chat_enabled")]` so that an absent `[channels.chat]` section produces `enabled = true`. Both raw structs implement `Default`. `defaults_with_runtime_root` was updated to include `channels: RawChannelsConfig::default()`. `load_with_sources` maps raw to public config. Tests `bob_config_exposes_channels_field_with_chat_channel_config` (AC-1 structural) and `chat_channel_is_enabled_by_default_when_no_channels_config_is_supplied` (AC-2) were added.

Cycle 2 (AC-3 + AC-4): Added `chat_channel_is_disabled_when_config_source_sets_enabled_to_false` (sets `[channels.chat] enabled = false` in a temp TOML file and asserts the field reads back false) and `channels_section_loads_through_figment_layered_source_with_default_then_file_override` (exercises the full figment layered path: no file → default `true`, then file → overridden `false`). Both passed immediately, confirming the implementation from cycle 1 already handled these cases.

**Files outside `Files to Touch`:** `shell_e2e.rs` constructs `BobConfig` using a struct literal; adding `channels` to `BobConfig` required updating that literal. The change was purely mechanical (one new field) and was included in cycle 1's commit.

**Rejected approaches:** A `Default` impl on `BobConfig` was not added (empty socket paths would create a non-bootable runtime). The `channels` field uses the same raw/public split pattern as `MonitoringConfig`.

**What remains:** Nothing for this task. AC-1 through AC-5 are all covered. The flag is readable via `config.channels.chat.enabled`.

Commits: `9dd2f3c` (cycle 1), `b4e9676` (cycle 2). `cargo test --workspace` — all suites green, 0 failures.

## Review

<!-- Reviewer: append verdict here after each review cycle. -->

### Review Verdict — 2026-05-22

PASS

**Stage 1 — Spec compliance:** All five acceptance criteria are met.

- AC-1: `BobConfig` exposes `pub channels: ChannelsConfig` with `pub chat: ChatChannelConfig { pub enabled: bool }`. Confirmed by type-annotation structural test `bob_config_exposes_channels_field_with_chat_channel_config` and the public API diff.
- AC-2: `RawChatChannelConfig` uses `#[serde(default = "default_chat_enabled")]` (returns `true`) and `impl Default` delegates to the same function. Confirmed by `chat_channel_is_enabled_by_default_when_no_channels_config_is_supplied` using `load_with_env_overrides([])` (no file, no config source).
- AC-3: `chat_channel_is_disabled_when_config_source_sets_enabled_to_false` writes `[channels.chat]\nenabled = false` to a temp TOML file and asserts the parsed field is `false`.
- AC-4: `channels_section_loads_through_figment_layered_source_with_default_then_file_override` exercises the two-layer figment path — defaults produce `true`, a TOML file overrides to `false` — exactly mirroring the `[monitoring]` section test pattern.
- AC-5: `cargo test -p bob config` on the task branch ran 33 tests (29 before the task), 0 failures. Work Log records `cargo test --workspace` all green.

The `shell_e2e.rs` change (one-field struct literal update) is justified in the Work Log and is a mechanical consequence of adding the field to `BobConfig`. No unspecified behavior was added.

**Stage 2 — Code quality:** No issues found.

- Correctness: Raw/public split follows the established `MonitoringConfig` pattern. `defaults_with_runtime_root` includes `channels: RawChannelsConfig::default()`. Mapping in `load_with_sources` is direct and correct.
- Tests: Four new tests, each independent (fresh state per test), descriptively named, covering all required paths including success and override.
- Security: No credentials, no external input bypassing typed structs.
- Readability: Naming is idiomatic (`ChannelsConfig`, `ChatChannelConfig`, `default_chat_enabled`). Each struct and function has a single responsibility. Comments explain design intent.
- Performance: Config is loaded once at startup; no concern.
