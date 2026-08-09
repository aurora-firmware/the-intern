#!/usr/bin/env bash
# Test: "Deploying the email-triage scheduled job" section must document an
# explicit pi project-trust-establishment step for the deployed workspace,
# positioned after the workspace is deployed and before the scheduled job is
# registered with `bob schedule add`.
#
# B-035: pi's non-interactive `--mode rpc` workers (what
# `pi_agent_supervisor` always spawns) never show a trust prompt. Without a
# saved decision in `~/.pi/agent/trust.json`, a freshly deployed workspace's
# `.pi/skills/` content (email-triage, himalaya) is silently ignored on every
# scheduled tick, with no error surfaced anywhere. The deployment procedure
# must document the trust-establishment step so operators are not left to
# discover this undocumented manual workaround themselves.

set -euo pipefail

DOC="$(dirname "$0")/src/operator-guide/index.md"
SECTION_FILE="$(mktemp)"
trap 'rm -f "$SECTION_FILE"' EXIT

PASS=0
FAIL=0

# Isolate the "Deploying the email-triage scheduled job" section (everything
# up to the next top-level heading) into a real file, then grep that file
# directly. Grepping a file (rather than piping a variable through `echo`)
# avoids a SIGPIPE race: `grep -q` exits as soon as it finds a match, and an
# upstream `echo` still writing the rest of a large string into a pipe can
# be killed by SIGPIPE, which intermittently perturbs $? under `set -e` /
# `pipefail`.
awk '
  /^## Deploying the `email-triage` scheduled job/ { found=1 }
  found && /^## / && !/^## Deploying the `email-triage` scheduled job/ { exit }
  found { print }
' "$DOC" > "$SECTION_FILE"

if [ ! -s "$SECTION_FILE" ]; then
    echo "FAIL: could not locate the 'Deploying the email-triage scheduled job' section"
    exit 1
fi

check_present_in_section() {
    local desc="$1"
    local pattern="$2"
    if grep -qF "$pattern" "$SECTION_FILE"; then
        echo "PASS: $desc"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $desc"
        echo "      Expected pattern not found in section: $pattern"
        FAIL=$((FAIL + 1))
    fi
}

first_matching_line() {
    grep -nF "$1" "$SECTION_FILE" | head -1 | cut -d: -f1
}

echo "=== Deploying the email-triage scheduled job — project-trust step ==="
echo ""

check_present_in_section "pi project trust step documented" "project trust"
check_present_in_section "trust.json path referenced" "trust.json"
check_present_in_section "restart bob serve after editing trust.json documented" "Restart \`bob serve\`"

# The trust step must be positioned after workspace deployment and before
# the scheduled job is registered.
DEPLOY_LINE="$(first_matching_line "Deploy an owner-only workspace copy")"
TRUST_LINE="$(first_matching_line "trust.json")"
SCHEDULE_ADD_LINE="$(first_matching_line "bob schedule add")"

if [ -n "${DEPLOY_LINE:-}" ] && [ -n "${TRUST_LINE:-}" ] && [ "$TRUST_LINE" -gt "$DEPLOY_LINE" ]; then
    echo "PASS: trust step appears after the workspace-deployment step"
    PASS=$((PASS + 1))
else
    echo "FAIL: trust step must appear after the workspace-deployment step"
    FAIL=$((FAIL + 1))
fi

if [ -n "${SCHEDULE_ADD_LINE:-}" ] && [ -n "${TRUST_LINE:-}" ] && [ "$TRUST_LINE" -lt "$SCHEDULE_ADD_LINE" ]; then
    echo "PASS: trust step appears before bob schedule add"
    PASS=$((PASS + 1))
else
    echo "FAIL: trust step must appear before bob schedule add"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
