---
name: bob-troubleshooting
description: Diagnose a bob, pi, or bob.ts extension failure — an error message, unexpected behavior, a blocked tool call, a scheduled job that didn't fire, or a test failure involving Unix sockets. Use whenever something bob-related isn't working as expected, before guessing at a fix. Covers missing admin socket, duplicate extension connections, stale sockets, pi-agent version mismatches, and sandbox socket-permission failures.
---

# bob-troubleshooting

Symptom-indexed. Full table with exact messages and fixes is in
`references/symptom-table.md` — start there once you've matched a symptom.
This file covers the two most common false alarms and the general
diagnostic order.

## Diagnostic order

1. **Confirm the process topology first.** Is `bob serve` actually running
   right now (`ps aux | grep 'bob serve'` or check the terminal it was
   started in)? Most "bob is broken" reports are actually "bob was never
   started" or "bob was started with different socket paths than the
   client is using."
2. **Reproduce with `bob status --json`.** If this fails, you have a
   connectivity problem, not a logic problem — go to the socket-path
   section below before looking at policy/extension/scheduler code.
3. **If `bob status` works but something else is wrong, watch it live**
   with `bob audit tail` (see `bob-health-check`) while reproducing, rather
   than reading code and guessing.

## False alarm #1: "bob service is not running" / "missing admin socket"

Exact messages:
- `bob chat`: `"bob service is not running — cannot reach admin socket at <path>"`
- other subcommands: `"missing admin socket at <path>"`

Both come from the same root cause: `AdminClient::connect` got
`ServiceError::ServiceDown`. This does **not necessarily mean bob crashed**
— the much more common cause is that the client shell and the server
process resolved *different* `BOB_ADMIN_SOCK_PATH` values (e.g. server
started via `./scripts/run-bob-dev.sh`, client run in a fresh shell without
re-exporting the same env). Fix: confirm both shells agree on the socket
path — prefer `./scripts/bob-dev.sh <cmd>` for the client, since it
re-derives the exact same env the server script used, over hand-setting
`BOB_ADMIN_SOCK_PATH` in a second terminal.

## False alarm #2: extension "not working" is actually a duplicate connection

If pi's own `~/.pi/agent/settings.json` `packages` list still references an
old, manually-installed copy of `bob.ts` *in addition to* the one bob
resolves and passes via `--extension`, pi loads **two** extension
instances into one session. The stale one can't parse the current verdict
frame shape and fails closed — which looks exactly like "the policy engine
is denying everything" even when the current instance + policy allow it.

Detection: a `WARN` log line plus a `duplicate_extension_connection` audit
event — check with:
```bash
bob audit tail --filter events --json
```
Fix: remove any `bob.ts`-pointing entry from `~/.pi/agent/settings.json`'s
`packages` list. Bob never edits that file itself, so this has to be done
by hand.

## When to stop and escalate instead of continuing to debug

- `pi` is not on `PATH` at all — per project rule, stop and escalate; do
  not substitute a mock or alternate runner (see `bob-setup`).
- A Unix-domain-socket test fails with `Operation not permitted` inside a
  restrictive sandbox — this is an environment limitation, not a bug in
  bob. Re-run in a normal local dev shell before concluding there's a real
  regression.
