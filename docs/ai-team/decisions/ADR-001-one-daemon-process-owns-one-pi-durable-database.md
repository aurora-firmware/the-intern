---
id: ADR-001
title: One daemon process owns one pi-durable database
status: accepted
created: '2026-10-30'
---

# ADR-001: One daemon process owns one pi-durable database

## Context

The Intern runs many jobs unattended, and an interrupted job must pick up where it stopped (S-000). pi-durable gives
checkpointed tasks, resume, exactly-once admission by request id and durable queued input, with firm limits: one
process owns a storage and nothing locks across processes, a storage error closes the harness, nothing caps active
runs, and its API and schema change between releases (`docs/research/pi-durable-knowledge.md`, sections 1.4 and 5.5).

Some facts belong to the-intern and have no place in pi-durable: messages held for a parked conversation, the reports a
conversation still awaits, creation keys and similar marks (S-001 REQ-017, REQ-019, REQ-020). The job record lives in
the-intern's own SQL tables in the same file, by the product owner's choice of 2026-11-02 (S-004 REQ-001). pi-durable
runs each commit in its own transaction, so a job write and the pi-durable change it goes with are two commits, and a
crash can fall between them.

## Decision

The Intern is one daemon process that owns one SQLite file per instance, holding pi-durable's tables and the job
store. pi-durable sits behind a narrow host, and durability comes from pi-durable, apart from the two bounded
exceptions in decision 4.

1. **One process, one database per instance.** The file lives in the state directory, and nothing but the daemon reads
   or writes it, apart from the import step. A lock file in the state directory records the owner: a second daemon is
   refused before it opens the file, and a stale lock is taken over (S-002 REQ-001). A second instance, with its own
   state directory, is the only wall between sets of conversations.
   - The job store keeps its tables, prefixed `intern_`, and its own schema version in that file, and never touches
     pi-durable's tables. The host reads the job schema version before pi-durable opens the file, and a newer one stops
     startup with the file unchanged.
   - The file has one connection, shared by pi-durable and the job store, so their transactions queue in call order.
     Neither runs inside the other's transaction. The job store reaches the connection through the host's interface and
     imports no pi package.
   - `jobs.export` copies the whole file with SQLite's online backup while work goes on, and is the only way to copy
     it (S-004 REQ-016). The import step runs while the daemon is stopped, under the owner lock, places a copy only
     where no database, `-wal` or `-shm` file exists, and refuses a copy with a newer job or pi-durable schema (S-004
     REQ-017). Neither converts the file, and the first start on a copy repairs it as after a crash.
2. **pi-durable sits behind a narrow host.** Only the harness host module (`src/host/`) and the-intern's own pi-durable
   extensions import pi-durable, and no other extension is loaded. Every other component uses the host's interface.
   - Listener and client library code imports neither the host nor `pi-durable`, `pi-ai`, `chord` or
     `pi-coding-agent`. Listeners reach the daemon's state only through the catalogue, the feed and the lifecycle
     hooks. They import the daemon and feed modules only as types, and may load only the path layout,
     `src/daemon/state_layout.ts`. Daemon components use `pi-ai`, `chord` and `pi-coding-agent` where they need them.
   - The export route `GET /export` (S-003 REQ-016) adds no operation: it calls `jobs.export` through the catalogue into
     a folder of its own under the state directory's `exports` folder, sends the file and removes the folder. Its
     removal of leftovers at start touches no state the daemon resumes from, so it is no recovery under decision 4.
     `docs/development/architecture.md`, The export route, gives its refusals and clean-up.
   - The service layer knows no transport, so every operation can be called in-process (S-002 REQ-016).
3. **Worker threads are logical capacity slots.** One event loop runs every agent run, and one active run holds one
   worker thread. Their number, 32, is built in and changes only with a release (S-002 REQ-009). Work beyond it waits
   in a stored arrival order (S-002 REQ-010). CPU-heavy work runs in child processes.
4. **Durability belongs to the runtime.** Resume, exactly-once admission, queued input and checkpoints come from
   pi-durable. The daemon writes no retry loop, intake table or recovery of its own, except the two bounded exceptions
   below. The host sets `settings.restartLimit` to `Infinity`, so every start resumes every unfinished task (S-002
   REQ-008); a finite limit needs S-002 amended first.

   **First bounded exception: the-intern's own facts about a conversation, and redelivery from them.**
   - The facts are held messages (`held`), awaiting links (`awaiting`), the parked state (`parked`), the abort mark
     (`aborted`), the stop mark (`stopped`), the closed mark (`closed`) and the enabled set (`enabledSkills`) in the
     conversation's `intern.conversation` document, and creation keys in `intern.invocations` and `intern.idempotency`,
     the front desk's fixed key included. Each is written in the commit of the change it describes.
   - The abort mark records that an invoker is owed an "aborted" report. Only a lone abort of an awaited invoked
     conversation sets it, never a cascade or a job abort (S-001 REQ-019).
   - The stop mark holds the ID of the lead's newest transcript entry when a team member's abort, never a cascade,
     stops the lead of an In progress job that runs, has input queued, is parked or awaits a report. Nothing clears it.
     It is live until an input entry (`pi.user`, the steer record or an ADR-004 kind) follows that entry, and a live
     mark decides the turn-end rule first (S-004 REQ-008).
   - The closed mark records that the conversation's job is Done. The job's abort sets it on every conversation of the
     job, and nothing clears it. That commit also empties the conversation's pi-durable inbox, settling each item
     `unanswered`. Every operation and tool that would change a closed conversation refuses it, input included (S-001
     REQ-026, S-008 REQ-006), and no redelivery path submits input to one.
   - The enabled set holds the skills the agent has enabled. Every seat write resets it to the role's defaults in the
     same commit (S-008 REQ-006). One upgrade write at startup step 7 gives the documents written before S-008 their
     set, once; it is a conversion, not a recovery.
   - An abort's own commit, just before pi-durable's abort, sets its marks and withdraws the conversation's held
     messages, awaiting links and a park that waits for reports (S-001 REQ-008). A park that waits for an answer stays
     until the job's abort closes the lead.
   - Per job, one in-process serial section orders the job abort's closed-mark commits with every input admission,
     control operation and conversation creation of that job. It holds no input, so it orders and doesn't queue. The
     front desk has no job and takes no section: input from every way in shares its one transcript in the order
     pi-durable admits it, and the daemon adds no lock of its own (S-001 REQ-021).
   - The only recovery is redelivery of input the facts show as undelivered: held messages when the conversation
     continues, and the report or "aborted" report of each awaited conversation, at start and when a run ends or the
     mark's commit is published. Each redelivered input carries a request id fixed by the fact: the held message's own,
     `report:<invokedId>:<entryId>`, or `report:<invokedId>:aborted` when there is no last answer. A creation key turns
     a repeated creation into the conversation already created.
   - A fact is cleared only after its input is admitted, or by an abort's commit. A crash between an abort's commit and
     pi-durable's abort leaves the abort undone and safe to repeat; repair rule 4 finishes a job's abort.
   - A close that fails with the harness still open doesn't stop the job's aborts, and isn't retried: rule 4 sets the
     missing marks at the next start (S-004 REQ-007).
   - Nothing else: no retry, no timer, no list that holds input for a conversation that can take it, and no repair of
     pi-durable's state beyond the closed-mark commit's inbox removal (ADR-003) and the abort of a closed conversation's
     compaction. A new kind of fact or a new redelivery path amends this decision first.

   **Second bounded exception: ordered job writes, and four repair rules.**
   - The job write commits first and its pi-durable change after: a job before its lead starts, a block before the lead
     parks, a complete or cancel before the conversations close. Input to a Blocked lead goes the other way: it reaches
     the lead first, and the job resumes after it (S-004 REQ-006).
   - At startup step 7 the daemon applies exactly the four repair rules of S-004 REQ-018 and no other job recovery:
     1. A job whose start is missing or cut short gets it completed, with `lead:<jobId>` as its first input's request
        id.
     2. A Blocked job whose lead isn't parked gets it parked.
     3. A job that isn't Done whose lead holds input it hasn't taken since the job blocked, or has taken input since
        then, is set In progress and the lead continues. The block records the lead's newest entry id
        (`blockedAfterEntry`), and an input entry after it, as the stop mark defines it, shows input taken.
     4. A Done job with a conversation that isn't closed, or still runs, compacts or holds queued input, gets it closed
        and aborted.
   - The rules make no call that turns scheduling on, so they run before `host.resume()`. The inputs they owe are
     submitted after it, still within step 7. Each repair is written to the job's history and is safe to repeat.
   - After the rules, the daemon checks S-004 REQ-008's turn-end rule for each In progress job with an idle lead. It is
     the same rule applied to saved state, not a fifth rule. A reminder's request id is `reminder:<jobId>:<n>`, so a
     repeated check submits it once.
   - Nothing else: no rule that rebuilds job fields from conversation state, no retry of a failed job write, and no
     timer that checks jobs. The scheduler (S-007) is a job source, not such a timer. A fifth rule, another startup
     check, or a new pairing of a job write with a pi-durable change that the four rules don't repair amends this
     decision first.
5. **A storage error ends the process.** When a storage error closes the harness, the daemon logs it, stops taking
   calls and exits non-zero within the 10-second stop bound, and the supervisor restarts it (S-002 REQ-004, REQ-007).
   An error from the daemon's own `commit()` or `mintId()`, and a failed job store write (S-004 REQ-020), are storage
   errors too. The daemon never reopens the database itself. It learns that the harness failed from
   `harness.closed`; `onReport` reports are diagnostics it logs, not the exit trigger.

## Consequences

- One database with one writer is the single source of truth, and one file copy backs up or moves an instance.
- A crash is a resume. The daemon's own recovery is the redelivery, the four repair rules and the turn-end check, and
  each is code that only a crash exercises, so each needs a kill test (S-001 REQ-017, S-004 AC-018.1, AC-008.4).
- A pi upgrade touches only the host module and the-intern's extensions.
- One process runs every job: a runaway run or crashing extension pauses all of them until the restart, and blocking
  code delays every run.
- With the crash-loop guard off, a task that crashes the daemon on every resume keeps it in a restart loop.
- Without a supervisor, a storage error leaves The Intern stopped. Installation registers it (S-000).
- A slow job store transaction delays every commit queued behind it.
- No database is converted between versions; an upgrade that may need to go back exports first (S-004 REQ-016,
  REQ-017). Storage only grows.

## Alternatives Considered

- **One database per conversation or job:** rejected because it spreads a job over several stores and leaves no place
  for the daemon's own state.
- **Several processes or threads for agent runs:** rejected because pi-durable allows one owner per storage, and runs
  mostly wait on models and child processes.
- **Reopen the database or retry inside the daemon:** rejected because it duplicates pi-durable and the supervisor
  with recovery code that is hard to test.
- **pi-durable imported wherever it is needed:** rejected because every importing file would change with an upgrade.
- **A configurable worker-thread count:** rejected because a higher count runs untested (S-002 REQ-009).
- **Held messages and reports in pi-durable alone:** rejected because input to a parked conversation starts a run, and
  a live event can be lost to a crash (S-001 REQ-010, REQ-017).
- **The job record in pi-durable documents:** rejected by the product owner on 2026-11-02, because its format has no
  compatibility promise and can't be indexed or read with standard SQLite tools.
- **A second file, or a second connection, for the job store:** rejected because two files can't be copied
  consistently, and two connections contend for SQLite's write lock instead of queueing.
