#!/usr/bin/env bash
# Test: Wire contract section must document the chat.message notification shape.
# AC-1: docs state the chat.send params contract AND the chat.message
#       notification shape exactly as defined in S-008's wire contract.
#
# S-008 wire contract (lines 119–121):
#   Reply notifications use method chat.message with params subscription
#   (the subscription id) and data (the reply payload). data contains at
#   least a text string when the reply is human-readable text.

set -euo pipefail

DOC="$(dirname "$0")/src/end-user-guide/index.md"
PASS=0
FAIL=0

check_present() {
    local desc="$1"
    local pattern="$2"
    if grep -qF "$pattern" "$DOC"; then
        echo "PASS: $desc"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $desc"
        echo "      Expected pattern not found: $pattern"
        FAIL=$((FAIL + 1))
    fi
}

check_absent() {
    local desc="$1"
    local pattern="$2"
    if ! grep -qF "$pattern" "$DOC"; then
        echo "PASS: $desc"
        PASS=$((PASS + 1))
    else
        echo "FAIL: $desc"
        echo "      Pattern should be absent: $pattern"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== Wire contract section — chat.message notification shape ==="
echo ""

# The Wire contract section must document the chat.message method name
check_present "Wire contract section: chat.message method documented" "chat.message"

# The Wire contract section must document params.subscription
check_present "Wire contract section: params.subscription documented" "subscription"

# The Wire contract section must document params.data
check_present "Wire contract section: params.data documented" "params.data"

# The Wire contract section must document data.text (human-readable reply)
check_present "Wire contract section: data.text documented" "data.text"

# The notification shape table/prose must appear in the Wire contract section,
# i.e., AFTER the chat.send table. We verify by checking that params.subscription
# and params.data appear after the chat.send table header row.
# The chat.send table ends before the Phase 2 limitation note.
# We check that the words "subscription" and "params.data" occur in the Wire
# contract section (between "Wire contract" heading and end of file).
WIRE_SECTION=$(awk '/^\*\*Wire contract\*\*/{found=1} found{print}' "$DOC")

if echo "$WIRE_SECTION" | grep -qF "subscription"; then
    echo "PASS: subscription documented inside Wire contract section"
    PASS=$((PASS + 1))
else
    echo "FAIL: subscription not found inside Wire contract section"
    FAIL=$((FAIL + 1))
fi

if echo "$WIRE_SECTION" | grep -qF "params.data"; then
    echo "PASS: params.data documented inside Wire contract section"
    PASS=$((PASS + 1))
else
    echo "FAIL: params.data not found inside Wire contract section"
    FAIL=$((FAIL + 1))
fi

if echo "$WIRE_SECTION" | grep -qF "data.text"; then
    echo "PASS: data.text documented inside Wire contract section"
    PASS=$((PASS + 1))
else
    echo "FAIL: data.text not found inside Wire contract section"
    FAIL=$((FAIL + 1))
fi

# The cross-reference from --json section must point to real content:
# the cross-reference sentence itself must exist
check_present "--json cross-reference sentence present" "documented in the Wire contract section below"

echo ""
echo "Results: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
