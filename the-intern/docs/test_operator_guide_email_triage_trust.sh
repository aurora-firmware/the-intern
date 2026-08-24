#!/usr/bin/env bash
# Test: "Deploying the email-triage scheduled job" section must document that
# no pi project-trust step is required for the job's deployed working
# directory under the skill install-path deployment model, and must explain
# why (T-161 / S-011).
#
# B-035 (resolved) found that pi's non-interactive `--mode rpc` workers
# silently ignore a deployed workspace's `.pi/skills/` tree without a saved
# `~/.pi/agent/trust.json` decision, and the original fix added an explicit
# trust-establishment step to this section. T-150 later confirmed that the
# extension-contributed `resources_discover` skill path bob now supplies
# instead (T-159/T-160) reaches the system prompt from an untrusted working
# directory on every spawn path bob uses, including the scheduled-periodic
# one this job runs on. Combined with T-161 removing the per-job
# `.pi/skills/` copy entirely, the deployed workspace no longer carries any
# project-local resource pi's project-trust gate covers, so the old trust
# step is gone, replaced by an explanation of why it is no longer needed.
# This test guards against that explanation silently disappearing, or the
# old trust.json-editing step being silently reintroduced without updating
# it.

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

check_absent_from_section() {
    local desc="$1"
    local pattern="$2"
    if grep -qF "$pattern" "$SECTION_FILE"; then
        echo "FAIL: $desc"
        echo "      Pattern unexpectedly found in section: $pattern"
        FAIL=$((FAIL + 1))
    else
        echo "PASS: $desc"
        PASS=$((PASS + 1))
    fi
}

first_matching_line() {
    grep -nF "$1" "$SECTION_FILE" | head -1 | cut -d: -f1
}

echo "=== Deploying the email-triage scheduled job — skill install-path model ==="
echo ""

check_present_in_section "explains no pi project-trust step is required" \
    "No pi project-trust step is required for this workspace"
check_present_in_section "cites B-035 for the historical trust-step context" \
    "B-035"
check_present_in_section "cites T-150's untrusted-cwd resources_discover confirmation" \
    "T-150"
check_present_in_section "explains skills reach the session via resources_discover" \
    "resources_discover"
check_absent_from_section "no longer instructs editing ~/.pi/agent/trust.json as an active step" \
    "Add the deployed workspace's canonical absolute path to"
check_absent_from_section "no longer instructs restarting bob serve for trust decisions" \
    "Restart \`bob serve\` afterward"
check_absent_from_section "no longer copies the whole package into the per-job workspace" \
    "cp -r the-intern/bob-skills/."

# The no-trust-step explanation must sit where the removed trust step used
# to live: after the workspace is deployed and before the S-004 action rules
# are added.
DEPLOY_LINE="$(first_matching_line "Bootstrap the owner-only workspace")"
NO_TRUST_LINE="$(first_matching_line "No pi project-trust step is required")"
ACTION_RULES_LINE="$(first_matching_line "Replace the bootstrap-wide action rules")"

if [ -n "${DEPLOY_LINE:-}" ] && [ -n "${NO_TRUST_LINE:-}" ] && [ "$NO_TRUST_LINE" -gt "$DEPLOY_LINE" ]; then
    echo "PASS: the no-trust-step explanation appears after the workspace-deployment step"
    PASS=$((PASS + 1))
else
    echo "FAIL: the no-trust-step explanation must appear after the workspace-deployment step"
    FAIL=$((FAIL + 1))
fi

if [ -n "${ACTION_RULES_LINE:-}" ] && [ -n "${NO_TRUST_LINE:-}" ] && [ "$NO_TRUST_LINE" -lt "$ACTION_RULES_LINE" ]; then
    echo "PASS: the no-trust-step explanation appears before the S-004 action-rules step"
    PASS=$((PASS + 1))
else
    echo "FAIL: the no-trust-step explanation must appear before the S-004 action-rules step"
    FAIL=$((FAIL + 1))
fi

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
