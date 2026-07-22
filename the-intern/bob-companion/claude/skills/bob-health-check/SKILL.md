---
name: bob-health-check
description: Check whether bob is running and healthy, interpret `bob status`, or live-diagnose behavior with `bob audit tail`. Use whenever the user asks "is bob running", "is bob healthy", wants a health check before doing something else, or needs to watch what bob is doing in real time (verdicts, denied tool calls, dropped events).
---

# bob-health-check

## The only health check that exists: `service.status`

There is no dedicated ping/health-only endpoint separate from `bob status`.
`bob status --json` calls the admin-RPC method `service.status`, which is
**unconditionally available** — it doesn't require any subsystem handle
(supervisor, policy, monitoring) to be wired up, unlike `sessions.*`,
`policy.reload`, etc. So `bob status` succeeding tells you the process is
up and the admin-RPC dispatcher is alive; it does **not** by itself tell
you the pi-agent supervisor, policy engine, or scheduler are functioning —
those need their own checks (below).

```bash
bob status --json
# {"ok":true,"version":"0.x.y","uptime_seconds":1234}
```

Caveats when interpreting the result:
- `uptime_seconds` is measured from when the admin-RPC dispatcher object
  was constructed during `bob serve` startup, not from OS process start.
  Treat it as "how long has the admin socket been answering," not exact
  process age.
- `version` is the crate's `CARGO_PKG_VERSION` baked in at build time.

## A health check procedure, in order

1. **Is the socket even reachable?**
   ```bash
   bob status --json
   ```
   - Success (`{"ok":true,...}`) → service is up, proceed to step 2.
   - `missing admin socket at <path>` → either `bob serve` isn't running,
     or your shell's `BOB_ADMIN_SOCK_PATH` doesn't match the server's. See
     `bob-troubleshooting` before concluding the service is actually down.

2. **Is anything actually flowing?**
   ```bash
   bob sessions list --json
   ```
   An empty list is not itself a problem (no active work), but if you
   expect sessions and see none, or `sessions.*` returns
   `-32601 Method not found`, the supervisor handle isn't wired up —
   that's a serve-time configuration problem, not a transient blip.

3. **Watch live behavior instead of guessing:**
   ```bash
   bob audit tail --filter verdicts --json
   ```
   Run this *while* reproducing whatever the user is worried about (a tool
   call getting denied, a scheduled job not firing, an extension
   connection issue). It's the fastest way to turn "bob seems broken" into
   a concrete event to act on. Use `--filter events` for pi-agent-supervisor
   lifecycle/extension events, `--filter reports` for `report.submit`
   intake, or omit `--filter` entirely to see everything. Ctrl-C to stop
   (the client cleanly unsubscribes).

## Security note worth knowing when reasoning about "is this safe to check"

The admin socket has **no per-RPC authentication** — the only gate is Unix
filesystem permissions. `bob serve` creates the socket's parent directory
`0700` and the socket file itself `0660`. Peer credentials are read
(`SO_PEERCRED`/`getpeereid`) purely for audit logging, not for
authorization. In practice this means: if you (Claude, via Bash) can reach
the socket path at all, you can call *any* admin-RPC method including
`service.status` — there's no separate "read-only" health-check identity.
This is fine for local dev/ops use but is not a boundary to rely on for
anything sensitive.
