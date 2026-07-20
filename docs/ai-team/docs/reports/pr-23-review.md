# PR Review: aurora-firmware/the-intern#23 — Resolve B-011 shutdown timeout

## Summary

The PR is the periodic `dev-agent` → `main` promotion. Its headline change is a
correct, well-scoped fix for **B-011** (idle `bob serve` waited out the
drain/reap deadlines on Ctrl-C/SIGTERM): the admin-rpc listener and its
accepted connection tasks are made cancellable via a `watch` channel and drained
on shutdown, so their `Dispatcher` clones drop before phase 3 awaits subsystem
joins. But the PR also carries everything else accreted on `dev-agent` — the
**B-010** user-docs fix, several reports, and the deletion of
`ai-process-cli-reported-issues.md` — none of which the PR title/body mentions.

The B-011 source change and the B-010 doc edits both look good. Findings: **0
critical, 1 warning, 1 suggestion.**

| Scope | Files | Lines changed | Tier | Findings |
|---|---|---|---|---|
| source | 4 | ~272 | full | 1 |
| documentation | 13 | ~1687 | full | 1 |
| ci | 1 | 7 | trivial | 0 |
| security (lens on `admin-rpc`) | 1 | — | n/a | 0 |

## Findings

### Documentation

#### [warning] Removing `ai-process-cli-reported-issues.md` leaves `CLAUDE.md` pointing at a deleted file — `ai-process-cli-reported-issues.md`

This PR deletes `ai-process-cli-reported-issues.md` (-209 lines), but `CLAUDE.md`
still references it in two places that are *not* touched by this PR:

- line 104 — the folder-structure listing
  (`├── ai-process-cli-reported-issues.md  # Running log of ai-team CLI / skill bugs`)
- line 131 — an `IMPORTANT` instruction:
  *"Please write down there every bug or problem you notice … in `ai-process-cli-reported-issues.md`."*

After this merges to `main`, that instruction points contributors (and agents)
at a file that no longer exists, and the 209 lines of accumulated CLI/skill bug
history (the recurring `new-bug`/`new-spec` flag mismatches, the `integrate`
`git mv` defect, etc.) are deleted rather than relocated. The originating commit
message (`chore(docs): move mr reviews to the reports folder`, `0c60f8e`)
describes adding the `pr-*-review.md` files but does not mention this deletion,
so it reads as incidental.

Suggested fix: either keep the file tracked, or — if it is intentionally moving
to an untracked/local-only log — update `CLAUDE.md` (both references) in the
same change so the documented bug-log location matches reality.

### Source

#### [suggestion] `test_user_docs_self_contained.sh` AC-1 silently passes if `rg` is absent — `tests/test_user_docs_self_contained.sh:49`

```bash
if rg -n "$INTERNAL_PROJECT_DOC_PATTERN" "$DOCS_SRC" >/dev/null 2>&1; then
  ok=1
fi
```

If `rg` is not installed, the command exits non-zero (127), the `if` is false,
`ok` stays `0`, and the test reports **PASS** — even though nothing was checked.
Because the call sits in an `if` condition, `set -e` does not catch it either.
A regression guard that passes when its checker tool is missing gives false
confidence (the same pattern affects the `! rg …` checks in AC-2/AC-3). Consider
asserting `rg` (and `mdbook`) are on `PATH` up front and failing loudly if not,
rather than letting a missing tool degrade into a green run.

## Skipped files

No files were noise-filtered. There are no lock files, vendored code, minified
assets, generated output, or binaries in this PR. (`Cargo.lock` is not part of
the diff.)

## Review notes

- **Scopes reviewed inline, not via spawned agents.** The working tree is
  checked out at the PR head (`a106ecb`, branch `dev-agent`), so the `full`-tier
  source scope was reviewed with full surrounding context read directly from
  disk rather than from the bare diff.
- **B-011 source fix — verified correct.** Confirmed `admin_rpc_join` is
  collected into `joins` → `all_joins`, which phase 3 awaits under
  `shutdown_drain_deadline` (`serve.rs:270,276,404,409`); so `begin_shutdown()`
  in phase 1 (`serve.rs:377`) genuinely shortens the drain by dropping the
  listener's `Dispatcher` clones. Confirmed all callers of the now-`#[cfg(test)]`
  `run_connection` are inside the test module (no broken non-test build). The
  `watch`-channel teardown is robust: even if `begin_shutdown()` were skipped,
  dropping the `Handle` drops `shutdown_tx`, so `changed()` returns `Err` and the
  listener/connections still break — strictly better than the previous
  detached-forever listener. The `JoinSet` drain with the
  `if !connections.is_empty()` guard on `join_next()` is the correct idiom and
  avoids a busy-loop. New unit test (`serve.rs`) and the tightened `shell_e2e.rs`
  SIGTERM assertion both correctly assert exit *before* the drain deadline is
  consumed, not merely before drain+reap+margin.
- **Security lens on `admin-rpc`.** The change is purely shutdown/lifecycle
  ownership; the peer-credential trust boundary (`Listener::accept` rejection,
  `peer_cred_from_fd`) is untouched. No separate security finding.
- **B-010 doc edits — verified.** The three mdBook chapters cleanly replace the
  out-of-book `project/(decisions|docs|specs)` and `extensions/` links with
  self-contained prose; ADR names are kept as plain text. The new
  `build.yml` guard greps for the same pattern before the mdBook build. Note
  (non-blocking): that grep is a strict substring match, so any *prose* mention
  of `project/docs/...` in a shipped doc — not just a link — will fail CI. That
  appears intentional for B-010, but it is stricter than "no broken links."
- **PR scope vs. description.** The body summarizes B-011 only. A maintainer
  merging this should know it also lands the B-010 fix, six new report
  documents, and the `ai-process-cli-reported-issues.md` deletion. Worth a line
  in the PR description before merge.
- **Lifecycle records** (B-010/B-011 bug files, architecture/PR/progress
  reports) were read at a records level for accuracy and internal consistency;
  they are documentation artifacts with no code impact and produced no findings.
- No existing review comments on the PR, so nothing was deduplicated against
  prior feedback.

## Architecture & ADR conformance (additional review)

Checked the PR's changes against the approved specs (`project/specs/`) and ADRs
(`project/decisions/`), focused on the artifacts the changes actually touch:
S-002 (service shell / shutdown), the Rust coding guidelines §8 it cites, and
ADR-001/002/004/005/007 (referenced by the B-010 doc edits and the admin-rpc
change). **Verdict: the approved architecture is respected — and the B-011 fix
increases conformance rather than diverging.**

### B-011 shutdown fix — moves *toward* the spec, not away

The fix resolves a pre-existing violation of the documented protocol:

- **Rust guidelines §8 step 1** — "Stop accepting new channel events and admin
  requests" — and **step 4** — "Wait for tracked tasks to finish or report
  timeout." The old detached listener kept accepting until process exit and its
  connection tasks were untracked, so neither step was honored for the admin
  surface. `begin_shutdown()` + the owned `JoinSet` now implement both.
- **Rust guidelines (channels/tasks rule, lines 54–56)** — "Every spawned task
  is owned by a supervisor or task tracker. Do not spawn detached work whose
  lifecycle cannot be cancelled, awaited, and observed during shutdown." The old
  `tokio::spawn(run_listener(...))` and `tokio::spawn(run_connection(...))` were
  exactly the prohibited detached work (the old doc-comment even said the
  listener "will be cancelled when the process exits"). The fix makes the
  listener owned/awaited (`listener_join` awaited by the actor task; cancelled
  via a `watch` channel) and tracks connections in a `JoinSet` drained on
  shutdown — direct compliance with this rule.
- **S-002 graceful-shutdown workflow** — first step after SIGTERM is "stop
  accepting new admin connections; close listener." The fix makes that step real
  for the first time.

No ADR is contradicted: the transport, single-socket model (**ADR-007**),
newline-delimited framing (**ADR-001**), and the filesystem-permission trust
gate / self-asserted identity (**ADR-005**) are all untouched — the change is
purely task-ownership/lifecycle.

### B-010 doc edits — ADR paraphrases are faithful, with one weak cross-reference

The prose that replaced the removed `project/` links accurately represents the
ADRs it summarizes: ADR-001 framing, ADR-002 (TOML config), ADR-005 (self-
asserted identity behind the `0o700` socket gate). One small gap:

#### [suggestion] "delivery semantics summarized below" doesn't actually summarize them — `the-intern/docs/src/extension-author-guide/index.md:156`

The edit replaced the ADR-004 link with: *"see the delivery semantics summarized
below for the meaning of each kind"* (lines 156–157). The "below" referent is the
ADR-004 pointer paragraph (lines 177–180), which says an adapter must classify
events as sync/async/periodic but does **not** define what each kind *means* —
which is precisely the per-kind semantics the removed ADR-004 link used to
provide. The cross-reference now over-promises. Either add a one-line gloss of
each `DeliveryKind` where it's referenced, or soften the wording ("classify each
event by its delivery kind") so it doesn't point at an explanation that isn't
there. Architecturally harmless; documentation-accuracy only.
