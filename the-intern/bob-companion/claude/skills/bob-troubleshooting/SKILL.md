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

This fires whenever *any* second, still-live connection registers the same
session id as an existing one — bob's extension-ipc layer does not inspect
`~/.pi/agent/settings.json` at all when deciding this. The most common way
to hit it: pi's own `packages` list still references an old,
manually-installed copy of `bob.ts` *in addition to* the one bob resolves
and passes via `--extension`, so pi loads **two** extension instances into
one session. The stale one can't parse the current verdict frame shape and
fails closed — which looks exactly like "the policy engine is denying
everything" even when the current instance + policy allow it. If the
`packages` list is already clean, look instead for another still-live
connection holding the same session — for example, an earlier `pi` process
or extension-socket connection that never exited.

Detection: a `WARN` log line plus a `duplicate_extension_connection` audit
event — check with:
```bash
bob audit tail --filter events --json
```
Fix: remove any `bob.ts`-pointing entry from `~/.pi/agent/settings.json`'s
`packages` list, if present. Bob never edits that file itself, so this has
to be done by hand. If the list is already clean, first confirm which `pi`
process is the stale one — bob's own logs only carry an internal
`connection_id`, not an OS process id, so check for more than one running
`pi` instance yourself (e.g. `ps aux | grep pi`) and rule out the one you're
actively using — before terminating the other one.

## `pi_agent_model` symptoms

Four distinct symptoms trace back to `pi_agent_model` — don't conflate them.
Exact-message rows are in `references/symptom-table.md`; here's how to tell
them apart quickly:

1. **Startup warning that `pi_agent_model` is not set.** Logged once when
   `bob serve` starts. This is not an error — pi still starts, it just picks
   its own model from its own saved settings, which can change or fall back
   without notice. Fix: set `pi_agent_model` in `config.toml` (see
   `bob-setup`) and restart `bob serve`.
2. **A `Model "<value>" not found` line in the service log.** This is pi's
   own spawn-time rejection of a `pi_agent_model` value it doesn't
   recognize, forwarded from the failing pool worker's stderr — bob runs no
   check of the value itself before starting the process. Fix: confirm the
   intended value with `pi --list-models <search>` (looking for the exact
   `<provider>/<model-id>` form) before setting `pi_agent_model` again, then
   restart `bob serve`.
3. **A scheduled job fired but appears to have done nothing.** If the fire
   landed on a worker already broken by an invalid `pi_agent_model`, no
   audit record of any kind is written for it — not a `verdict`, not an
   `event`, not a `report`. `bob audit tail` (with or without `--filter`)
   shows nothing for that fire. Check the service log for the symptom-2 line
   before assuming `bob audit tail` would have shown a failure.
4. **A config-load error naming a model flag inside `pi_agent_args`.**
   `bob serve` refuses to start when `pi_agent_args` contains `--model`,
   `--models`, or `--provider` — the model is settable in exactly one place.
   Fix: move the value to `pi_agent_model` and remove the flag — and its
   value, if it was a separate argument — from `pi_agent_args`.

`pi --list-models <search>` and `pi auth check --provider <p> --json` are
useful checks before trusting a `pi_agent_model` value, but neither is
conclusive proof it works, and both reflect observed pi behavior rather than
a documented guarantee: `--list-models` fuzzy-matches and exits `0` even
when nothing matches the search term, and `auth check` validates provider
credentials only — an unknown model under an otherwise correctly-configured
provider still reports `ready`, so the model must be passed as `provider/id`
with `--provider` set. The only fully reliable check remains starting a
session and watching for pi's own refusal, described in symptom 2 above.

## When to stop and escalate instead of continuing to debug

- `pi` is not on `PATH` at all — per project rule, stop and escalate; do
  not substitute a mock or alternate runner (see `bob-setup`).
- A Unix-domain-socket test fails with `Operation not permitted` inside a
  restrictive sandbox — this is an environment limitation, not a bug in
  bob. Re-run in a normal local dev shell before concluding there's a real
  regression.
