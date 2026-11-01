---
id: ADR-005
title: Browser access to the listeners is limited by reach and same-origin rules, not origin checks
status: accepted
created: '2026-11-01'
---

# ADR-005: Browser access to the listeners is limited by reach and same-origin rules, not origin checks

## Context

S-003 (Control endpoint) puts the service operation catalogue on two HTTP listeners: the local socket on the machine
and the network listener on the team's network. The network listener also serves the web interface files, so team
members use it from a browser.

ADR-002 settles that no listener authenticates callers and that whoever can reach a way in is a team member. A browser
adds a case ADR-002 doesn't cover: a team member's browser runs pages from other sites, and those pages can send
requests to any address the browser can reach. Without a rule, a page from another site could use a team member's
browser to call operations on the network listener, although the site itself can't reach it.

Browsers apply same-origin rules. A page from another site can send a simple request (a `GET`, or a `POST` with a
form or plain-text body) without asking first, but can't read the answer unless the server allows it with CORS
headers. Any other request, such as a `POST` with `Content-Type: application/json`, needs a CORS preflight, which
fails when the server sends no CORS headers. These rules don't help against DNS rebinding: a site that makes its own
name resolve to the listener's address is the same origin to the browser, so its page can send any request and read
every answer. Only a check of the `Host` header, or authentication, stops that.

In the S-003 design interview of 2026-11-01 the product owner ruled: no authentication, no `Origin` or `Host` check, no
CORS headers, and operation bodies must be `application/json`. The product owner confirmed that teams accept the
DNS-rebinding exposure and limit who reaches the network listener with their network setup (S-003, Assumptions and
Dependencies).

The JSON-only rule looks like ordinary input validation, but it is what keeps other sites' pages out. A later change
that accepts form bodies, adds a state-changing `GET`, or sends CORS headers would silently open the listeners to
every site a team member visits. This record makes those rules a decision, so no later spec or task drops one of them
without seeing what it protects.

Sources: S-003 v0.1, REQ-003, REQ-004, REQ-008, REQ-014, Exclusions and Alternatives Considered; ADR-002 decisions 1
and 2; S-002 REQ-016.

## Decision

The listeners check neither who calls nor where a request comes from. Other sites' pages are kept out by the
browser's same-origin rules, which the listeners keep effective with three rules. DNS rebinding remains open, and
limiting who can reach the listener is the only protection against it.

1. **No origin checks.** No listener checks `Origin`, `Host` or `Referer`, and none authenticates callers (ADR-002
   decision 2).
2. **Every operation call needs a preflight from another site.** An operation call is a `POST` whose
   `Content-Type` media type is `application/json`, including a call with an empty body. Any other or missing content
   type is refused as `invalid_input` before the operation runs.
3. **No CORS permission.** No listener sends a CORS header or grants a preflight, so a browser refuses another site's
   operation calls and doesn't let its pages read any answer.
4. **No state change without a preflight.** A route that a page from another site can trigger with a simple request
   (`GET`, `HEAD`, or a form or plain-text `POST`) never changes state or starts work. In S-003 those routes are the
   feed and the web interface files.
5. **DNS rebinding is accepted.** A site that rebinds its name to the network listener's address can, through the
   browser of a team member who opens it, read the feed and call every operation. The user manual states this where it
   describes the network listener (S-003 REQ-014).
6. **Changing a rule is an architecture change.** Accepting another content type for operation calls, adding a
   state-changing route reachable by a simple request, sending CORS headers (for example to allow a named site), or
   adding an `Origin` or `Host` check needs a new ADR or an amendment to this one.

The rules apply to both listeners, since they share one HTTP front. Browsers can't reach the local socket, so for it
they cost nothing and protect nothing.

## Consequences

### Positive

- Other sites' pages can't call operations or read the feed through a team member's browser, except by DNS rebinding,
  with no login, token or origin list to manage.
- Any HTTP client, such as `curl` or a script on the team's network, calls operations with a plain JSON request.
- A reverse proxy in front of the network listener, under any host name, works without configuring The Intern.

### Negative

- DNS rebinding widens ADR-002 decision 1: someone who can't reach the network listener can act with the service
  account's access through the browser of a team member who can, by luring that team member to a page. Limiting who
  reaches the listener doesn't stop this, because the team member's browser does reach it. Teams that can't accept
  this keep the network listener off, or put it behind a proxy that checks the host name.
- A page from another site can still open feed connections it can't read, and can send simple requests that the
  listener refuses. This costs the daemon connections but changes no state.
- The web interface can't be served from another site without a new decision (decision 6).

### Neutral

- A team that wants a host check or authentication can add it in a reverse proxy in front of the network listener.
- The local socket is gated by the owner-only runtime directory (S-002 REQ-006), not by these rules.

## Alternatives Considered

### Alternative A: Check the `Host` header against the configured address

**Description:** The network listener refuses a request whose `Host` header isn't its configured address or a name
listed in its settings. This closes DNS rebinding.
**Rejected because:** The product owner ruled against `Origin` and `Host` checks for S-003. A team reaching the listener
under several names or through a proxy would have to list every name.

### Alternative B: Check the `Origin` header

**Description:** Refuse a request whose `Origin` header names another site.
**Rejected because:** The product owner ruled against it. Without a `Host` check it doesn't close DNS rebinding, which
is the only browser attack the same-origin rules leave open.

### Alternative C: Accept any body type for operation calls

**Description:** Treat the request body as JSON whatever its declared content type.
**Rejected because:** A form or plain-text `POST` from another site's page needs no preflight, so every control
operation would be open to any site a team member visits.

### Alternative D: Authenticate browser sessions

**Description:** Issue a session token or cookie to the web interface and require it on every call.
**Rejected because:** It is a login in another form, which S-000 and ADR-002 exclude.
