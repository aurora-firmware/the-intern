---
id: ADR-002
title: Equal team members, bounded by the service account
status: accepted
created: '2026-10-30'
---

# ADR-002: Equal team members, bounded by the service account

## Context

The Intern works unattended for a team, through three ways in: the command line, the web interface and email (S-000).
Every way in, listener and agent tool needs one answer to two questions: who may use The Intern, and what limits what
its agents do. Without one recorded answer, each spec could add its own logins or approval rules.

## Decision

All team members are equal, and anyone who can reach a way in is a team member. The operating-system account The
Intern runs as bounds what it can do, not logins or per-action rules.

1. **Reaching a way in makes a team member.** Whoever can reach the command line, the web interface or the address of
   one of The Intern's owned mail accounts is a team member, the installing person included. Only owned accounts are a
   way in: a monitored account is someone else's mailbox, and no email in it reaches a job (S-009 REQ-006, REQ-010).
2. **No logins and no per-person permissions.** No listener authenticates callers, and no operation reads transport
   details, a connection or the caller's machine to decide its outcome (S-002 REQ-016). The actor S-001 REQ-007
   records says where an action came from and grants nothing. Two rules read the actor's way in, which a listener fixes
   (S-003 REQ-007): the front desk takes a submit only from a team member by the command line or the web interface
   (S-001 REQ-020, S-004 REQ-021), and `jobs.create` refuses a way in with no origin letter (S-004 REQ-002).
3. **No per-action approval rules.** There is no policy component and no approval of each action.
4. **The service account is the boundary.** The Intern runs as one operating-system account and acts with its
   credentials and access. In v1 it is the installing person's account.
5. **Credentials are used in place, except the account secrets the instance keeps.** Models come from the service
   account's pi agent login, and every other credential the daemon acts with stays in that account's usual places. The
   daemon writes nothing into pi agent's folder except the login's own token refreshes. The one exception: the instance
   keeps the passwords and client secrets a team member gives it for the accounts it connects to, and the OAuth tokens
   it obtains for them, in its owner-only secrets store (ADR-010). Mail accounts are the only such accounts today, and
   a later kind of account keeps its secrets in the same store. No other credential is copied into the instance's
   directories, and no credential is kept in the database or anywhere else (S-002 REQ-018, S-009 REQ-002, REQ-020).
6. **Owner-only files.** Every directory and file The Intern creates on its machine, the export route's temporary copy
   included, is accessible only to the service account, and an unsafe existing directory stops startup (S-002
   REQ-006). A file a client saves from the export route is outside this rule. So is a save that replaces an
   existing file a team member edits through the service (S-008 REQ-010): the file is the team's, not one The Intern
   creates, so the save keeps its mode bits, and its group where the service account may set it, at the target of
   any symbolic link. Only its owner becomes the service account, because an atomic write puts a new file in place.
   The supervisor registration is outside this rule too where the operating system dictates its ownership: on macOS
   the system-wide launchd file must be owned by root and writable by root only (S-010 REQ-004). It holds no secret.

## Consequences

- Whoever can reach The Intern acts with the service account's access, which in v1 is a person's own files and keys.
  Limiting who reaches a way in, and what the account can reach, is how a team limits The Intern.
- No way in needs its own login model, and unattended work never waits for an approval.
- The instance has one credential store, the secrets store, and only for the secrets of accounts it connects to. The
  service account can read it, as it can every credential it acts with (decision 4), and an export carries none of it.
- Anyone who can write to an owned address is a team member, so a team limits who emails The Intern on its mail
  server, and limits whom The Intern writes to with each account's allowlist (S-009 REQ-012).
- Anyone who reaches the network listener can download the whole database, transcripts included; the product owner
  accepted this risk on 2026-11-06 (S-006).
- Nothing proves which person acted: the recorded actor is what the caller states.
- Safety depends on setup outside The Intern, which the user manual explains. A dedicated service account, or a second
  instance under another account, narrows the boundary without changing this decision.

## Alternatives Considered

- **Logins and per-person permissions:** rejected because S-000 excludes them, and access is controlled by where The
  Intern can be reached.
- **Per-action approval rules:** rejected because S-000 excludes them, they stall unattended jobs, and the limit that
  holds is the service account's reach.
- **Authenticated listeners only:** rejected because a token is a login in another form.
- **The Intern copies the service account's credentials:** rejected because it creates a second copy of each, and The
  Intern and a person's own pi would log each other out.
- **Account secrets used in place too:** rejected for the accounts The Intern connects to (S-009, Alternatives
  Considered). A password a team member types has no usual place, OAuth tokens change at each refresh, and the
  operating system's keyring is locked on macOS when the service starts at boot with nobody logged in.
