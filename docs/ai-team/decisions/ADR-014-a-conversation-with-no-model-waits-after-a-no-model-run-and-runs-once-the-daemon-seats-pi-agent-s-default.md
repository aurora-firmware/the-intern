---
id: ADR-014
title: A conversation with no model waits after a no_model run and runs once the daemon seats pi agent's default
status: accepted
created: '2026-11-24'
---

# ADR-014: A conversation with no model waits after a no_model run and runs once the daemon seats pi agent's default

## Context

CR-002 lets the daemon run with no pi login (S-001 REQ-003, REQ-027; S-002 REQ-002, REQ-003). A seat may then have no
model. Its input must be accepted into the transcript, refused and lost nowhere, and answered without being sent
again once pi agent's settings name a default model. The daemon must notice that within 30 seconds without writing
into the pi agent folder (S-002 REQ-018, ADR-002 decision 5). The conversation must stay idle, hold no worker thread,
and survive a stop, a kill and a restart.

pi-durable 1.4.0 stores an agent with no model (`AgentState.model` is optional; `configure` takes `model: null`). A
generation whose agent has no model ends in its `prepare` phase, before the admission hook takes a worker thread
(`failNoModel` in `harness/generation.js`): the run's inputs settle `unanswered` with reason `no_model`, and they are
already placed in the transcript. pi-durable places an input in the transcript only when it starts a run with it; an
input queued in `pi.inbox` is not in the transcript. A compaction with no model fails the same way. The Harness takes
`models` as a function, called at each use, so the host can swap its model access without reopening.

## Decision

A conversation with no model takes its input the normal way and lets pi-durable end the run with `no_model`. The
daemon then marks the conversation as waiting, and starts a run with no new input once its seat has a model. The daemon
gives every seat with no model pi agent's default by an ordinary seat write when one appears.

1. **No model in the agent.** A seat with no model is stored with `model: null`, in the seat, the `intern.conversation`
   document and the pi-durable agent. Reads show the seat's model as `null`. Every input goes through
   `Conversation.submit` as today. pi-durable places it in the transcript, starts a run, and ends that run with
   `no_model` before any model request or worker thread. A handoff or a team member's seat change to a seat with no
   model ends the conversation's run the same way, at its next model turn. Queued input that `afterFailedRun:
   "continue"` places after that ends the same way.
2. **The waiting fact.** A run that ends with `no_model` is handled in the run-end serial queue, before report delivery
   and S-004's turn-end check. If the seat has a model by then that the model registry resolves, the daemon starts the
   continuation at once (decision 4). A seat that names a model the registry doesn't resolve is not "no model" (S-001
   Definitions): its run stays failed as before, with no fact. Otherwise one host commit writes `waitingForModel` into
   the conversation's `intern.conversation` document and appends the no-model notice. When the fact is already set, the
   commit changes nothing, so the notice is written once per waiting period. The fact holds `order`: the id of the
   period's first waiting input submission, or of the notice when the period began without one. pi-durable mints every
   id from one sequence, so `order` follows acceptance across conversations. It may also hold `compaction`, a compaction
   the conversation needs, with its instructions. A run end with `no_model` is not the end of an agent's work: it sends
   no report (S-001 REQ-019) and is no turn end for S-004 REQ-008, and a conversation with the fact set has something to
   wait for.
3. **Compaction waits.** A team member's compaction, or the Compact context mode of a handoff or an invocation whose
   seat has no model, creates no compaction task. It sets the fact with `compaction` (and the notice, for a new
   period). The handoff tool then reports success, and the run ends as decision 1 says. Automatic compaction only runs
   inside a run, so it never starts with no model.
4. **Release.** A conversation whose fact is set runs again once its seat has a model, through decision 5 or a team
   member's seat change or reset with a new seat. The release first runs a pending compaction with
   `Conversation.compact` and waits for it. Then one host commit reads `pi.live`. When no run is active, it creates a
   `pi.generation` task owned by the conversation and sets `pi.live.run` to it with no inputs, as pi-durable's
   `startRun` does. In the same commit it clears the fact. The run continues from the transcript, which already holds
   the inputs and the handoff. When the default appears, the daemon releases the waiting conversations in `order`, one
   at a time. It starts the next once the admission lists the previous one as active or waiting, or its run has ended,
   so the worker threads go in acceptance order.
5. **Taking up pi agent's default.** When pi agent's settings come to name a default model, the daemon gives every open
   conversation whose seat has no model that model. It uses pi agent's default thinking level when the seat names none.
   It does this with an ordinary seat write: the role and workspace stay, the seat record names the daemon as actor, and
   the enabled set resets to the role's defaults as on any seat change (S-008 REQ-006). Waiting conversations are
   reseated first, in `order`, and then released. A seat that took up the default keeps it, like any seat value (S-001
   AC-003.7). When the default disappears, only seats resolved afterwards have no model. A run already started goes on
   with its seat's model.
6. **Noticing the pi agent folder.** Every 10 seconds the model runtime reads `settings.json` and the size and
   modification time of `auth.json` and `models.json`. Nothing is watched. When any of them changed, it opens a new pi
   `ModelRuntime` on the folder, with pi's own credential store once `auth.json` exists. The Harness's `models` function
   returns the new one for later uses, and the old one stays with the requests already streaming. It then re-reads the
   default. The daemon reads the folder only, and its state changes at most 10 seconds after the files do, within S-001
   REQ-027's 30 seconds. `daemon.status` reports `noDefaultModel` from this state.
7. **Recovery.** A crash between pi-durable's `no_model` commit and the fact's commit leaves an open conversation with
   no model and work the model hasn't answered: an entry the model sees, an input or a handoff's tool result, after
   its newest assistant entry. At startup step 7, before
   `host.resume()`, the daemon sets the missing fact with its notice for each such conversation. It then runs decision
   5 for the default the folder names. After `host.resume()`, it releases every conversation with a fact whose seat
   now has a model. An abort's commit clears the fact, so the abort withdraws the waiting input from any release. The
   closed-mark commit clears it too. The input stays in the transcript, as an aborted run's input does.
8. **The no-model notice** is the display-only entry `intern.notice` with data `{ notice: "no_default_model", text }`.
   It carries no model message, so it is not part of the model's context. It is appended in the fact's commit and stays
   in the transcript.

## Consequences

- Input with no model is placed and kept by pi-durable itself, so it needs no new holding list, and it survives every
  stop. Every path that submits input works unchanged, including steering, reports, the job rules, intake and the
  front desk's tools.
- A waiting input's submission is settled `unanswered` with reason `no_model`, though its answer comes later in the
  transcript. `bob chat` and the web pages read that reason as waiting, not as a failure.
- The conversation is briefly running while its run ends with `no_model`, and it holds no worker thread throughout.
- The release copies pi-durable's run start, and the host depends on the `pi.live.run` shape and the `pi.generation`
  task's creation. Each pi-durable upgrade rechecks this, as with ADR-003. When pi-durable offers a run start
  without input, the host switches to it.
- Taking up the default is an ordinary seat change. It shows in the transcript, and it resets an enabled set that a
  team member changed while the conversation waited.
- The folder is read every 10 seconds, a small fixed cost. A default that disappears stops nothing that already has a
  model.

## Alternatives Considered

- **Hold the input in the-intern's own document until a model exists:** rejected because the input wouldn't be in the
  transcript (CR-002), and its submit would return no submission.
- **Wait inside the admission hook, with a stand-in model:** rejected because the run stays busy. Later input then
  queues in `pi.inbox`, out of the transcript, and the stand-in would be resolved before the wait ends.
- **Place input in the transcript in a host commit, with no run:** rejected because it copies pi-durable's input
  placement as well as its run start. It also leaves a handoff and a reseat mid-run uncovered, which decision 1 covers
  the same way as input.
- **A seat that follows pi agent's default on each request:** rejected because a default that disappears would fail
  runs already under way, and the seat record would never name the model a turn used (S-001 REQ-007).
- **Watch the pi agent folder:** rejected for the reason ADR-009 gives: watches miss changes on some file systems and
  differ between Linux and macOS. A watch would also miss a folder created after the daemon starts.
