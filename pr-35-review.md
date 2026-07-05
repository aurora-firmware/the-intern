# PR Review: aurora-firmware/the-intern#35 - Bug-loop: resolve B-017, B-018, B-019

## Summary

This re-review covers PR head `c8353ceabc2b65917f29993aecfabd2abd743e12` plus the current local workspace fix to `tests/test_roadmap.sh`. The previous roadmap-test failure is fixed locally: `tests/test_roadmap.sh` now passes 5/5 after pointing at `project/docs/archive/roadmap.md`. I found one remaining low-severity broken-reference issue: live rustdoc scaffold notes still point at the old roadmap path.

| Scope | Files | Lines changed | Tier | Findings |
|---|---:|---:|---|---:|
| Documentation | 16 | 2507 | full | 0 |
| Source | 5 | 1188 | full | 1 |
| Security | 19 | 3685 | full | 0 |

## Findings

### Source

#### [suggestion] Rustdoc scaffold notes still point at the removed roadmap path - `the-intern/service/crates/extension-ipc/src/lib.rs:59`

The PR archives `project/docs/roadmap.md` as `project/docs/archive/roadmap.md`, but the `extension-ipc` `Handle` and `Actor` rustdoc notes still say `scaffold - see project/docs/roadmap.md phase 3` at lines 59 and 68. Since the old path no longer exists after this PR, generated docs now point readers at a dead source path. Update both notes to the archive path, or remove the roadmap path if these scaffold markers no longer need to link to an archived planning document.

## Skipped files

None. No lock files, vendored code, generated files, minified assets, source maps, or binary-only files were present in the PR file list.

## Review notes

Fetched latest PR metadata, file patches, full diff, and existing review comments with `gh`; there were no existing review comments to deduplicate against. The remote PR head is still `c8353ceabc2b65917f29993aecfabd2abd743e12`. The current workspace has an uncommitted local fix to `tests/test_roadmap.sh` changing `ROADMAP` from `project/docs/roadmap.md` to `project/docs/archive/roadmap.md`; with that local fix, `tests/test_roadmap.sh` passes 5/5. I also re-checked the earlier authz queue overflow finding and it remains fixed by carrying verdict resolvers in queued authz frames and resolving evicted authz calls as `queue_overflow`.
