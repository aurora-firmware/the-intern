---
id: B-020
title: Remove legacy TOML write_schedule_entries schedule-store writer (dead 
  code, would not persist cwd)
severity: low
status: open
created: '2026-07-05'
---

# Remove legacy TOML write_schedule_entries schedule-store writer (dead code, would not persist cwd)

## Summary

`write_schedule_entries` (`crates/bob-core/src/types/schedule.rs`, ~line 526)
writes the schedule store as a TOML `[[schedule]]` array — the pre-ADR-012 model.
ADR-012/S-009 mandate a versioned JSON store, and the live persistence path
already uses the JSON writer `write_schedule_store` (schedule.rs ~338). The TOML
writer is dead code: it is reachable only via a `pub use` re-export
(`crates/bob/src/config.rs` ~744) and stale T-097 tests, with no production
caller. It is a latent trap — being hand-rolled TOML, it does not serialize the
serde-derived `ScheduleEntry`, so it would silently omit newer optional fields
(e.g. the CR-005 `cwd`, and already `file`). This was surfaced during the CR-005
Gate 2 preflight as a pre-existing divergence, out of CR-005 scope.

## Reproduction Status

Status: confirmed (static — verified dead code, not a runtime failure)

The live write path (`write_schedule_store`) is JSON and ADR-012-compliant;
`write_schedule_entries` has no production caller.

## Evidence

- Live JSON writer: `crates/bob-core/src/types/schedule.rs` ~338
  (`write_schedule_store`, `serde_json::to_string_pretty` of `{version, entries}`),
  called from `admin-rpc` schedule.add/remove, config load, and the e2e suite.
- Legacy TOML writer: `crates/bob-core/src/types/schedule.rs` ~526
  (`write_schedule_entries`, emits `[[schedule]]`), reachable only from the
  `pub use` re-export in `crates/bob/src/config.rs` ~744 and stale T-097 tests.
- Verified by the Architect during CR-005 Gate 2 preflight (2026-07-05).

## Expected Behavior

Only one schedule-store serialization path exists (the ADR-012 JSON writer), so
every serde-derived `ScheduleEntry` field is persisted; no dead TOML writer can
silently drop fields.

## Actual Behavior

Two writers coexist. The unused `write_schedule_entries` TOML writer would omit
serde-only fields (`file`, `cwd`) if ever called, and its stale tests still
exercise the retired `[[schedule]]` shape.

## Related

- Change request: `CR-005` (surfaced during its Gate 2 preflight)
- Specification: `S-009-scheduler-channel-adapter-and-bob-schedule-cli.md`
- Decision: `ADR-012-scheduler-admission-uses-unix-trust-boundary-and-json-state.md`

## Suspected Area

`crates/bob-core/src/types/schedule.rs` (`write_schedule_entries` and its tests);
the `pub use` re-export in `crates/bob/src/config.rs`.

## Fix Verification

```bash
cd the-intern/service && cargo test --workspace && cargo build -p bob
```

## Diagnosis Log

## Work Log

## Review
