---
id: ADR-010
title: Accounts share one sign-in layer and one owner-only secrets store
status: accepted
created: '2026-11-19'
---

# ADR-010: Accounts share one sign-in layer and one owner-only secrets store

## Context

S-009 makes The Intern keep the passwords and client secrets a team member gives it, and the OAuth tokens it obtains,
for the accounts it connects to (S-009 REQ-002, REQ-004, REQ-020; S-002 REQ-018). Mail accounts are the only such
accounts today. The product owner asked on 2026-11-19 that sign-in, token refresh, the secrets store and account
status stay apart from the mail code, so that a later spec, such as one for calendars and contacts over Microsoft
Graph, reuses them beside its own protocols. Secrets must never reach the database, the export, logs, the feed or a
model (S-009 REQ-020), and a refreshed token must be on disk before it is used, so a crash never loses the newest one.

## Decision

One accounts layer, `src/accounts/`, owns every account's secrets, sign-in, token refresh and status. It knows no
protocol: the code of each kind of account (today `src/mail/`) owns its configuration, operations and protocol, and
asks the layer for a credential each time it logs in.

1. **The boundary.** The layer imports no mail library and no pi package. A consumer passes it an account's key, its
   `auth` settings (kind, login, client ID, tenant, password command) and the scopes its protocols need, and gets back
   `{ user, password }` or `{ user, accessToken }`. The mail code passes IMAP and SMTP scopes; a later consumer passes
   its own. The layer is part of S-000's Email component until another spec uses it.
2. **The secrets store.** One owner-only folder, `<state dir>/secrets/`, created `0700` with the other instance
   directories (S-002 REQ-006). Each account has one JSON file, `<owner>/<name>.json` (today `mail/<name>.json`), mode
   `0600`, holding its password or client secret and its tokens with their expiry. Every write runs in one in-process
   serial queue and replaces the file through a temporary file, `fsync` and a rename. Nothing but the layer reads or
   writes the folder, and nothing it holds is returned, logged or published. The files are not encrypted.
3. **Sign-in over plain HTTP.** OAuth uses Node's `fetch` against the providers' documented endpoints: the device code
   flow for `microsoft`, the loopback flow with PKCE (Proof Key for Code Exchange) and the client secret for `google`,
   and the client credentials flow for `microsoft_app` (S-009 REQ-004). Before a login, the layer refreshes an access
   token that expires within 5 minutes, one refresh at a time per account, and writes the new tokens to the store
   before it returns them. A refused refresh turns the account `needs_sign_in`.
4. **Status and retries.** The layer keeps each account's status, last error, its time and the last check in memory,
   and publishes each change. An account is `connecting` until a consumer reports its first connection's outcome
   after a start, an add or a change (S-009 REQ-005). A consumer reports each connection's outcome to it. A `failing`
   account is tried again
   after its check interval, then at doubling pauses of at most 30 minutes; a `needs_sign_in` one waits for a sign-in
   or a new secret (S-009 REQ-005). Each account has its own timer, so one account never delays another. The clock is
   injectable for tests.
5. **Removal.** Removing an account removes its file. At startup step 8, before any account starts, the layer removes
   the file of every account the configuration file no longer holds (S-002 REQ-002).

## Consequences

- A later kind of account adds its scopes and its protocol code, and reuses sign-in, refresh, status and the store
  without a new ADR. A second store, or a secret anywhere else, amends this decision first.
- The store is the instance's one credential store. Whoever can read the service account's files can read it, as they
  can every credential the service account acts with (ADR-002 decision 4).
- An export and a copy of the database carry no secret, so accounts are signed in again after an import (S-009
  REQ-024).
- Status lives in memory. After a start, an add or a change, an account is `connecting` until its first check ends,
  except one whose `auth` needs a secret the store lacks, which is `needs_sign_in` (S-009 REQ-002, REQ-005).
- Provider endpoints are a test-only switch, so the fake OAuth provider stands in for Google and Microsoft.

## Alternatives Considered

- **The secrets in the database:** rejected because the export carries the database (S-009 REQ-020, REQ-024).
- **The store in the configuration directory:** rejected because team members edit that folder and may keep it in
  version control; the state directory holds only what the daemon writes.
- **Encrypting the files:** rejected because the key would sit beside them under the same account, so it can't
  reject anyone a `0600` file doesn't (`docs/development/coding_guidelines.md`, Security).
- **The operating system's keyring:** rejected by S-009, Alternatives Considered: the macOS login keychain is locked
  when the service starts at boot with nobody logged in.
- **`@azure/msal-node` and `google-auth-library`:** rejected because each keeps its own token cache, which would be a
  second store, and they add many dependencies for three HTTP flows that each take a few requests.
- **Sign-in inside the mail code:** rejected by the product owner's direction of 2026-11-19, because a later kind of
  account would have to take it apart.
