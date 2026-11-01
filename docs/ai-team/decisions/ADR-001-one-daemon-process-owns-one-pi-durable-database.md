---
id: ADR-001
title: One daemon process owns one pi-durable database
status: accepted
created: '2026-10-30'
---

# ADR-001: One daemon process owns one pi-durable database

## Context

The Intern runs unattended on a machine the team keeps running and works on many jobs at once. Its work has to
survive crashes and restarts: a job that was interrupted picks up where it stopped (S-000, Solution overview).

The Intern embeds pi as a library on `@earendil-works/pi-durable`. pi-durable already provides what durability needs:
one open storage per harness, checkpointed pi-durable tasks, resume after a restart, exactly-once admission of input
through request ids, and durable queued input. It also has firm limits (`docs/research/pi-durable-knowledge.md`,
sections 1.4 and 5.5):

- One process owns a storage at a time, and there is no cross-process locking, so the host has to enforce single
  ownership itself.
- A storage error closes the harness; the host decides whether to exit or reopen. Since 1.4.0 this explicitly covers
  any error from `commit()` or `mintId()`, `StorageRequestError` included; only reads are exempt.
- It has no cap on how many agent runs are active at once.
- Since 1.4.0 a crash-loop guard parks a pi-durable task that a crash, eviction or reset cut off 5 times in a row
  without committing a new state (`settings.restartLimit`, default 5). A parked task doesn't run again until the host
  calls `Harness.retryTask()`. A close that fails to write its stopped tasks back counts as a cut-off too.
- Opening a database may migrate its schema in place, and the migration can't be undone: 1.4.0 moves SQLite to schema
  version 2, which 1.3.0 and older can't open.
- Its API changes between releases, so code that uses it directly is code an upgrade touches.

The product owner approved S-001 and S-002, which together fix the runtime shape. This record states that shape once,
so every later spec and task builds on the same decision. It is one of the standing decisions S-000 asks to record
before development starts (S-000, Developer documentation, Decisions needed).

Some facts about a conversation belong to the-intern, and pi-durable has no place for them. Building S-001 found
three (spec-truth reconciliation of S-001, finding F6):

- **Held messages.** A message for a parked conversation waits until it continues (S-001 REQ-020, REQ-019). It can't go
  to pi-durable's queued input: an input to a conversation that isn't running starts a run, and a parked
  conversation must hold no worker thread (S-001 REQ-010). The message waits in the `held` list of the conversation's
  `intern.conversation` document (T-075).
- **Awaiting links.** An invoking conversation lists in `awaiting` the invoked conversations whose report it still
  waits for (S-001 REQ-019, REQ-017). The daemon learns that an invoked run finished from a live event, which a crash
  can cut off before the report is submitted. The `awaiting` list is what tells the next start which report is still
  undelivered (T-073).
- **Invocation keys.** The `intern.invocations` document maps an invocation's request id to the conversation it
  created, written in the commit that creates or forks it, so a repeated invocation creates nothing twice (T-071).
  `intern.idempotency` does the same for service operations that create a conversation (S-002 REQ-013, T-034).

The same document also holds the conversation's parked state (`parked`, T-071), which report delivery and held
messages read to decide whether the conversation continues.

S-001 v0.3 adds one more need (REQ-008, REQ-019, product owner decision F3 of 2026-11-01). An invoked conversation
aborted on its own, not by a cascade from its invoker or by a job abort, sends its invoker an "aborted" report with its
last answer. When it was idle or parked, no run ends, so the live event that starts report delivery never comes. A crash
between the abort and the delivery must not lose the report (REQ-017). pi-durable records the abort, but not that it was
a lone one with a report owed (T-085). An abort also withdraws the aborted conversation's held messages and awaiting
links, as pi-durable abort withdraws queued input (REQ-008, T-084).

Sources: S-002 Design Principles, REQ-001, REQ-007, REQ-008, REQ-009, REQ-010 and Exclusions; S-001 Definitions (worker
thread), REQ-008, REQ-019, REQ-010, REQ-020 and REQ-017; `docs/research/pi-durable-knowledge.md` (sections 1.4, 5.5 and
7.2); `docs/development/coding_guidelines.md` (Module structure); `src/host/invocation.ts`, `src/host/reports.ts`,
`src/host/steering.ts` and `src/host/host_observation.ts` (`watchConversationMeta`); T-084 and T-085.

## Decision

The Intern is one daemon process that owns one pi-durable database, one SQLite file per instance. pi-durable sits
behind a narrow host module, and durability comes from pi-durable, not from code of our own.

1. **One process, one database per instance.** An instance is one daemon with its state directory. Its database is
   a single SQLite file in that state directory and holds every conversation, entry, pi-durable task, submission and
   document, plus the daemon's own state as documents. Nothing but the daemon reads or writes it; clients read
   history through the service layer. A second daemon for the same instance is refused before it opens the database;
   a stale owner that is no longer alive is taken over (S-002 REQ-001). A second instance, with its own state directory,
   is the only wall between sets of conversations.
2. **pi-durable sits behind a narrow host.** Only the harness host module and the-intern's own pi-durable extensions,
   shipped in the package, import pi-durable. The service layer and every other component depend on the host's
   interface. No other extensions are discovered or loaded at runtime.
3. **Worker threads are logical capacity slots.** The daemon is one operating-system process with one event loop. A
   worker thread is a slot in that process, not an operating-system thread or a worker process. One active agent run
   holds one worker thread. Their number is a built-in constant, 32, which no one can configure and which changes only
   with a release, after load tests (S-002 REQ-009). Work beyond it waits in arrival order, and that order is stored in
   the database so it survives a restart (S-002 REQ-010). CPU-heavy work runs outside the daemon process: tools run
   commands as child processes.
4. **Durability belongs to the runtime.** Resume, exactly-once admission of input, queued input and checkpoints come
   from pi-durable. The daemon writes no retry loops, intake tables or recovery code of its own, except for the
   bounded exception below. Each fact the daemon owns is committed in the same atomic commit as the change it
   describes. The host sets pi-durable's `settings.restartLimit` to `Infinity`, so every start resumes every
   unfinished pi-durable task, however often a crash cut it off, as S-002 REQ-008 requires. A finite limit, which parks
   a task until `Harness.retryTask()`, needs an S-002 amendment first.

   **Bounded exception: the-intern's own facts, and redelivery from them.**
   - Facts the-intern owns about a conversation live in its own pi-durable documents: held messages (`held`),
     awaiting links (`awaiting`), the parked state (`parked`) and the abort mark (`aborted`) in the conversation's
     `intern.conversation` document, and creation keys in `intern.invocations` and `intern.idempotency`. Each is
     written in the commit that changes it, together with the change it describes.
   - The abort mark records that a conversation's invoker is owed an "aborted" report (S-001 REQ-019). It is set only
     on the conversation an abort names, never on one a cascade or a job abort reaches, and only when the
     conversation was invoked and its invoker still awaits it. It is set in the abort's own commit: the one
     commit that, before pi-durable's abort, sets `parked` to `null` and empties `awaiting` and `held` (S-001 REQ-008).
     A document written without the field reads as not marked. The mark is spent once the invoker's `awaiting` no
     longer lists the conversation; it has no effect after that.
   - The only recovery the daemon does is redelivery worked out from those facts. The daemon submits the input the
     facts show as undelivered: a conversation's held messages when it continues; the report of each awaited
     conversation whose run has finished, at start and when its run ends; and the "aborted" report of each awaited
     conversation that carries the abort mark, at start, when its run ends, and when the commit that sets the mark is
     published. That last trigger delivers the report of an idle or parked conversation, which has no run to end.
     Report delivery hears those commits through `watchConversationMeta` and handles them in its one serial queue,
     like the end of a run; the abort itself never calls delivery. A creation key turns a repeated invocation or create
     operation into the conversation it already created.
   - Every redelivered input carries a request id fixed by the fact: the held message's own request id, or
     `report:<invokedId>:<entryId>` for a report, where the entry holds the invoked conversation's last answer. An
     "aborted" report uses the same id as the report of that last answer, or `report:<invokedId>:aborted` when the
     conversation has no last answer. A report admitted just before a lone abort, with a crash before `awaiting` was
     cleared, is therefore not delivered a second time as an "aborted" report. pi-durable's exactly-once admission
     makes a repeat harmless.
   - A fact is cleared only after its input is admitted, so a crash in between repeats the submission and loses
     nothing. The one other way a fact is cleared is an abort: its commit withdraws the conversation's held messages
     and awaiting links, as pi-durable abort withdraws queued input (S-001 REQ-008). A crash after that commit and
     before pi-durable's abort leaves the abort undone: the operation that asked for it fails, and repeating it is safe.
     The daemon doesn't finish the abort on its own.
   - Nothing else is allowed: no retry of a failed call, no timer that tries again, no list that holds input for a
     conversation that can take it, and no repair of state pi-durable owns. A new kind of fact or a new redelivery
     path amends this decision first.
5. **A storage error ends the process.** When a storage error closes the harness, the daemon logs it, stops accepting
   calls and exits with a non-zero status within the 10-second stop bound. It never reopens the database itself. The
   operating system's supervisor (systemd on Linux, launchd on macOS) restarts it, and unfinished work resumes from its
   last checkpoint (S-002 REQ-004, REQ-007). An error from the daemon's own `commit()` or `mintId()` calls is a storage
   error like any other: the service operation that made the call fails, and the daemon exits. It never handles that
   error as an ordinary operation failure and carries on. The daemon learns that the harness failed from
   `harness.closed`; `onReport` reports, typed by `ReportInfo` since 1.4.0, are diagnostics that it logs, not the exit
   trigger.

## Consequences

### Positive

- One source of truth: every conversation, pi-durable task and daemon-owned fact lives in one database with one
  writer, so there is no locking or merging between processes.
- A crash or kill is a resume, not a loss: work restarts from pi-durable's checkpoints. The daemon's own recovery is
  limited to redelivery from its own facts, and pi-durable request ids make it safe to repeat.
- An upgrade of the pi packages touches a few files: the host module and the-intern's extensions.
- The number of active agent runs is bounded and visible, including during recovery after a restart.
- The whole daemon, with kills and restarts, can be tested in one process on a fake model.

### Negative

- One process runs every job. A runaway agent run or a crashing extension stops all of them until the supervisor
  restarts the daemon. The restart resumes the work, but every job pauses.
- Tools and hooks share one event loop: code that blocks it, or ignores its abort signal, delays every agent run and
  can hold up shutdown until the stop bound forces an error exit.
- Admission is the daemon's own work, because pi-durable has no concurrency cap; it has to gate the runs that resume
  after a restart as well as new ones.
- The daemon depends on a supervisor being set up; without one, a storage error leaves The Intern stopped.
- The worker-thread count can't be tuned per machine; changing it takes a release.
- With pi-durable's crash-loop guard turned off, a pi-durable task that crashes the daemon each time it resumes keeps
  the daemon in a restart loop, stopping every job, until someone stops the service or removes the cause.
- Redelivery from the-intern's own facts is code of our own that a crash exercises: report delivery at start and the
  delivery of held messages need kill tests (S-001 REQ-017), and each new kind of fact needs this record amended.
- An abort that a crash cuts off after its commit and before pi-durable's abort leaves the abort mark set on a
  conversation that wasn't aborted. If no one repeats the abort, a running conversation resumes, and when its run ends
  its invoker gets an "aborted" report with that run's last answer.

### Neutral

- Storage only grows; retention and archiving of old conversations are a later decision.
- The database isn't carried across pi-durable versions; the job record moves to a new version by export and import
  (S-000). pi-durable itself may migrate an older database when a newer version opens it, and that migration can't be
  undone, so an upgrade that may need to go back has to export the job record before the new version first opens the
  database.
- Installation owns registering the daemon with the supervisor (S-000, Installation and service setup).

## Alternatives Considered

### Alternative A: One database per conversation or job

**Description:** Open one harness and one SQLite file per session, as `durable-pi` does.
**Rejected because:** It spreads one job's conversations over several stores, needs a registry of stores, and gives
no single place for the daemon's own state. S-001 fixes one database per instance (S-002 Exclusions).

### Alternative B: Several processes, or operating-system threads, per agent run

**Description:** Run agent runs in worker processes or operating-system threads that share the database, or each own
part of it.
**Rejected because:** pi-durable allows one owner per storage and has no cross-process locking. Agent runs are mostly
waiting on models and child processes, so one event loop carries them; CPU-heavy work already runs in child processes.
Separate workers stay an option only if measurements show the need (knowledge base, section 5.5).

### Alternative C: Reopen the database or retry inside the daemon

**Description:** On a storage error, reopen the harness in the same process, and add retry loops or intake tables to
cover failures.
**Rejected because:** It duplicates what pi-durable and the supervisor already give, and adds recovery code that is
hard to test. Exiting and letting a fresh start resume the work uses one recovery path for every failure.

### Alternative D: Use pi-durable directly wherever it is needed

**Description:** Let the service layer, job sources and other components import pi-durable.
**Rejected because:** pi-durable's API changes between releases, and every importing file would change with an
upgrade. The narrow host keeps that change to a few files.

### Alternative E: A configurable worker-thread count

**Description:** Let a team member set the number of worker threads in the configuration file.
**Rejected because:** 32 is the most concurrent agent runs the daemon is tested with; a higher setting would run
untested, and the count is not a team decision (S-002 Exclusions, REQ-009). Tests use a test-only switch for a smaller
count.

### Alternative F: Keep held messages and undelivered reports in pi-durable alone

**Description:** Submit a message for a parked conversation as pi-durable queued input at once, and deliver a report
only from the live event that an invoked run finished.
**Rejected because:** An input to a conversation that isn't running starts a run, so a parked conversation would take
a worker thread and continue before its report arrives (S-001 REQ-019, REQ-010). A live event isn't durable: a crash
between the run's end and the report's submission would lose the report, which S-001 REQ-017 forbids.

## Amendments

| Date | Change | Reason |
|---|---|---|
| 2026-10-30 | Clarified for pi 1.4.0: storage errors from `commit()` and `mintId()` (Context, decision 5); the crash-loop guard is turned off with `settings.restartLimit: Infinity` (Context, decision 4, Negative); the one-way SQLite schema migration (Context, Neutral); `onReport` reports are logged diagnostics (decision 5). Fixed the coding-guidelines path in Sources. No decision changes. | Architecture consistency review of ADR-001 against the pinned pi 1.4.0 packages, S-000, S-001, S-002 and ADR-002. |
| 2026-11-01 | Added a bounded exception to decision 4: the-intern's own facts about a conversation (`held`, `awaiting`, the creation keys in `intern.invocations` and `intern.idempotency`) live in its own documents, written in the commit that changes them, and the only recovery is redelivery worked out from them, made safe to repeat by pi-durable request ids (Context, Sources, decision 4, Positive, Negative, Alternative F). | Spec-truth reconciliation of S-001, finding F6: T-071, T-073 and T-075 built these facts and this redelivery, and the work is right. |
| 2026-11-01 | Decision 4: named the parked state (`parked`) among the-intern's facts; added the abort mark (`aborted`), set in the abort's own commit on a lone abort of an awaited invoked conversation, and the redelivery of the "aborted" report it drives, started also by the commit that sets the mark; an "aborted" report reuses the last answer's report id, or `report:<invokedId>:aborted`; an abort's commit clears held messages and awaiting links without admitting them (Context, Sources, decision 4, Negative). | S-001 v0.3 R-8 and R-8a and product owner decision F3: a lone abort reports "aborted" to the invoker, a cascade reports nothing, and an abort withdraws held messages. Needed by T-084 and T-085. |
