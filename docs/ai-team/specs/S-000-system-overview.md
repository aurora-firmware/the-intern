---
id: S-000
title: System Overview
version: '0.1'
status: draft  # draft | review | approved | superseded
created: '2026-10-27'
author: planner
---

# System Overview

## Purpose

The Intern is a personal office assistant that runs in the background on one person's own computer. It handles that
person's email, documents and recurring chores, either on its own on a schedule or in conversation with them, and it
carries on with its work after a crash or restart. It exists to take routine office work off the person's hands
without making them watch over it, while keeping them in control of what it may do and able to see what it did.

## Users

- **The owner.** The one person whose computer and account the-intern runs on. They talk to it at the keyboard, leave
  it working unattended, and look back over what it did. They need it to act for them, to ask before risky actions,
  and to show its work.

## Pain points

1. **The inbox is sorted by hand.** Mail piles up, every message has to be read to see whether it matters, and
   follow-ups get lost.
2. **Recurring chores need someone to start them.** Regular checks, summaries and reports only happen when the owner
   remembers to do them.
3. **Assistants forget and stop.** Chat assistants lose earlier conversations, and their work stops when the window is
   closed or the computer restarts.
4. **An assistant that acts is risky.** An assistant that can run commands and send mail on the owner's behalf has no
   clear rules about what it may do alone and what it must ask about first.
5. **Unattended work is invisible.** When an assistant works on its own, it is hard to see what it did, what it is
   doing now and why.
6. **One generic assistant fits no job well.** Different jobs need different instructions, tools and cost of model, and
   a large job is not split into parts that run in parallel.

## Use cases

1. **Chat to get work done.** The owner asks the assistant to draft a text, look something up or reorganise files. The
   conversation keeps its history, and the answer still arrives if the owner closes the window or the computer
   restarts mid-reply. Removes: 3.
2. **Schedule a recurring job.** The owner sets up "every weekday at 8:00, do this". It runs without them, and they can
   also run it on demand. Removes: 2.
3. **Triage email.** On a schedule, the assistant reads new mail, sorts it into categories the owner can change,
   records the items that need follow-up, and brings to the owner only what needs them. Removes: 1.
4. **Approve a risky action.** Before an action that the owner's rules mark as "ask first", the assistant waits. The
   owner approves or refuses it when they get to it, and a waiting request is still there after a restart.
   Removes: 4.
5. **Watch and steer.** The owner sees which conversations are running and who is working in each, reads what
   happened, follows one live, and stops one. Removes: 5.
6. **Hand work to the right specialist.** A job passes to the kind of agent suited to it, or is split across several
   agents that work in parallel and report back. Removes: 6.
7. **Make the assistant their own.** The owner gives the assistant work folders with their own instructions and
   skills, and adjusts what ships with it, such as the email categories. Removes: 1, 6.

## Solution overview

The Intern runs as one background service on the owner's computer, started by the operating system and restarted if
it fails. Everything the owner and the assistant do happens in conversations kept by that service. A conversation
holds its whole history, so nothing is forgotten, and because every step is saved as it happens, work that was
interrupted by a crash or restart continues where it stopped. Only a fixed number of conversations work at once; the
rest wait their turn in order, and that order survives a restart too.

The work in a conversation is done by an agent made from a role. A role is a starting point: instructions, tools,
skills, and which model to use and how hard it thinks. A conversation has one agent at a time, can pass from one role
to another as the job changes, and can start other conversations to work in parallel and report back. No agent owns
another; they are peers.

Work enters in three ways: the owner chatting, a schedule firing, or the owner starting a conversation by request.
Email triage is one such scheduled job: it reads mail, sorts it, and keeps a list of open items that later runs and
the owner can both see.

Before every action an agent takes, the owner's rules decide whether it is allowed, needs the owner's approval, or is
refused. The agent can neither see nor change these rules. Approvals wait as long as needed and survive restarts.

The owner reaches the service through programs on the same computer: a chat window and command-line tools. A read-only
view from other devices on the home network comes later. These programs only look into the service and send it
requests; closing one never stops or slows any work. Everything the service does is recorded, so the owner can look
back over conversations and over the decisions taken on their behalf.

## Components

### Solution

#### Assistant service

- **Name:** Assistant service.
- **Responsibility:** The single long-running background process. It owns all saved state, keeps conversations
  durable and resumes them after a restart, limits how many run at once and queues the rest in order, reaches the
  models through the owner's own login, offers every capability as a named read or control operation, and publishes a
  stream of changes that the other parts can follow. It starts, stops and reads its configuration in a defined order.
- **Boundary:** It does not decide which roles exist or how agents move between conversations, how programs connect to
  it, what the owner's rules allow, or when scheduled work runs.
- **Works with:** Roles and conversations, Client access, Action rules and approvals, Scheduler, Activity record,
  Installation and service setup.

#### Roles and conversations

- **Name:** Roles and conversations.
- **Responsibility:** What a role is and which roles ship; how an agent is seated in a conversation and changed during
  it; passing a conversation to another role; one agent starting others, steering them or waiting for their reports;
  the limits on how deep and wide that goes; the ways into a conversation (chat, a schedule firing, a request); and
  the views that show which role is working where.
- **Boundary:** It does not run the process, queue work or keep state (Assistant service), decide when schedules fire
  (Scheduler), or supply the content of instructions and skills (Skills and instructions).
- **Works with:** Assistant service, Skills and instructions, Scheduler, Chat, Command line.

#### Client access

- **Name:** Client access.
- **Responsibility:** Lets programs on the owner's computer use the service's operations, with access limited to the
  owner, and offers the shared library those programs use. It decides which operations each way of connecting
  exposes, including a read-only view from the home network.
- **Boundary:** It holds no work and no state of its own and adds no capabilities: every operation it exposes belongs
  to the Assistant service. It does not present anything to the owner; Chat and Command line do.
- **Works with:** Assistant service, Chat, Command line.

#### Chat

- **Name:** Chat.
- **Responsibility:** The owner's window onto their main conversation: type a message, see the reply as it is written,
  keep typing while the assistant is busy, interrupt a reply, and pick the conversation up again after the window or
  the service was closed.
- **Boundary:** It owns no conversation and no work; closing it changes nothing in the service. Managing schedules,
  rules and other conversations belongs to Command line.
- **Works with:** Client access, Roles and conversations.

#### Command line

- **Name:** Command line.
- **Responsibility:** The owner's commands for running and managing the assistant: starting the service, listing
  conversations and reading their history, following and stopping work, answering approvals, managing schedules,
  reloading rules, and reading the activity record.
- **Boundary:** It holds no state and implements no behaviour of its own; each command calls an operation of the
  service through Client access.
- **Works with:** Client access, Assistant service.

#### Action rules and approvals

- **Name:** Action rules and approvals.
- **Responsibility:** Checks every action an agent is about to take against the owner's rules and lets it through,
  holds it for the owner's approval, or refuses it. Keeps waiting approvals until the owner answers, across restarts,
  and lets the owner change the rules while the service runs.
- **Boundary:** It does not show approvals to the owner (Chat and Command line do) and does not record history
  (Activity record). The agents cannot read or change the rules.
- **Works with:** Assistant service, Command line, Activity record.

#### Skills and instructions

- **Name:** Skills and instructions.
- **Responsibility:** The instructions and skills that ship with the-intern, such as using the mail client and
  explaining the-intern itself, and the way the owner adds their own or adjusts the shipped ones without editing the
  installed copy.
- **Boundary:** It does not decide which role gets which skills (Roles and conversations) or carry out the triage job
  (Email triage).
- **Works with:** Roles and conversations, Email triage.

#### Scheduler

- **Name:** Scheduler.
- **Responsibility:** Runs the owner's recurring jobs at their set times, lets the owner add, remove, list and run them
  on demand, keeps each job tied to the conversation it works in, and skips a run when the job is still busy or its
  work folder is missing.
- **Boundary:** It does not do the work of a job (the agents in its conversation do) and does not catch up on runs
  missed while the computer was off.
- **Works with:** Assistant service, Roles and conversations, Command line, Activity record.

#### Open items

- **Name:** Open items.
- **Responsibility:** A list of things still outstanding that agents add to, update and close, and that the owner can
  read. It survives restarts and is the single place where outstanding work is kept.
- **Boundary:** It is not a log of finished work; the conversations already record what was done. It does not decide
  what counts as an open item; the job that uses it does.
- **Works with:** Assistant service, Email triage, Roles and conversations.

#### Email triage

- **Name:** Email triage.
- **Responsibility:** The shipped scheduled job that reads new mail, sorts it into categories the owner can change,
  records follow-ups as open items, and brings to the owner only what needs them.
- **Boundary:** It does not send mail on its own beyond what the owner's rules allow, and it does not own the
  schedule, the open-items list or the mail client.
- **Works with:** Scheduler, Open items, Skills and instructions, Action rules and approvals.

#### Activity record

- **Name:** Activity record.
- **Responsibility:** An append-only record of the decisions taken on the owner's behalf: rule verdicts, approvals,
  scheduled runs and stopped work, which the owner can follow and read back.
- **Boundary:** It does not duplicate full conversation histories (the Assistant service keeps those), and it does not
  manage its own retention or redaction.
- **Works with:** Assistant service, Action rules and approvals, Scheduler, Command line.

### Development infrastructure

#### Development environment

- **Name:** Development environment.
- **Responsibility:** Gives everyone who works on the project the same tools at the same versions, and the same
  dependency versions, from a clean checkout.
- **Boundary:** It does not define how the solution is checked, tested or shipped.
- **Works with:** Quality checks, Test harness, Continuous integration.
- **Decisions needed:**
  - Which language and runtime version is the solution written for?
  - How is the tool set reproduced on a new machine, and is that the only supported way?
  - Which package manager is used, and how are dependency versions locked and upgraded?
  - How are the agent runtime packages kept on one version, and where is that version recorded?

#### Quality checks

- **Name:** Quality checks.
- **Responsibility:** The formatting, linting and type checks every change must pass, run the same way locally and
  in continuous integration.
- **Boundary:** It does not run behaviour tests (Test harness).
- **Works with:** Development environment, Continuous integration.
- **Decisions needed:**
  - Which formatter, linter and type checker are used, and with which settings?
  - Which checks block a merge, and which only warn?
  - Where are the coding conventions written down, and who changes them?

#### Test harness

- **Name:** Test harness.
- **Responsibility:** Runs the behaviour tests of the solution without a real model or the owner's own settings,
  including tests that kill the service mid-work and check that it resumes.
- **Boundary:** It does not cover manual runs against a real model (Local runs and diagnostics).
- **Works with:** Development environment, Continuous integration, Local runs and diagnostics.
- **Decisions needed:**
  - Which test runner is used, and how are unit and whole-service tests separated?
  - How does a deterministic fake model stand in for a real one?
  - How are crash-and-resume tests run reliably?
  - How are tests kept away from a service the developer has running and from their personal configuration?
  - Is there a coverage or test-presence rule for changes?

#### Continuous integration

- **Name:** Continuous integration.
- **Responsibility:** Runs the quality checks, tests and documentation builds on every proposed change and on each
  supported platform, and reports the result on the change.
- **Boundary:** It does not publish releases (Installation and service setup owns how a release is produced).
- **Works with:** Quality checks, Test harness, User manual, Installation and service setup.
- **Decisions needed:**
  - Which continuous-integration service runs the jobs?
  - Which jobs run on which events, and on which supported platforms?
  - Which job results are required before a change merges?

#### Installation and service setup

- **Name:** Installation and service setup.
- **Responsibility:** Turns a release into something the owner can install on a supported platform, and sets the
  service up so the operating system starts it at login and restarts it after a failure. Covers upgrading and
  removing it.
- **Boundary:** It does not define the service's own start-up and shutdown (Assistant service).
- **Works with:** Assistant service, Continuous integration, User manual.
- **Decisions needed:**
  - What form does a release take: a package for an existing runtime, or a self-contained bundle?
  - How is a release triggered, built and published?
  - How is the background service registered with each supported operating system?
  - What does an upgrade do with the owner's saved state, given that it may not carry over between versions?

#### User manual

- **Name:** User manual.
- **Responsibility:** The owner-facing documentation: installing, configuring, chatting, scheduling, writing rules,
  customising skills and reading the record. The shipped skill that explains the-intern draws its content from it.
- **Boundary:** It contains no internal specs, decisions or bug reports.
- **Works with:** Command line, Skills and instructions, Continuous integration, Installation and service setup.
- **Decisions needed:**
  - Which documentation format and tool are used, and where is the manual published?
  - How is the manual kept in step with the commands and configuration?
  - Is there a companion skill for the owner's other assistants, and in what format?

#### Developer documentation

- **Name:** Developer documentation.
- **Responsibility:** What a developer needs to start: setting up the environment, the conventions, the knowledge
  about the underlying agent runtime, the record of runtime versions in use, and where architecture decisions are
  recorded.
- **Boundary:** It does not hold requirements; specs and decision records do.
- **Works with:** Development environment, Quality checks, Test harness.
- **Decisions needed:**
  - Which standing architecture decisions are recorded as decision records before development starts?
  - Where does the shared vocabulary live once this overview no longer carries it?

#### Local runs and diagnostics

- **Name:** Local runs and diagnostics.
- **Responsibility:** Lets a developer run their own instance of the service against a real model, separate from any
  instance the owner uses, and inspect what it is doing.
- **Boundary:** It is not part of the automated tests and is never required for them.
- **Works with:** Development environment, Test harness, Assistant service.
- **Decisions needed:**
  - Where does a development instance keep its state, and how is it kept apart from a real one?
  - What logging and diagnostic output does the service give, and at which levels?
  - How does a developer inspect a running instance's state without opening its saved data directly?

## Project exclusions

- **More than one user, remote callers or network control.** Running every conversation in one process is acceptable
  only because one person uses it on their own machine.
- **Control from other devices in the first version.** The home-network view starts read-only; control from there
  comes later.
- **Windows, Linux on ARM and Intel Macs.** Only Linux on x64 and macOS on Apple silicon are supported, to keep the
  test matrix small.
- **Confining agents to their work folders.** Agents act with the owner's account on the whole computer; the action
  rules are the safeguard, not a sandbox.
- **Saved state that survives an upgrade.** The underlying agent runtime is pinned to one version and gives no
  compatibility promise for saved state.
- **Loading the owner's other assistant add-ons.** Add-ons written for the owner's other coding assistants are never
  loaded into the service; customisation comes through work folders and skills.
- **Tool connectors to external services and typed tool wrappers.** The agents use the shell and shipped skills; a
  dedicated tool is added only when a skill cannot do the job.
- **Deny rules and rules per user.** Rules allow or ask; anything that matches no rule is refused, which makes deny
  rules unnecessary, and there is only one user.
- **Catching up on missed scheduled runs and chaining jobs.** A run missed while the computer was off is skipped; jobs
  do not trigger each other.
- **Retention and redaction of the activity record.** The record is append-only and the owner manages its files.
- **A separate log of finished work.** The conversations already record what was done; open items record what is
  still outstanding.

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
