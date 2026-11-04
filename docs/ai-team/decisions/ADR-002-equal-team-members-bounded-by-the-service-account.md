---
id: ADR-002
title: Equal team members, bounded by the service account
status: accepted
created: '2026-10-30'
---

# ADR-002: Equal team members, bounded by the service account

## Context

The Intern works for a team. Team members hand it jobs, answer its questions, follow and steer its work and configure
it, through three ways in: the command line on the machine, the web interface over the team's network, and email to
The Intern's own mailbox (S-000, Users and Solution overview). It works unattended, so no step can wait for someone to
approve an action, except a blocked job waiting for an answer.

Every way in, every listener and every agent tool needs the same answer to two questions: who may use The Intern, and
what limits what its agents do. Without one recorded answer, each spec could add its own logins, roles or approval
rules, and the ways in would drift apart.

The product owner approved S-000 and S-002, which answer both questions. This record states that answer once. It is
one of the standing decisions S-000 asks to record before development starts (S-000, Developer documentation,
Decisions needed).

Sources: S-000 Users, Solution overview and Project exclusions; S-002 Definitions (service account), Design
Principles, Exclusions, REQ-006, REQ-016 and REQ-018.

## Decision

All team members are equal, and anyone who can reach a way in is a team member. Safety is bounded by the
operating-system account The Intern runs as, not by logins or per-action rules.

1. **Reaching a way in makes a team member.** Whoever can reach the command line, the web interface or The Intern's
   email address is a team member. Who that is follows from where The Intern can be reached: the machine's accounts,
   the team's network setup and the mailbox. Whoever installs The Intern is a team member like any other.
2. **No logins and no per-person permissions.** The Intern has no login, user list or roles for people, and makes no
   difference between team members. No listener authenticates callers: whoever can reach a listener can call the
   operations it exposes. No service operation reads transport details, a connection or the caller's machine to decide
   its outcome (S-002 REQ-016). Where S-001 requires attribution, the actor is still recorded: a team member with the
   way in they used, an agent, or a job source (S-001 REQ-007). It says where an action came from and grants nothing.
   Two rules read the way in to decide an outcome. A submit to the front desk is refused `invalid_input` unless its
   caller is a team member with the way in `command line` or `web interface`, so an agent, the front desk's own agent,
   a job source and an in-process caller naming no way in are refused too (S-001 REQ-020, S-004 REQ-021). `jobs.create`
   refuses a way in with no origin letter, which is what an in-process caller naming none gets (S-004 REQ-002). Both
   read the way in on the caller's actor, which a listener fixes (S-003 REQ-007), and no transport detail, connection
   or machine (S-002 REQ-016), and both treat every team member with the same way in alike.
3. **No per-action approval rules.** The Intern has no policy component and no approvals for each action. What it can
   do is bounded by what the service account can reach.
4. **The service account is the boundary.** The Intern runs as one operating-system account, the service account. In
   v1 it is the account of the person who installed it. It acts with that account's credentials and access, from that
   machine.
5. **Credentials are used in place, never copied.** Models and their credentials come from the service account's pi
   agent login, and every other credential (mail, wiki, repositories, other hosts) is the service account's, in that
   account's usual places. The daemon writes nothing into pi agent's agent folder except the login's own token
   refreshes. No credential is copied into the instance's directories or the database (S-002 REQ-018).
6. **Owner-only files.** Every directory The Intern creates is owner-only (mode 0700) and every file it creates is
   accessible only to the service account. An existing directory that is accessible to the group or others, or not
   owned by the service account, stops startup (S-002 REQ-006).

**The consequence, stated plainly:** whoever can reach The Intern acts with the service account's access. In v1 that
is the installing person's access. Limiting who can reach a way in, and what the service account can reach, is how a
team limits what The Intern can do.

## Consequences

### Positive

- One rule for every way in and every listener: none of them needs its own login or permission model, and a new way
  in adds no access control to design.
- Unattended work never stalls on an approval; only a blocked job waits, for an answer to its question.
- The boundary is one the team already understands and controls with the operating system's own tools: the service
  account's files, keys and network reach.
- No credential store to protect, rotate or leak: a credential lives in one place, the service account's.

### Negative

- Anyone who can reach a way in can give The Intern jobs that act with everything the service account can reach,
  including other hosts, and from the command line or the web interface can also change its roles, skills and
  instructions. Exposing the web interface beyond the team, or letting anyone email The Intern, gives them that
  access.
- In v1 the service account is a person's own account, so The Intern's reach is that person's reach, including their
  personal files and keys. A mistake by an agent, or by anyone who reaches a way in, acts with that person's access.
- There is no record of which person acted. The actor that S-001 attribution records names a team member and the
  way in they used, as the caller states it; nothing proves it.
- Safety depends on setup outside The Intern: the machine's accounts, the network setup that decides who reaches the
  web interface, and who can send to the mailbox. The user manual has to make this clear.

### Neutral

- A dedicated service account, with only the access The Intern needs, narrows the boundary without changing this
  decision; v1 uses the installing person's account.
- A second instance, run as a different account with its own state directory, is the way to give a different group a
  different boundary.

## Alternatives Considered

### Alternative A: Logins and per-person permissions

**Description:** Team members sign in, and roles or permissions decide what each may see and do.
**Rejected because:** S-000 excludes logins and per-person permissions. They add accounts, tokens and provisioning to
every way in, and the team is a small group of equals where access is controlled by where The Intern can be reached.

### Alternative B: Per-action approval rules

**Description:** A policy component checks each tool call against rules, and asks a team member to approve risky
actions.
**Rejected because:** S-000 excludes approval rules for each action. They would make unattended jobs wait on people,
and the limit that actually holds is what the service account can reach, which rules inside The Intern don't change.

### Alternative C: Authenticated listeners only

**Description:** The local socket and the network listener check a token or certificate before accepting calls.
**Rejected because:** It is a login in another form. Who can reach a listener is decided by the machine and the
network setup, and the service layer stays free of transport and authorization (S-002 Design Principles, REQ-016).

### Alternative D: The Intern holds its own credentials

**Description:** Copy model keys and account credentials into The Intern's configuration or database.
**Rejected because:** It creates a second credential store to protect, and lets The Intern and a person's own pi under
the same account log each other out. Using the service account's credentials in place keeps one copy and one boundary.

## Amendments

| Date | Change | Reason |
|---|---|---|
| 2026-11-04 | Decision 2: records the two rules that read the way in to decide an outcome: the front desk's refusal of input from anyone but a team member by the command line or the web interface, and the refusal of `jobs.create` for a way in with no origin letter. | S-001 REQ-020 and S-004 REQ-021 and REQ-002 already require them, and this decision said the actor grants nothing. PR #148 review; product owner decision of 2026-11-04. |
