---
id: S-000
title: System Overview
version: '0.3'
status: draft  # draft | review | approved | superseded
created: '2026-10-27'
author: planner
---

# System Overview

## Purpose

The Intern is an agent that works for a team. It runs unattended on an always-on machine, takes jobs from anyone who
can reach it, and sees each one through to the end: it first defines the job properly and works out what it needs,
asks when information is missing, then does the work and checks the result before closing the job. It exists so that
a team can hand off work, from one-off objectives to recurring housekeeping, and trust it to get done without anyone
driving it step by step.

## Users

- **Team members.** Anyone who can reach one of The Intern's ways in: the command line, the web interface or its email
  address. They hand it jobs, answer its questions, follow its work and stop or redirect it, and, from the command
  line or the web interface, configure it: its schedules, triggers, roles, skills, instructions and knowledge sources.
  Whoever installs it on the always-on machine and gives it its accounts is a team member like any other. They need
  it to finish what it is given, to ask only when it lacks something, and to show what it did. All team members are
  equal; The Intern makes no difference between them.

## Pain points

1. **Assistants need driving.** Chat assistants need a person to lead every step, forget earlier work, and stop when
   the window is closed or the machine restarts. Nothing works on a job while nobody is watching.
2. **Work stalls on missing information.** Requests arrive vague or incomplete, and the gaps are found late, after
   work has gone in the wrong direction or has quietly stopped.
3. **Recurring chores need someone to start them.** Housekeeping such as checking that backups ran or that services
   are up only happens when someone remembers to do it.
4. **Outdated documentation.** Keeping the team's documents up to date is tedious and often not done.
5. **Housekeeping needs specialised knowledge.** Monitoring and maintenance tasks need knowledge that not everyone on
   the team has at hand.
6. **Handing work off takes effort.** Requests live in mail and conversations, and passing them to an assistant means
   opening a special tool and staying with it.

## Use cases

1. **Hand over an objective.** A team member gives The Intern a job, such as "find out why the nightly build got
   slower and fix it". It writes down the goal, what it needs and when the job counts as done, asks back only if the
   job is unclear, then works on it for as long as it takes, splitting it among specialist agents where that helps.
   It checks the result against its own definition of done and closes the job with the evidence. Work it notices
   along the way becomes new jobs. Removes: 1, 2.
2. **Answer a blocked job.** When a job lacks information or a decision, The Intern marks it blocked, says what it
   needs, and carries on with other jobs. The team member answers from the web interface, the command line or by
   email, and the job resumes. Removes: 2.
3. **Schedule recurring housekeeping.** A team member sets up "every night, check that the backups ran and the
   services on the network answer". It runs without anyone, reports what it found, and can also be run on demand.
   Removes: 3, 5.
4. **React to an event.** Something happens, such as a check failing or a message arriving, and The Intern opens a job
   for it without being asked. Removes: 3, 5.
5. **Keep documentation current.** The Intern updates the team's documents, whether in the team wiki, in repositories
   or in other folders the team points it to, as part of its jobs or on a schedule, and writes down what it learns
   about the team's systems in the wiki, where people can read and correct it. Removes: 4.
6. **Email The Intern.** A team member sends a request or an answer to The Intern's own address. It sorts its inbox,
   turns requests into jobs, attaches answers to the jobs waiting for them, and, when sending is set up, writes to the
   people it needs. Removes: 6, 2.
7. **Watch and steer.** In the web interface a team member sees every job with its definition, status, open questions
   and evidence, follows an agent working live, and stops or redirects it. Removes: 1.
8. **Fit The Intern to the team.** A team member adds instructions, skills and specialist roles, points The Intern at
   the team's knowledge sources, and manages schedules and triggers from the web interface or the command line, without
   changing The Intern itself. Removes: 4, 5.

## Solution overview

The Intern is one service that runs all the time on a machine the team owns. All of its work is organised as jobs,
kept in its own job record. A job can come from a team member, from a schedule, from an event, or from The Intern
itself when it finds follow-up work. Every job goes through the same steps: define it (goal, needs, plan and
definition of done), get what is missing, act, and verify. A job that lacks something is marked blocked with its
question, and The Intern turns to other jobs until the answer arrives. Many jobs run at the same time, up to a limit on
how many agents work at once; a blocked job waits without counting against it. A job that was interrupted by a crash
or restart picks up where it stopped.

The work on a job is done by agents. An agent is made from a role: instructions, tools, skills and the model it uses.
Each job has exactly one lead agent at a time, which carries it from definition to verification. The lead can hand
the job over to an agent of another role when the work changes, and calls on agents of specialist roles, such as
documentation or housekeeping, for parts of it, which can run in parallel and report back. Team members define the
roles the team needs.

People reach The Intern through the command line, a web interface and email. None of these needs a login: whoever can
reach a way in is a team member, and who that is follows from where The Intern can be reached. The web interface shows
every job, its questions and its evidence, follows agents live, and configures The Intern: schedules, triggers, roles,
skills, instructions and knowledge sources. When a job is blocked, the question waits in the web interface and the
command line, and is also sent by email when sending is set up.

The Intern keeps the history of every job as part of its job record. Saved state does not carry over to a new version
on its own, so the job record, history included, can be exported and imported into the new version.

What The Intern learns about the team's systems and conventions it writes to the team's wiki, which the team runs
separately and edits in the browser alongside it; the wiki and the team's other documents are both where The Intern
learns how the team works and documentation it keeps current.

The Intern acts with the accounts and access it is given, from the machine it runs on. What it can do is bounded
by what that machine and those accounts can reach, not by approval rules for each action.

## Components

### Solution

#### Intern service

- **Name:** Intern service.
- **Responsibility:** The single long-running process on the always-on machine. It owns all saved state, runs many jobs
  at once up to a limit on how many agents work at once and queues the rest, resumes interrupted work after a crash or
  restart, reaches the models, offers every capability as a named operation that the ways in share, and publishes a
  stream of changes that they can follow. It starts, stops and reads its configuration in a defined order.
- **Boundary:** It does not define what a job is or its steps (Jobs), which roles exist (Agents and roles), how people
  reach it (Command line, Web interface, Email), or when scheduled work runs (Schedules and triggers).
- **Works with:** Jobs, Agents and roles, Command line, Web interface, Email, Schedules and triggers, Installation and
  service setup.

#### Jobs

- **Name:** Jobs.
- **Responsibility:** The job record and the life of a job: where it came from, its definition (goal, needs, plan and
  definition of done), its status, its open questions, the evidence it closed with, and the follow-up jobs it
  created. It defines the steps every job goes through (define, get what is missing, act, verify), when a job counts
  as blocked and how an answer resumes it, keeps the history of every job (what its agents did) in the job record,
  and exports and imports the whole job record, history included, so it can be carried to a new version.
- **Boundary:** It does not do the work of a job (Agents and roles) or decide when recurring jobs start (Schedules and
  triggers). It does not sync with outside ticket trackers.
- **Works with:** Intern service, Agents and roles, Schedules and triggers, Command line, Web interface, Email.

#### Agents and roles

- **Name:** Agents and roles.
- **Responsibility:** What a role is and which roles ship; how the agent that leads a job is chosen and how it hands
  the job over to an agent of another role, keeping exactly one lead at a time; how the lead calls on
  agents of specialist roles, steers them and collects their reports; the limits on how deep and wide that goes; and
  what shows which agent is working on what.
- **Boundary:** It does not keep the job record (Jobs), run the process or queue work (Intern service), or supply the
  content of instructions and skills (Skills and instructions).
- **Works with:** Intern service, Jobs, Skills and instructions, Team knowledge, Email, Command line, Web interface.

#### Command line

- **Name:** Command line.
- **Responsibility:** Commands for using and running The Intern: starting the service, creating jobs, listing them and
  reading their history, answering blocked jobs, following and stopping work, managing schedules, triggers, roles,
  skills, instructions and knowledge sources, and exporting and importing the job record.
- **Boundary:** It holds no state and implements no behaviour of its own; each command calls an operation of the
  Intern service.
- **Works with:** Intern service, Jobs, Schedules and triggers, Agents and roles, Skills and instructions, Team
  knowledge.

#### Web interface

- **Name:** Web interface.
- **Responsibility:** The team's browser view of The Intern: a board of all jobs with their definitions, status, open
  questions and evidence; creating jobs and answering questions; following an agent live and stopping or redirecting
  it; and managing schedules, triggers, roles, skills, instructions and knowledge sources.
- **Boundary:** It holds no work and no state of its own and adds no capabilities: every action calls an operation of
  the Intern service. It has no login of its own; who can reach it follows from the network setup of the machine.
- **Works with:** Intern service, Jobs, Schedules and triggers, Agents and roles, Skills and instructions, Team
  knowledge.

#### Email

- **Name:** Email.
- **Responsibility:** The Intern's own mailbox as a way in and out: it sorts incoming mail, turns requests into jobs,
  attaches replies to the jobs waiting for them, reports incoming mail as an event that triggers can start jobs from,
  and, when sending is set up, sends questions and reports to the people a job needs.
- **Boundary:** It does not read or triage team members' own mailboxes, and it does not decide what a job is or when
  one is blocked (Jobs). Both parts are optional and set up separately: The Intern works without a mailbox, and a
  mailbox can receive without sending being set up.
- **Works with:** Intern service, Jobs, Agents and roles, Schedules and triggers.

#### Schedules and triggers

- **Name:** Schedules and triggers.
- **Responsibility:** Starts jobs at set times and when events happen; defines which events exist, such as a job
  ending with a given outcome or mail arriving; lets team members add, remove, list and run them on demand; and skips
  a run while the previous one is still working.
- **Boundary:** It does not do the work of a job (Agents and roles) or keep the job record (Jobs). It does not watch
  the mailbox itself; Email reports incoming mail.
- **Works with:** Intern service, Jobs, Email, Command line, Web interface.

#### Skills and instructions

- **Name:** Skills and instructions.
- **Responsibility:** The instructions and skills that ship with The Intern, such as explaining The Intern itself, and
  the way team members add their own or adjust the shipped ones without editing the installed copy.
- **Boundary:** It does not decide which role gets which skills (Agents and roles) and does not hold the team's
  knowledge (Team knowledge). It adds no code to The Intern.
- **Works with:** Agents and roles, Team knowledge, Command line, Web interface.

#### Team knowledge

- **Name:** Team knowledge.
- **Responsibility:** How The Intern reaches the knowledge sources team members point it to (the team wiki,
  documentation in repositories, other folders of documents), reads them to learn the team's systems and conventions,
  keeps them up to date, and writes what it learns to the wiki where people can read and correct it.
- **Boundary:** It does not host or serve the wiki; the team runs it separately. It does not keep the job history
  (Jobs).
- **Works with:** Agents and roles, Skills and instructions, Command line, Web interface.

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
- **Responsibility:** Runs the behaviour tests of the solution without a real model, a real mailbox or the
  developer's own settings, including tests that kill the service mid-job and check that it resumes, and tests of the
  web interface.
- **Boundary:** It does not cover manual runs against a real model (Local runs and diagnostics).
- **Works with:** Development environment, Continuous integration, Local runs and diagnostics.
- **Decisions needed:**
  - Which test runner is used, and how are unit, whole-service and web-interface tests separated?
  - How does a deterministic fake model stand in for a real one?
  - How is email tested without a real mail server?
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
- **Responsibility:** Turns a release into something a team member can install on an always-on machine of a supported
  platform, and sets the service up so the operating system starts it at boot and restarts it after a failure.
  Covers upgrading and removing it.
- **Boundary:** It does not define the service's own start-up and shutdown (Intern service) or the team's network
  setup that decides who can reach it.
- **Works with:** Intern service, Continuous integration, User manual.
- **Decisions needed:**
  - What form does a release take: a package for an existing runtime, or a self-contained bundle?
  - How is a release triggered, built and published?
  - How is the background service registered with each supported operating system?
  - How does an upgrade export the job record from the old version and import it into the new one, and what happens
    to jobs still in progress?

#### User manual

- **Name:** User manual.
- **Responsibility:** The documentation for team members: installing and upgrading The Intern, giving it access,
  accounts and email, configuring roles, skills, instructions, knowledge sources, schedules and triggers, and giving
  and following jobs and answering questions. The shipped skill that explains The Intern draws its content from it.
- **Boundary:** It contains no internal specs, decisions or bug reports.
- **Works with:** Command line, Web interface, Skills and instructions, Continuous integration, Installation and
  service setup.
- **Decisions needed:**
  - Which documentation format and tool are used, and where is the manual published?
  - How is the manual kept in step with the commands, the web interface and the configuration?

#### Developer documentation

- **Name:** Developer documentation.
- **Responsibility:** What a developer needs to start: setting up the environment, the conventions, the knowledge
  about the underlying agent runtime, the record of runtime versions in use, the shared vocabulary, and where
  architecture decisions are recorded.
- **Boundary:** It does not hold requirements; specs and decision records do.
- **Works with:** Development environment, Quality checks, Test harness.
- **Decisions needed:**
  - Which standing architecture decisions are recorded as decision records before development starts?
  - Where does the shared vocabulary live, and how is it kept in step with the specs?

#### Local runs and diagnostics

- **Name:** Local runs and diagnostics.
- **Responsibility:** Lets a developer run their own instance of the service against a real model, separate from any
  instance a team uses, and inspect what it is doing.
- **Boundary:** It is not part of the automated tests and is never required for them.
- **Works with:** Development environment, Test harness, Intern service.
- **Decisions needed:**
  - Where does a development instance keep its state, and how is it kept apart from a real one?
  - What logging and diagnostic output does the service give, and at which levels?
  - How does a developer inspect a running instance's state without opening its saved data directly?

## Project exclusions

- **Logins and per-person permissions.** Whoever can reach a way in is a team member and all are equal; access is
  controlled by where The Intern can be reached.
- **Approval rules for each action.** What The Intern can do is bounded by the machine it runs on and the accounts it
  is given, not by per-action rules.
- **Hosting the wiki.** The team runs its wiki separately; The Intern only reads and writes it.
- **Footholds on other machines.** The Intern runs on one machine and reaches others only as that machine can over the
  network; it installs nothing on them.
- **Syncing with outside ticket trackers in the first version.** The Intern's own job record is the single place jobs
  are kept.
- **Chat applications as a way in for the first version.** The first ways in are the command line, the web interface
  and email; others come later.
- **Code extensions and add-ons from other assistants.** The Intern is adapted through instructions, skills and
  knowledge sources only.
- **Windows, Linux on ARM and Intel Macs.** Only Linux on x64 and macOS on Apple silicon are supported, to keep the
  test matrix small.
- **Saved state that carries over to a new version on its own.** The underlying agent runtime is pinned to one
  version and gives no compatibility promise for saved state; the job record is carried over by export and import
  instead.

## Amendment Log

<!-- Optional. Use when an approved spec is amended after tasks are in flight.
| Date | What changed | Why | Affected tasks |
|------|-------------|-----|----------------|
| YYYY-MM-DD | Description of change | Reason for amendment | T-XXX, T-YYY |
-->
