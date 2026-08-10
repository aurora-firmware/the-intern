#!/usr/bin/env bash
# Test suite for the pi packaging script (T-153)
# Each test function prints PASS or FAIL and exits 1 on first failure.
set -euo pipefail

PACKAGE_DIR="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="$PACKAGE_DIR/package-pi-skills.sh"

pass_count=0
fail_count=0

run_test() {
  local name="$1"
  local result="$2"
  if [ "$result" = "0" ]; then
    echo "PASS: $name"
    ((pass_count++)) || true
  else
    echo "FAIL: $name"
    ((fail_count++)) || true
  fi
}

# Work in an isolated copy of the canonical source so tests never mutate the
# repository's own tracked .pi/skills output.
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT
cp -r "$PACKAGE_DIR/skills" "$WORK_DIR/skills"
cp "$SCRIPT" "$WORK_DIR/package-pi-skills.sh"
chmod +x "$WORK_DIR/package-pi-skills.sh"

# AC-1: running the script produces SKILL.md and references/ for both skills
test_ac1_generates_expected_tree() {
  local ok=0
  ( cd "$WORK_DIR" && ./package-pi-skills.sh ) || ok=1
  [ -f "$WORK_DIR/.pi/skills/himalaya/SKILL.md" ] || ok=1
  [ -d "$WORK_DIR/.pi/skills/himalaya/references" ] || ok=1
  [ -f "$WORK_DIR/.pi/skills/email-triage/SKILL.md" ] || ok=1
  [ -d "$WORK_DIR/.pi/skills/email-triage/references" ] || ok=1
  run_test "AC-1: script generates SKILL.md and references/ for both skills" "$ok"
}

test_ac1_generates_expected_tree

echo ""
echo "Results: $pass_count passed, $fail_count failed"
[ "$fail_count" -eq 0 ] || exit 1
