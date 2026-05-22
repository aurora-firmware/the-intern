# AI Review Report — Deferred Architecture Items

**Updated:** 2026-05-22

This report now tracks only review findings that are deliberately deferred and
not yet planned in a task, bug, spec, or ADR. Items from the original audit that
were fixed, became obsolete, or are now tracked by T-073 through T-076 have been
removed from this report.

---

## F1 — Composition Root Extraction

**Issue:** `bob::serve::try_start_subsystems` is the whole runtime composition
root. It starts and wires every subsystem, builds adapters, binds sockets, and
owns startup/shutdown coupling.

**Impact:** Each new subsystem or cross-cutting concern increases the size and
blast radius of `serve.rs`. Startup failures, adapter ownership, and shutdown
ordering become harder to reason about because composition policy and CLI-facing
serve flow live together.

**Why it is an issue:** The function is not wrong today, but it is trending
toward a God function. The codebase already has enough subsystems that runtime
assembly deserves its own boundary before the next major expansion.

**Suggested action:** Defer until runtime wiring changes again. When resumed,
write an ADR deciding whether the boundary is a new `bob-runtime` crate or
`bob/src/runtime/`, what API `serve.rs` calls, and whether shutdown orchestration
moves with startup composition.

---

## F2 — SessionPool Responsibility Split

**Issue:** `pi_agent_supervisor::SessionPool` owns worker spawning, warm-pool
policy, session registry state, prompt JSON-RPC I/O, and idle/surplus reaping.

**Impact:** The pool actor serialises operations that may not need to block each
other, especially prompt I/O. Tests also have to exercise high-level pool
semantics through real worker processes because lifecycle, registry, and RPC
protocol are not separable.

**Why it is an issue:** The current design is acceptable while supervisor
behaviour is simple, but it will become brittle if prompt routing, worker
lifecycle, or concurrent session handling grows.

**Suggested action:** Defer until supervisor concurrency or lifecycle work is
active. When resumed, write an ADR defining boundaries for `WorkerLifecycle`,
`SessionRegistry`, and `WorkerRpc`, including the intended concurrency model for
`send_prompt`.

---

## F3 — Subscription Bus Extraction

**Issue:** `admin-rpc::subscriptions` contains a reusable fan-out bus, but it is
owned by the admin-rpc crate and named around that transport.

**Impact:** A second transport or subsystem that needs subscription fan-out would
either depend on admin-rpc internals or duplicate bus logic.

**Why it is an issue:** The bus is generic enough to be shared, but extracting it
before another consumer exists would add crate/API surface without proving the
right abstraction.

**Suggested action:** Defer until a second consumer needs fan-out subscription
semantics. At that point, create a small extraction task or ADR for a
`subscription-bus` crate with transport-neutral naming.

---

## ServiceError Tier Split

**Issue:** `bob_core::error::ServiceError` mixes domain errors
(`PolicyDenied`, `InvalidRequest`, `Persistence`) with runtime and transport
errors (`Shutdown`, `Timeout`, `ServiceDown`, `ChildProcess`, `Configuration`,
`NotImplemented`).

**Impact:** Callers such as admin-rpc JSON-RPC mapping and the CLI must infer
which errors are user/domain outcomes and which are infrastructure failures.
That makes public error mapping easier to skew as new variants are added.

**Why it is an issue:** A single enum was pragmatic early on, but the system now
has enough transport surfaces that error taxonomy is part of the public contract.
Changing it without a decision record would risk inconsistent mappings across
admin-rpc, CLI, monitoring, and subsystem APIs.

**Suggested action:** Defer until error handling needs a broader change. When
resumed, write an ADR defining domain vs runtime/transport tiers, mapping rules
for JSON-RPC and CLI output, and a migration path for existing
`ServiceResult<T>` signatures.
