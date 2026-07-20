# PR Review (re-review): aurora-firmware/the-intern#21 — S-009: Scheduler Channel Adapter and `bob schedule` CLI

> Re-review at head `5a11d7f` (was `891319c` for the [previous review](#previous-review-superseded)).
> Two things changed since the last pass: (1) the developer pushed a fix commit
> (`f588a6c`) that addresses **all five** prior findings, and (2) PR #22 was
> merged into `dev-agent`. Because PR #21's head **is** `dev-agent`, its diff vs
> `main` now mechanically includes the PR-22 architecture docs as well.

## Summary

PR #21 implements S-009: a cron-based scheduler actor (`scheduler-adapter` crate)
firing `InternalEvent { kind: Periodic }` jobs, `[[schedule]]` persistence in
`bob.toml`, and `schedule.*` admin-RPC + `bob schedule` CLI lifecycle management.

**This re-review clears the PR.** Every finding from the previous review is
resolved in the live source (`f588a6c`, "fix(scheduler): sync startup job table
and harden schedule persistence"), each with an accompanying regression test, and
the focused unit suites for the changed crates pass. An Architect pass confirms
the spec **S-009 is still aligned** with the architecture PR-22 established
(peer-cred-as-audit-only, single-socket control plane, single-user scope). The
PR-22 documentation now visible in this diff was reviewed and reconciled under its
own PR (`pr-22-review.md`) before merge, and is not re-litigated here.

**Findings: 0 new. 5/5 prior findings resolved.**

| Scope | Files | Lines changed | Tier | Findings |
|---|---|---|---|---|
| source (scheduler delta `f588a6c`) | 6 | ~315 | full, verified against live source + tests | 0 (was 1 critical, 1 warning, 2 suggestion) |
| security (config rewrite) | 1 | (subset of source) | full | 0 (was 1 suggestion) |
| documentation — S-009 architecture alignment | spec + ADRs | — | architect agent | 0 (ALIGNED) |
| documentation — PR-22 docs now in diff | 17 | ~1.5k | reviewed under PR #22 | n/a (reconciled pre-merge) |

## Resolution of prior findings

All five were published as inline comments on the PR and are now fixed by `f588a6c`:

| # | Prior finding | Status | Evidence (live source @ `5a11d7f`) |
|---|---|---|---|
| 1 | **[critical]** Watch channel starts empty while jobs run — `list/add/remove` desynced at startup | **Resolved** | `scheduler-adapter/src/lib.rs:305` now seeds the channel with the startup entries: `let (tx, rx) = watch::channel(entries.clone());` (was `Vec::new()`). The live table read by `schedule.list` and the add/remove pre-checks matches the running jobs from the first tick. |
| 2 | **[warning]** Reload re-randomizes `ChannelId`/`UserId` for unchanged jobs, breaking the documented identity contract | **Resolved** | `build_job_states` (lib.rs:227–228) now derives identities deterministically: `ChannelId::from_name(&entry.id)` / `UserId::from_name(&entry.id)`. `from_name` is UUIDv5 over `"<IdType>:<name>"` (`bob-core/src/types/identifiers.rs:44`), stable across reloads/restarts and type-scoped. New regression test `build_job_states_derives_stable_identities_across_rebuilds` (lib.rs:539) + `from_name_*` tests (identifiers.rs:208–225). |
| 3 | **[suggestion]** Concurrent `add`/`remove` do a non-atomic read-modify-write of `bob.toml` | **Resolved** | A shared `schedule_write_lock: Arc<tokio::sync::Mutex<()>>` (dispatch.rs:77) is acquired before the pre-check and held — function-scoped — across `load → modify → write_and_reload` in both `handle_schedule_add` (dispatch.rs:813) and `handle_schedule_remove` (dispatch.rs:884). The whole sequence is now serialized. |
| 4 | **[suggestion]** Duplicated schedule-persistence helper — the tested copy isn't the live one | **Resolved** | Collapsed to one canonical `bob_core::types::schedule::write_schedule_entries` (schedule.rs:43). `bob/src/config.rs:777` re-exports it; `write_and_reload` (dispatch.rs:1069) calls it; the old `write_schedule_entries_to_toml` duplicate is gone. The tested code is now the code that runs. |
| 5 | **[suggestion][security]** Atomic config rewrite doesn't preserve `bob.toml` permissions | **Resolved** | The canonical writer reads the original file's mode and `set_permissions` on the temp file before the rename (schedule.rs:88–105, `#[cfg(unix)]`). New test `preserves_restrictive_file_mode` (schedule.rs:185) asserts a `0600` config stays `0600` after a rewrite. |

`write_and_reload` (dispatch.rs:1081) calls `handle.reload(entries)` with the same
`entries` it persisted, so disk and the live watch table stay in sync after every
mutation — this is what makes finding #1's seed and the live-table pre-checks
coherent end to end.

## Architecture alignment (S-009 vs the post-PR-22 architecture)

An Architect agent reviewed S-009 against ADR-004/005/006/007/008, the amended
`the-intern-architecture.md`, the reconciled sibling specs (S-002, S-005), the
roadmap, and S-001. **Verdict: ALIGNED — no amendment to S-009 required.**

The four checks the new architecture demanded:

1. **Peer-cred is audit-only, not an admission gate** (ADR-005/ADR-007) — *consistent.*
   S-009 contains no `SO_PEERCRED`/peer-credential language and never describes
   `admin.sock` as a security gate. It had no stale claim to reconcile, unlike
   S-002/S-005 (which were corrected by PR-22). The one "admission" mention in
   S-009 (the queue's pre-flight policy check, lines 164–166) is the
   ADR-004/S-001 Requests-Handler check, a distinct concern, and stated correctly.
2. **Single local JSON-RPC control plane** (ADR-007) — *consistent.* S-009 mounts
   `schedule.*` on the single `admin.sock`; "config file is source of truth,
   admin-RPC is the mutation path" is exactly ADR-007's "configuration as live
   state" example.
3. **Single-user local scope** (ADR-008) — *consistent.* No multi-user/multi-tenant
   assumptions; the adapter-assigned, job-derived identity is endorsed by ADR-008.
4. **Phase/channel framing** (S-001, roadmap) — *consistent.* S-009's "Phase 6 …
   scheduler channel alongside chat and email" still matches the amended S-001 and
   roadmap. PR-22 dropped **webhooks** (a channel S-009 never referenced) and did
   not renumber Phase 6.

The scheduler *implementation* is likewise consistent with the updated trust
model: it constructs `RequestContext` with **server-derived** `ChannelId`/`UserId`
(never caller-supplied), so the demotion of peer-cred to audit-only changes
nothing about how scheduled requests are identified.

## PR-22 documentation now present in this diff

Because the PR head is `dev-agent`, the diff vs `main` now also contains the
merged PR-22 changes (ADR-007, ADR-008, B-009, `the-intern-architecture.md`, the
`S-NNN-` spec renames/edits, roadmap, README, user-doc pages). These were reviewed
under **PR #22** (`pr-22-review.md`); its three warnings were reconciled in commits
`c7ca7c3` and `066e717` **before** the merge — spot-verified in this tree:

- S-002/S-005 now describe `SO_PEERCRED` as audit-only, with dated Amendment Log
  entries (S-002:431, S-005:287).
- No `webhook` references remain in `README.md` or `the-intern/docs/src/`.
- B-009 now states the actual cross-UID exposure ("a *different* local uid can
  connect…", B-009:23) rather than assuming a single UID.

This re-review does not re-open that already-reviewed, already-reconciled content.

## Verification performed

- **Source/security:** read the live post-fix source for every changed file
  (`scheduler-adapter/src/lib.rs`, `bob-core/src/types/{schedule,identifiers}.rs`,
  `admin-rpc/src/dispatch.rs`, `bob/src/config.rs`) and traced each prior finding
  to its fix and its test. Full tier — surrounding code read, not just the diff.
- **Tests run (this review):** `cargo test -p scheduler-adapter -p bob-core --lib`
  → **bob-core 85 passed**, **scheduler-adapter 8 passed**, 0 failed. These cover
  the new regression tests (stable identities, restrictive-mode preservation,
  `from_name` determinism/type-scoping). The UDS/peer-cred-dependent admin-rpc
  integration tests were not run here (they require a non-sandbox shell per
  `CLAUDE.md`); CI on the PR reports Build, Format, Documentation, Tests, and User
  Documentation all green.
- **Architecture:** Architect agent (verdict ALIGNED, no S-009 edit).
- **Existing comments:** the only inline comments on the PR are the five prior
  findings (all now addressed); nothing else to deduplicate against.

---

## Previous review (superseded)

The findings below are the prior review at head `891319c`; all are now resolved
(see the resolution table above). Retained for traceability.

### Source

#### [critical] Watch channel starts empty while jobs run — `schedule list/add/remove` desynced at startup — `the-intern/service/crates/scheduler-adapter/src/lib.rs:292`

`start()` seeded the running job table from `entries` but initialized the reload
watch channel with an empty vec, so the admin-RPC introspection/pre-checks
(`schedule.list`, `add` duplicate-id, `remove` existence) read an empty table
until the first reload — `list` returned `[]`, `add` could write a duplicate id,
`remove` of a configured job returned "no entry found". **→ Resolved (#1).**

#### [warning] Reload re-randomizes ChannelId/UserId for unchanged jobs — `…/scheduler-adapter/src/lib.rs:221`

`build_job_states` assigned fresh `ChannelId::new()`/`UserId::new()` per entry on
every reload, re-randomizing the identities of unchanged jobs and breaking the
type's documented "fixed for the lifetime of the job" contract. **→ Resolved (#2).**

#### [suggestion] Concurrent `schedule add`/`remove` perform a non-atomic read-modify-write of `bob.toml` — `…/admin-rpc/src/dispatch.rs:822`

Load→modify→write against `bob.toml` with `&self` and `.await` points was not
serialized, so two concurrent admin clients could interleave and last-writer-wins
silently drop a mutation. **→ Resolved (#3).**

#### [suggestion] Duplicated schedule-persistence helper — the tested copy is not the live one — `…/admin-rpc/src/dispatch.rs:1185`

Two implementations of the atomic `[[schedule]]` rewrite existed; the live path
used the dispatch.rs copy while the unit tests exercised the config.rs copy, so
they could drift. **→ Resolved (#4).**

### Security

#### [suggestion] Atomic config rewrite does not preserve `bob.toml` file permissions — `…/admin-rpc/src/dispatch.rs:1219`

The rewrite created the temp file at the umask default and renamed it over
`bob.toml`, dropping a deliberately-restricted mode (e.g. `0600` → `0644`).
**→ Resolved (#5).**
