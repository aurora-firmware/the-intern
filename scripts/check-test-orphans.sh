#!/usr/bin/env bash
# Warn about orphaned test-fixture processes left behind by `cargo test`.
#
# Some supervisor/admin-rpc test fixtures are `sh -c '... while :; do ...; done'`
# stand-ins for pi workers. If a test run leaks one, it is reparented to PID 1
# (or the `systemd --user` manager) and spins forever, which adds load and heat.
#
# Usage: scripts/check-test-orphans.sh [--kill]
#   --kill   send SIGTERM to the orphans found
# Always exits 0; this is a warning, not a gate.

set -uo pipefail

kill_orphans=0
[[ "${1:-}" == "--kill" ]] && kill_orphans=1

me="$(id -u)"
declare -A reaper_pids=([1]=1)
while read -r pid; do reaper_pids[$pid]=1; done < <(pgrep -u "$me" -x systemd 2>/dev/null)

orphans=()
while read -r pid ppid args; do
  [[ -n "${reaper_pids[$ppid]:-}" ]] || continue
  [[ "$args" == *"while :; do"* ]] || continue
  orphans+=("$pid")
  printf '  pid %s (ppid %s): %.110s\n' "$pid" "$ppid" "$args"
done < <(ps -u "$me" -o pid=,ppid=,args= | grep -E '^ *[0-9]+ +[0-9]+ +(/bin/)?sh -c' )

if ((${#orphans[@]} == 0)); then
  echo "check-test-orphans: no orphaned test fixtures found"
  exit 0
fi

echo "WARNING: ${#orphans[@]} orphaned test-fixture process(es) found (listed above)." >&2
if ((kill_orphans)); then
  kill -TERM "${orphans[@]}" 2>/dev/null
  echo "Sent SIGTERM to ${#orphans[@]} process(es)." >&2
else
  echo "Re-run with --kill to terminate them, and investigate which test leaked them." >&2
fi
exit 0
