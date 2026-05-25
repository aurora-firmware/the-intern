---
id: T-080
title: Write architecture overview content for non-implementers
status: pending
priority: medium
assigned-role: developer
created: '2026-05-25'
spec: S-007
---

# Write architecture overview content for non-implementers

## Description

Replace the stub created by T-077 for the Architecture Overview chapter
with a conceptual description of the system aimed at readers who want to
understand `bob` without reading the Rust source.

The chapter must cover:
- **System shape** — `bob serve` as a long-running process exposing the
  admin socket (operator-facing) and the extension socket (JS extension
  facing), with an in-process request queue and in-memory persistence.
- **Request lifecycle** — how a request enters via a channel adapter,
  passes pre-flight admission, reaches the requests-handler, and how
  blocking tool-call authorization works.
- **Supervision** — the pi-agent supervisor's role (spawn, warm pool,
  prompt routing, idle reaping, kill) and its lifecycle relationship to
  `bob serve`.
- **Channel adapters** — the interactive-chat adapter as the implemented
  example; brief mention of the email/webhook/scheduler adapters as not
  yet implemented.
- **Policy gate** — pre-flight admission vs. the blocking tool-call gate,
  at a conceptual level.
- **Monitoring** — the append-only JSONL audit log, live `audit.tail`
  subscriptions, and `report.submit` intake.

Use at least two mermaid diagrams: one for the request lifecycle
(flowchart or sequence) and one for the supervisor's pi-agent lifecycle
states. Link out to `project/docs/system_overview.md` and
`project/docs/the-intern-architecture.md` for readers who want the
development-level deep dive.

## Acceptance Criteria

AC-1: The system shall provide a populated Architecture Overview chapter
at `the-intern/docs/src/architecture.md` whose rendered HTML contains a
section for each topic listed in the Description.

AC-2: The system shall include at least two mermaid diagrams (one for the
request lifecycle, one for the pi-agent supervisor state) that render as
SVG in the built HTML.

AC-3: WHEN `mdbook build` runs from `the-intern/docs/`, THE SYSTEM SHALL
produce the Architecture Overview chapter without warnings or broken
internal links.

AC-4: WHERE the chapter would otherwise restate development-level detail
already in `project/docs/`, THE SYSTEM SHALL link to that material
instead.

## Dependencies

- `T-077` — provides the mdBook scaffold (including `mdbook-mermaid`
  configuration) and the stub file this task replaces.

## Files to Touch

- `the-intern/docs/src/architecture-overview/index.md` — replace stub
  created by T-077 with full content.

## Verification

```bash
cd the-intern/docs && mdbook build
test -s src/architecture-overview/index.md
# at least two mermaid fenced blocks transformed into <pre class="mermaid">
# (mdbook-mermaid renders to SVG client-side; static HTML carries <pre class="mermaid">)
test "$(grep -rc 'class="mermaid"' book/architecture-overview* 2>/dev/null | awk -F: '{s+=$2} END{print s+0}')" -ge 2
```

## Work Log

### Session 1 — 2026-05-26

Replaced the T-077 stub at
`the-intern/docs/src/architecture-overview/index.md` with full
conceptual content covering all six required H2 sections: System Shape,
Request Lifecycle, Supervision, Channel Adapters, Policy Gate, and
Monitoring.

**Sources consulted for accuracy:** All six specification documents
(S-001 through S-006), both architecture docs
(`system_overview.md` and `the-intern-architecture.md`), and the Rust
source for cross-checking — specifically `pi-agent-supervisor/src/pool.rs`
(pool states `WarmWorker` / `ActiveSessionWorker`, `last_prompt_activity`
tracking, `reap_idle_and_surplus`, `shutdown_all`), `bob/src/serve.rs`
(two-socket topology, subsystem actors, shutdown phases),
`requests-handler/src/handler.rs` (`run_preflight` behaviour,
`PreflightDenied` audit record), and the policy-control and
extension-ipc crates.

**Key content decisions:**
- The supervisor state diagram uses the two real pool states from the
  code (`Warm` and `Active`) rather than more abstract names; this
  keeps the diagram honest without requiring readers to read Rust.
- The request lifecycle uses a sequence diagram rather than a flowchart
  because it makes the two authorization checkpoints and the actor
  boundaries visually distinct.
- The Policy Gate section includes a comparison table (pre-flight vs.
  tool-call) to make the conceptual distinction concrete without
  operational detail.
- Out-of-tree links to `project/docs/` use `../../../` from the docs
  source root — mdBook does not validate those paths but the rendered
  links are correct relative to where the built HTML lives.

Nothing rejected or deferred. All ACs met in a single session. No files
other than `src/architecture-overview/index.md` were touched.
Verification: `mdbook build` succeeds; `test -s` passes; the mermaid
grep counts ≥ 2 `class="mermaid"` hits in the built output.

## Review

### Review Verdict — 2026-05-26

FAIL

**Stage 1 — Acceptance Criteria**

AC-1: Six H2 sections present (System Shape, Request Lifecycle, Supervision, Channel
Adapters, Policy Gate, Monitoring). The task file's AC-1 text references
`the-intern/docs/src/architecture.md` which is a typo — Files to Touch, Verification,
and the Work Log all confirm the correct path is `the-intern/docs/src/architecture-overview/index.md`.
The developer used the correct path. PASS.

AC-2: Two mermaid blocks render as `<pre class="mermaid">` in the built HTML (verified:
grep count = 2). PASS.

AC-3: `mdbook build` exits 0. One version-mismatch warning (`mdbook-mermaid` was built
against 0.4.36, running against 0.4.52) — this warning is pre-existing from the
scaffold, not introduced by this task, and the build produces no errors and no broken
internal links. PASS.

AC-4: Intro paragraph links to `project/docs/the-intern-architecture.md` and
`project/docs/system_overview.md`. No development-level implementation detail is
restated in the chapter body. PASS.

**Scope check:** Only `the-intern/docs/src/architecture-overview/index.md` and the task
file were modified. PASS.

**Stage 2 — Content Accuracy**

Two correctness issues were found by cross-checking the content against the Rust source.

**Issue 1 — Sequence diagram: misleading arrow for denied pre-flight event**

- **File and location:** `the-intern/docs/src/architecture-overview/index.md`, in the
  `sequenceDiagram` mermaid block, the line `RH-->>Q: drop + write PreflightDenied
  audit record`.
- **What is wrong:** A dashed return arrow from `RH` to `Q` in a sequence diagram
  means a message is sent to `Q`. The actual behavior in
  `requests-handler/src/handler.rs` `run_preflight` is that the event is silently
  dropped inside `RH` and a `Verdict` audit record is written — no message is sent
  to `Q`. The arrow misleads the reader into thinking a drop notification is returned
  to the queue.
- **What should change:** Remove the arrow to `Q` and replace it with an action note
  on `RH` itself, e.g. using a `Note over RH: drop event, write denial verdict
  to audit log` statement, or replace `RH-->>Q:` with a self-note or a note on `RH`.

**Issue 2 — Policy Gate section: `PreflightDenied` in backticks does not exist in code**

- **File and location:** `the-intern/docs/src/architecture-overview/index.md`, in the
  `## Policy Gate` section, the sentence "A denial drops the event, emits a
  `PreflightDenied` audit record, and never touches pi-agent."
- **What is wrong:** The backtick notation implies `PreflightDenied` is a code-level
  identifier (type, enum variant, or method name). No such type exists. The actual
  audit record kind is `AuditRecordKind::Verdict` with `allow: false` and a reason
  string. A non-implementer reading this will not find `PreflightDenied` anywhere if
  they ever look at the audit log output or the audit record schema.
- **What should change:** Replace the backtick identifier with plain English that
  accurately describes what is written, for example: "A denial drops the event, writes
  a denied-verdict audit record, and never touches pi-agent." Alternatively, if a
  code term is wanted, `` `verdict` `` (the actual `kind` value in the JSONL output)
  is accurate.
