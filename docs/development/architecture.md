# Architecture

A high-level map of how The Intern fits together at runtime and which spec owns each part. It restates no
requirements: the specs and the accepted ADRs are the source of truth, and where this page differs from them, fix this
page. Read [S-000](../ai-team/specs/S-000-system-overview.md) for scope. The shared vocabulary and the spec map are in
[system_overview.html](../system_overview.html) (sections 4 and 5), and are not repeated here. The module rule comes
from the [coding guidelines](coding_guidelines.md).

## Runtime shape

The Intern is one daemon process (`bob serve`) that owns one pi-durable database, one SQLite file in the instance's
state directory ([S-002](../ai-team/specs/S-002-daemon-and-host-runtime.md), [ADR-001](../ai-team/decisions/ADR-001-one-daemon-process-owns-one-pi-durable-database.md)).
Nothing else reads or writes that file. The operating system's supervisor starts the daemon and restarts it after an
error exit, and unfinished work resumes from its checkpoints.

```
 ways in: command line (local) · web interface (network) · email
        │                                job sources: schedules, triggers
        ▼                                          │
   listeners ──────────────┐                       │
                           ▼                       ▼
 ┌─ daemon process ─────────────────────────────────────────────────┐
 │  service layer (read and control operations) ◄── agent tools     │
 │        │                                  │                      │
 │        ▼                                  ▼                      │
 │  admission (worker threads)        observation feed ──► clients  │
 │        │                                                         │
 │        ▼                                                         │
 │  harness host + the-intern's pi-durable extensions ──► models    │
 └───────────────────────────────┬──────────────────────────────────┘
                                 ▼
                      one pi-durable database
```

- **Service layer.** Every capability is a named read or control operation. Listeners, job sources and agent tools all
  call the same operations, and the layer knows nothing about transports, so adding a listener changes no operation
  (S-002).
- **Listeners.** A local one for the command line and a network one for the web interface. They belong to the Intern
  service and are defined in the control-endpoint spec (S-003, not written yet). No listener authenticates callers
  (ADR-002).
- **Observation feed.** The one source of live data for clients: a snapshot, then deltas. A client that is slow or
  gone never affects an agent run (S-002).
- **Worker threads.** A worker thread is a logical slot for one active agent run, not an operating-system thread. The
  count is fixed, and work beyond it waits in a stored arrival order (S-001, S-002, ADR-001).
- **Jobs and conversations.** Work is organised as jobs. Each job has one lead conversation whose current agent is
  the job's lead. Roles are the configuration agents are made from; a seat is a role's place in a conversation. The
  lead can hand its conversation to an agent of another role, or invoke agents of specialist roles in conversations of
  their own that report back (S-001).
- **Failure.** A storage error closes the harness; the daemon exits non-zero rather than reopening the database
  (S-002, ADR-001).

## Components and owning specs

The components are those of S-000, Components, Solution. This table gives the responsibility in one line and the spec
that defines it.

| Component | Responsibility | Spec |
|---|---|---|
| Intern service | The one long-running process: saved state, many jobs at once, resume after a restart, models, the shared operations, the feed, the listeners | S-002 (process, service layer, feed); S-003 (listeners, planned) |
| Agents and roles | Roles, seats, the lead and handoff, invoking specialist agents, monitoring of who works on what | S-001 |
| Jobs | The job record and the life of a job, blocked jobs and answers, history, export and import | No spec yet |
| Schedules and triggers | Starts jobs at set times and on events, with run history and on-demand runs | No spec yet |
| Email | The Intern's own mailbox as a way in and out | No spec yet |
| Web interface | The team's browser view and configuration, built only on service operations | No spec yet |
| Command line | The `bob` commands, built only on service operations | No spec yet |
| Skills and instructions | Shipped skills and instructions, and the team's overlay | No spec yet |
| Team knowledge | Reaching, reading and updating the wiki and other knowledge sources | No spec yet |

Development infrastructure components (S-000, Components, Development infrastructure) are not part of the runtime and
are not described here.

## Module rule

- **Pure core.** Decision logic imports neither pi-durable nor I/O and is tested without a harness.
- **pi-durable only behind the host.** Only the harness host module and the-intern's own pi-durable extensions import
  pi-durable. The service layer and every other component depend on the host's interface, so an upgrade of the pi
  packages touches a few files.
- **Every job source ends in the same service operation.** Every way in and job source submits through the service layer.

See [coding_guidelines.md](coding_guidelines.md), Module structure, for the full rules.
