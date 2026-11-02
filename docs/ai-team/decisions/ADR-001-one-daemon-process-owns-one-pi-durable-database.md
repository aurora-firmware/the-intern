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

S-004 adds the job record. On 2026-11-02 the product owner chose to keep it in the-intern's own SQL tables, named
`intern_…`, in the instance's one SQLite file beside pi-durable's tables, with a job schema version and migrations of
its own, and not in pi-durable document families. The job record must outlive pi-durable's stored format, which has no
compatibility promise, and must be indexed and readable with standard SQLite tools (S-004 Alternatives Considered).
This record was first written for a file that only pi-durable writes, and the choice meets it at three points:

- **One file, two schemas.** pi-durable 1.4.0 `SqliteStorage.open(db)` takes a database the host opens itself. It
  names its tables from a prefix (none by default) and keeps its schema version in its own `durable_schema` table, so
  other tables can live in the same file. It closes that database when the harness closes.
- **Two commits per change.** `SqliteStorage.commit` runs every pi-durable commit in a transaction of its own, and a
  host `Tx` can't carry a table write of the-intern's. A job write and the pi-durable change it goes with (a lead
  conversation started, parked or aborted) are therefore two commits, and a crash can fall between them.
- **Export and import.** The job record leaves the instance as a copy of the whole file (S-004 REQ-016), and an
  import step outside the daemon places such a copy while the daemon is stopped (S-004 REQ-017).

Sources: S-002 Design Principles, REQ-001, REQ-007, REQ-008, REQ-009, REQ-010 and Exclusions; S-001 Definitions (worker
thread), REQ-008, REQ-019, REQ-010, REQ-020 and REQ-017; S-004 Design Principles, Alternatives Considered, REQ-001,
REQ-006, REQ-016 to REQ-018 and REQ-020; `docs/research/pi-durable-knowledge.md` (sections 1.4, 5.5 and 7.2);
`docs/development/coding_guidelines.md` (Module structure); `src/host/invocation.ts`, `src/host/reports.ts`,
`src/host/steering.ts` and `src/host/host_observation.ts` (`watchConversationMeta`); T-084 and T-085; pi-durable 1.4.0
`dist/storage/sqlite/storage.js` (`SqliteStorage.open`, `commit`, `close`) and `dist/storage/sqlite/schema.js`; chord
`dist/sqlite/node.js` (`NodeSqliteDatabase`, one queue of operations and transactions per connection).

## Decision

The Intern is one daemon process that owns one pi-durable database, one SQLite file per instance, which also holds
the-intern's job store. pi-durable sits behind a narrow host module, and durability comes from pi-durable, not from
code of our own, apart from the two bounded exceptions in decision 4.

1. **One process, one database per instance.** An instance is one daemon with its state directory. Its database is
   a single SQLite file in that state directory and holds every conversation, entry, pi-durable task, submission and
   document, plus the daemon's own state as documents, and the job store. Nothing but the daemon reads or writes it,
   apart from the import step below; clients read history and jobs through the service layer. A second daemon for the
   same instance is refused before it opens the database; a stale owner that is no longer alive is taken over (S-002
   REQ-001). A second instance, with its own state directory, is the only wall between sets of conversations.

   **The job store shares the file.**
   - The job record lives in the-intern's own tables, named with the prefix `intern_`, beside pi-durable's tables
     (S-004 REQ-001). The job schema version is kept in an `intern_` table, never in the file's `user_version`
     header, and the job store migrates only its own tables, forward. The job store never reads or writes
     pi-durable's tables, and no job fact is kept in a pi-durable document.
   - The file has one connection. The host opens the database file, owner-only, and gives the same database handle
     to pi-durable (`SqliteStorage.open(db)`) and to the job store, so every job store transaction waits in that
     connection's one queue with pi-durable's commits. Nothing opens a second connection to the file. The job store
     reaches the handle through the host's own interface and imports no pi package (decision 2).
   - A job store write never runs inside a pi-durable commit, and a pi-durable commit never runs inside a job store
     transaction. The shared queue waits for the open transaction, so the inner call would never settle.
   - At startup step 4 (S-002 REQ-002), the host reads the job schema version before pi-durable opens the file,
     because pi-durable may migrate its own schema in place and that can't be undone. A newer job schema stops
     startup and leaves the file unchanged. pi-durable then opens the file, and the job store creates or migrates
     its tables.

   **Export and import copy the whole file.**
   - `jobs.export` writes a consistent copy of the whole database to a new path, owner-only, through SQLite's online
     backup on the daemon's connection, while work goes on (S-004 REQ-016).
   - The import step is a separate process, run while the daemon is stopped (S-004 REQ-017). It holds the
     instance's single-owner lock while it runs, so a daemon that starts meanwhile is refused (S-002 REQ-001). It
     places the copy as the database file, owner-only, and only where no database file and no `-wal` or `-shm` file
     exists. It is the only writer of the file other than the daemon.
   - A copy is taken at a moment that may fall between a job write and its pi-durable change, so the first start on
     an imported copy repairs it as after a crash (decision 4).
   - Export and import move the file; they don't convert it. A version opens an imported copy only when its
     pi-durable can open the file and the copy's job schema isn't newer than its own.
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
   from pi-durable. The daemon writes no retry loops, intake tables or recovery code of its own, except for the two
   bounded exceptions below. Each fact the daemon owns about a conversation is committed in the same atomic commit as
   the change it describes; a job write can't be, so the second exception orders it instead. The host sets
   pi-durable's `settings.restartLimit` to `Infinity`, so every start resumes every unfinished pi-durable task, however
   often a crash cut it off, as S-002 REQ-008 requires. A finite limit, which parks a task until `Harness.retryTask()`,
   needs an S-002 amendment first.

   **First bounded exception: the-intern's own facts about a conversation, and redelivery from them.**
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

   **Second bounded exception: ordered job writes, and four repair rules.**
   - A job write and the pi-durable change it goes with are two commits (Context). The daemon commits the job write
     first and makes the pi-durable change after it: a job is written before its lead conversation starts (S-001
     REQ-012), a block before the lead conversation parks, and a complete or cancel before the job's conversations
     are aborted (S-004 REQ-018).
   - Input to a Blocked job's lead goes the other way. It reaches the lead conversation first, as a held message or a
     pi-durable input, and the job resumes after it (S-004 REQ-006).
   - The start action needs no repair. It is written when the lead's first run takes a worker thread, before its
     first model request; after a crash before that write, the run resumes, takes a worker thread again and writes it.
   - At startup, after admission is restored and before work resumes (S-002 REQ-002 step 7), the daemon applies
     exactly the four repair rules of S-004 REQ-018, and no other recovery to jobs:
     1. A job whose start is missing or was cut short gets its start completed: a job that isn't Done and has no
        lead conversation, or a To do job whose lead conversation holds no submission with request id
        `lead:<jobId>`, gets its lead conversation started and its first input submitted.
     2. A Blocked job whose lead conversation isn't parked gets it parked.
     3. A job whose lead conversation holds input it hasn't taken since the job blocked (queued input, or held
        messages), or has taken input since the job blocked (an input entry in its transcript after the entry the
        block recorded), is set In progress if it is still Blocked, with the Blocked reason cleared, and the lead
        continues with that input.
     4. A Done job whose conversations still run, are parked or await a report gets them aborted.
   - The block records the ID of the lead conversation's newest transcript entry in the job's internal
     `blockedAfterEntry`, in the same write as the status change, and the resume clears it the same way (S-004
     REQ-006, Interfaces). An input entry is an entry of kind `pi.user`, or one of the input entry kinds the daemon
     submits (the steer record and the ADR-004 kinds). Rule 3 reads the lead's transcript newest first, back to the
     recorded entry. This is pi-durable's own order, the same read `src/host/reports.ts` `readLastAnswer` makes. It
     decides whether the rule applies and rebuilds no job field.
   - Creating the lead conversation and submitting its first input are two pi-durable commits; pi-durable can't
     submit input in the creation commit. For each To do job whose lead conversation is known, rule 1 reads whether
     pi-durable holds a submission with request id `lead:<jobId>` for that conversation
     (`src/host/conversation_control.ts` `hasSubmissionWithRequestId`). This read decides whether the rule applies
     and rebuilds no job field. It runs only for To do jobs, so a startup doesn't read the conversations of every job
     the instance has run.
   - Each repair is written to the job's history with the daemon as author, and each is safe to repeat. Rule 1 calls
     S-001 REQ-012 with the job ID as its idempotency key and `lead:<jobId>` as the first input's request id, so a
     start that a crash cut short returns the conversation it created and submits nothing twice. A repeated park, or
     a repeated abort, changes nothing.
   - After the four rules, and still before work resumes, the daemon checks S-004 REQ-008's turn-end rule for each
     In progress job whose lead is idle and waits for nothing. It is the rule a lead's turn end runs, applied to saved
     state, so a crash between the end of a lead's turn and the daemon handling it loses nothing; it isn't a fifth
     repair rule (product owner decision, 2026-11-02).
   - A reminder is spent when pi-durable holds its input. The reminder's request id is `reminder:<jobId>:<n>`, where
     `n` counts the job's blocks and resumes in its history, so whether it is spent survives a restart without a fact
     of its own, and a repeated check submits it once.
   - Nothing else is allowed: no rule that rebuilds job fields from conversation state, no retry of a failed job
     write, and no timer that checks jobs. A fifth rule, another startup check, or a new pairing of a job write with a
     pi-durable change that the four rules don't repair, amends this decision first.
5. **A storage error ends the process.** When a storage error closes the harness, the daemon logs it, stops accepting
   calls and exits with a non-zero status within the 10-second stop bound. It never reopens the database itself. The
   operating system's supervisor (systemd on Linux, launchd on macOS) restarts it, and unfinished work resumes from its
   last checkpoint (S-002 REQ-004, REQ-007). An error from the daemon's own `commit()` or `mintId()` calls is a storage
   error like any other: the service operation that made the call fails, and the daemon exits. It never handles that
   error as an ordinary operation failure and carries on. A failed job store write is a storage error too (S-004
   REQ-020): its transaction rolls back, the operation or tool call fails with `internal`, and the daemon closes the
   harness and exits the same way. The daemon learns that the harness failed from `harness.closed`; `onReport`
   reports, typed by `ReportInfo` since 1.4.0, are diagnostics that it logs, not the exit trigger.

## Consequences

### Positive

- One source of truth: every conversation, pi-durable task, job and daemon-owned fact lives in one database with one
  writer, so there is no locking or merging between processes.
- A crash or kill is a resume, not a loss: work restarts from pi-durable's checkpoints. The daemon's own recovery is
  limited to redelivery from its own facts, which pi-durable request ids make safe to repeat, to the four job repair
  rules, and to checking the turn-end rule at startup.
- The job record is in plain SQL tables of its own: indexed, readable with standard SQLite tools, and independent of
  pi-durable's stored format. One file holds the whole instance, so one copy backs it up or moves it.
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
- Every job action that pairs a job write with a pi-durable change has a crash window between its two commits. The
  four repair rules are code of our own that only a crash exercises, and each needs a test that injects the crash
  between the two writes (S-004 AC-018.1).
- The startup check of S-004 REQ-008 is more job code that only a crash exercises; it needs the kill test of S-004
  AC-008.4, which kills the daemon at the end of a lead's turn.
- Job store transactions share one connection queue with pi-durable's commits, so a slow job store transaction delays
  every agent run that commits meanwhile.
- An imported copy opens only on a version whose pi-durable can read the file. Export and import don't carry the job
  record across a pi-durable format change that a newer pi-durable can't open.

### Neutral

- Storage only grows; retention and archiving of old conversations are a later decision.
- No database is converted between versions. An upgrade opens the same file: pi-durable may migrate its own schema in
  place, and that can't be undone, and the job store migrates its tables forward. An upgrade that may need to go back
  exports the database before the new version first opens it, and goes back by importing that copy into an instance
  of the old version (S-004 REQ-016, REQ-017).
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

### Alternative G: The job record in pi-durable document families

**Description:** Keep jobs, counters, worklogs and history as pi-durable documents, written in the same commits as
the conversation changes they go with.
**Rejected because:** The product owner rejected it on 2026-11-02 (S-004 Alternatives Considered). It is atomic and
needs no repair rules, but the job record would be stored in pi-durable's format, which has no compatibility promise,
couldn't be indexed or read with standard SQLite tools, and every filter would scan a whole family.

### Alternative H: A second SQLite file for the job store

**Description:** Keep the `intern_` tables in a file of their own in the state directory.
**Rejected because:** Two files can't be copied consistently with each other while work goes on, so an export would
need a pause or a second repair. One file keeps one owner lock, one copy and one place to back up.

### Alternative I: A second connection to the same file

**Description:** Let the job store open its own connection to the database file.
**Rejected because:** Two connections contend for SQLite's write lock: pi-durable's `BEGIN IMMEDIATE` and the job
store's would wait on each other's busy timeout instead of queueing in call order, and a harness close would leave the
second connection open. One shared handle orders every transaction and closes with the harness.

## Amendments

| Date | Change | Reason |
|---|---|---|
| 2026-10-30 | Clarified for pi 1.4.0: storage errors from `commit()` and `mintId()` (Context, decision 5); the crash-loop guard is turned off with `settings.restartLimit: Infinity` (Context, decision 4, Negative); the one-way SQLite schema migration (Context, Neutral); `onReport` reports are logged diagnostics (decision 5). Fixed the coding-guidelines path in Sources. No decision changes. | Architecture consistency review of ADR-001 against the pinned pi 1.4.0 packages, S-000, S-001, S-002 and ADR-002. |
| 2026-11-01 | Added a bounded exception to decision 4: the-intern's own facts about a conversation (`held`, `awaiting`, the creation keys in `intern.invocations` and `intern.idempotency`) live in its own documents, written in the commit that changes them, and the only recovery is redelivery worked out from them, made safe to repeat by pi-durable request ids (Context, Sources, decision 4, Positive, Negative, Alternative F). | Spec-truth reconciliation of S-001, finding F6: T-071, T-073 and T-075 built these facts and this redelivery, and the work is right. |
| 2026-11-01 | Decision 4: named the parked state (`parked`) among the-intern's facts; added the abort mark (`aborted`), set in the abort's own commit on a lone abort of an awaited invoked conversation, and the redelivery of the "aborted" report it drives, started also by the commit that sets the mark; an "aborted" report reuses the last answer's report id, or `report:<invokedId>:aborted`; an abort's commit clears held messages and awaiting links without admitting them (Context, Sources, decision 4, Negative). | S-001 v0.3 R-8 and R-8a and product owner decision F3: a lone abort reports "aborted" to the invoker, a cascade reports nothing, and an abort withdraws held messages. Needed by T-084 and T-085. |
| 2026-11-02 | Decision 1: the job store's `intern_` tables share the instance's SQLite file and its one connection; the job schema version is read before pi-durable opens the file; export copies the whole file, and the import step places a copy while the daemon is stopped, under the single-owner lock, without converting it. Decision 4: a second bounded exception, ordered job writes and the four startup repair rules of S-004 REQ-018, with input to a Blocked job's lead as the one change that comes before its job write. Decision 5: a failed job store write is a storage error (Context, Sources, preamble, decisions 1, 4 and 5, Positive, Negative, Neutral, Alternatives G to I). | S-004 architecture consistency review. Product owner decision of 2026-11-02: the job record lives in the-intern's own tables in the same file, not in pi-durable documents, and export and import copy the whole file. Pinned pi-durable 1.4.0 runs each commit in its own transaction, so a job write can't join it. |
| 2026-11-02 | Decision 4: after the four repair rules, the daemon checks S-004 REQ-008's turn-end rule for each In progress job whose lead is idle and waits for nothing, as the same rule applied to saved state, not a fifth rule; a reminder is spent when pi-durable holds its input, whose request id `reminder:<jobId>:<n>` makes the check safe to repeat. Negative: the open turn-end gap is replaced by the kill test of S-004 AC-008.4. | Product owner decision of 2026-11-02 on the S-004 escalation (option A), applied in S-004 v0.2 REQ-008 and REQ-018. |
| 2026-11-02 | Decision 4, second bounded exception: rule 3 also covers a lead that has taken input since the job blocked, shown by an input entry (`pi.user`, the steer record or an ADR-004 kind) in its transcript after the entry the block recorded in the job's internal `blockedAfterEntry`; the block sets it and the resume clears it in the same write. Rule 3 reads the transcript newest first, back to that entry, as `readLastAnswer` does; it decides whether the rule applies and rebuilds no job field. Matches S-004 v0.4 REQ-006, REQ-018 and Interfaces. | T-129 F1 escalation: an answer the lead took after its park was cleared, before the resume was written, left the job Blocked with no rule to repair it. Architect escalation review; product owner decision of 2026-11-02 (option A). |
| 2026-11-02 | Decision 4, second bounded exception: rule 1 also covers a To do job whose lead conversation holds no submission with request id `lead:<jobId>`, and completes the start; the startup read of that submission, made only for To do jobs with a known lead, decides whether the rule applies and rebuilds no job field. Matches S-004 v0.5 REQ-018 and AC-018.2. | PR 147 review, finding 4: a crash after the lead conversation is created and before its first input left the job To do with no agent working on it. pi-durable can't submit input in the creation commit. Product owner decision of 2026-11-02 (option A); an upstream pi-durable change and accepting the gap were rejected. |
